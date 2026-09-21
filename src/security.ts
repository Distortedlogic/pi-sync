import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackagesFromConfigDescriptor } from "@secretlint/config-loader";
import { lintSource } from "@secretlint/core";
import { parseTree } from "jsonc-parser";
import { isPermanentlyDenied } from "./config.ts";
import { discoverFileInventory, type InventoryFile, type InventoryLimits, resolveManagedPath } from "./files.ts";
import { parseSettings, validateMachineOnlyPreservation } from "./settings.ts";
import type { FileFingerprint, LocalPolicy } from "./types.ts";

export interface SecretFinding {
	type: string;
	path: string;
	line: number;
}

export interface SecretScanner {
	scan(content: string, filePath: string, signal?: AbortSignal): Promise<readonly unknown[]>;
}

export type SecretScannerFactory = (signal?: AbortSignal) => Promise<SecretScanner>;

export interface CandidateSecurityOptions {
	policy: LocalPolicy;
	managedPatterns: readonly string[];
	machineSettings?: { currentText: string; finalText: string };
	limits?: Partial<InventoryLimits>;
	scannerFactory?: SecretScannerFactory;
	scannerTimeoutMs?: number;
}

export interface StagedCandidateValidationInput extends CandidateSecurityOptions {
	stagedRoot: string;
	stagedPaths: readonly string[];
	plannedFinalSharedTree: Readonly<Record<string, Readonly<InventoryFile | FileFingerprint>>>;
	candidateDiff: string;
	signal?: AbortSignal;
}

export class CandidateValidationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CandidateValidationError";
	}
}

export class SecretScannerFailure extends CandidateValidationError {
	readonly phase: "startup" | "configuration" | "read" | "timeout" | "parse";

	constructor(phase: SecretScannerFailure["phase"], message: string) {
		super(message);
		this.name = "SecretScannerFailure";
		this.phase = phase;
	}
}

export class SecretFindingError extends CandidateValidationError {
	readonly findings: readonly Readonly<SecretFinding>[];

	constructor(findings: readonly Readonly<SecretFinding>[]) {
		super("Secret findings block PUBLISH to SHARED REPOSITORY.");
		this.name = "SecretFindingError";
		this.findings = Object.freeze(findings.map((finding) => Object.freeze({ ...finding })));
	}
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCANNER_TIMEOUT_MS = 15_000;
const CONFLICT_MARKER = /^(?:<<<<<<<(?: .*)?|=======|>>>>>>>(?: .*)?)\r?$/m;

export async function createRecommendedSecretScanner(): Promise<SecretScanner> {
	let config: Awaited<ReturnType<typeof loadPackagesFromConfigDescriptor>>["config"];
	try {
		const loaded = await loadPackagesFromConfigDescriptor({
			configDescriptor: {
				rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }],
			},
			node_moduleDir: resolve(PACKAGE_ROOT, "node_modules"),
		});
		config = loaded.config;
	} catch {
		throw new SecretScannerFailure("configuration", "Secret scanner configuration failed.");
	}
	return Object.freeze({
		async scan(content: string, filePath: string, signal?: AbortSignal): Promise<readonly unknown[]> {
			signal?.throwIfAborted();
			try {
				const result = await lintSource({
					source: { filePath, content, ext: extname(filePath), contentType: "text" },
					options: { config, maskSecrets: true },
				});
				signal?.throwIfAborted();
				return result.messages;
			} catch {
				if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
				throw new SecretScannerFailure("read", "Secret scanner could not scan an input.");
			}
		},
	});
}

async function withTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	phase: SecretScannerFailure["phase"],
): Promise<T> {
	const linked = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<never>((_accept, reject) => {
		timer = setTimeout(
			() => reject(new SecretScannerFailure("timeout", `Secret scanner ${phase} timed out.`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([operation(linked), timedOut]);
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
		if (error instanceof SecretScannerFailure) throw error;
		if (linked.aborted) throw new SecretScannerFailure("timeout", `Secret scanner ${phase} timed out.`);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function scanFindings(messages: readonly unknown[], path: string): readonly Readonly<SecretFinding>[] {
	if (!Array.isArray(messages)) throw new SecretScannerFailure("parse", "Secret scanner output was invalid.");
	const findings: Readonly<SecretFinding>[] = [];
	for (const message of messages) {
		const value = message as { ruleId?: unknown; messageId?: unknown; loc?: unknown } | null;
		const type = typeof value?.ruleId === "string" ? value.ruleId : value?.messageId;
		const line = (value?.loc as { start?: { line?: unknown } } | undefined)?.start?.line;
		if (typeof type !== "string" || !Number.isSafeInteger(line) || (line as number) < 1) {
			throw new SecretScannerFailure("parse", "Secret scanner output was invalid.");
		}
		findings.push(Object.freeze({ type, path, line: line as number }));
	}
	return Object.freeze(findings);
}

function decodeText(bytes: Buffer): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function validateJson(path: string, text: string): void {
	const errors: Array<{ error: number; offset: number; length: number }> = [];
	const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
	if (!tree || errors.length > 0) throw new CandidateValidationError(`Managed JSON is invalid: ${path}`);
}

function validateTree(
	actual: Readonly<Record<string, Readonly<InventoryFile>>>,
	expected: Readonly<Record<string, Readonly<InventoryFile | FileFingerprint>>>,
): void {
	const paths = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
	for (const path of paths) {
		const actualFile = actual[path];
		const expectedFile = expected[path];
		if (
			!actualFile ||
			!expectedFile ||
			actualFile.sha256 !== expectedFile.sha256 ||
			actualFile.comparisonSha256 !== expectedFile.comparisonSha256 ||
			actualFile.executable !== expectedFile.executable
		) {
			throw new CandidateValidationError(`Staged tree does not match the immutable plan: ${path}`);
		}
	}
}

async function scanInput(options: {
	scanner: SecretScanner;
	content: string;
	path: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<readonly Readonly<SecretFinding>[]> {
	let messages: readonly unknown[];
	try {
		messages = await withTimeout(
			(linked) => options.scanner.scan(options.content, options.path, linked),
			options.timeoutMs,
			options.signal,
			"read",
		);
	} catch (error) {
		if (error instanceof SecretScannerFailure || (error instanceof Error && error.name === "AbortError")) throw error;
		throw new SecretScannerFailure("read", "Secret scanner could not scan an input.");
	}
	return scanFindings(messages, options.path);
}

export async function validateStagedCandidate(
	options: StagedCandidateValidationInput,
): Promise<{ findings: readonly Readonly<SecretFinding>[] }> {
	options.signal?.throwIfAborted();
	for (const path of options.stagedPaths) {
		const managedPath = resolveManagedPath(options.stagedRoot, path).relativePath;
		if (isPermanentlyDenied(managedPath)) {
			throw new CandidateValidationError(`Permanently denied path is present in the staged tree: ${managedPath}`);
		}
	}
	const inventory = await discoverFileInventory(options.stagedRoot, "shared", {
		managedPatterns: options.managedPatterns,
		limits: options.limits,
		signal: options.signal,
	});
	validateTree(inventory.files, options.plannedFinalSharedTree);

	const scanInputs: Array<{ path: string; content: string }> = [];
	for (const [path, file] of Object.entries(inventory.files)) {
		options.signal?.throwIfAborted();
		if (file.exactBytesBase64 === undefined) {
			throw new SecretScannerFailure("read", `Managed file content is unavailable: ${path}`);
		}
		const bytes = Buffer.from(file.exactBytesBase64, "base64");
		const text = decodeText(bytes);
		if (text && CONFLICT_MARKER.test(text)) {
			throw new CandidateValidationError(`Git conflict marker is present in a managed text file: ${path}`);
		}
		if (path.endsWith(".json")) {
			if (text === undefined) throw new CandidateValidationError(`Managed JSON is not UTF-8 text: ${path}`);
			validateJson(path, text);
			if (path === "agent/settings.json") parseSettings(text, { source: "shared", policy: options.policy });
		}
		scanInputs.push({ path, content: text ?? bytes.toString("utf8") });
	}
	if (options.machineSettings) {
		validateMachineOnlyPreservation({
			currentMachineText: options.machineSettings.currentText,
			finalMachineText: options.machineSettings.finalText,
			policy: options.policy,
		});
	} else if (options.policy.machineOnlySettings.length > 0 || options.policy.machineOnlyPackageSources.length > 0) {
		throw new CandidateValidationError("Machine-only policy preservation was not validated.");
	}

	const timeoutMs = options.scannerTimeoutMs ?? DEFAULT_SCANNER_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
		throw new SecretScannerFailure("configuration", "Secret scanner timeout is invalid.");
	const factory = options.scannerFactory ?? createRecommendedSecretScanner;
	let scanner: SecretScanner;
	try {
		scanner = await withTimeout((linked) => factory(linked), timeoutMs, options.signal, "startup");
	} catch (error) {
		if (error instanceof SecretScannerFailure || (error instanceof Error && error.name === "AbortError")) throw error;
		throw new SecretScannerFailure("startup", "Secret scanner startup failed.");
	}

	const findings: Readonly<SecretFinding>[] = [];
	for (const input of [...scanInputs, { path: "candidate.diff", content: options.candidateDiff }]) {
		findings.push(
			...(await scanInput({
				scanner,
				content: input.content,
				path: input.path,
				timeoutMs,
				signal: options.signal,
			})),
		);
	}
	if (findings.length > 0) throw new SecretFindingError(findings);
	return { findings: Object.freeze([]) };
}
