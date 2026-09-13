import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "@secretlint/node";
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

export interface SecretScanResult {
	ok: boolean;
	output: string;
}

export interface SecretScanner {
	scan(content: string, filePath: string, signal?: AbortSignal): Promise<SecretScanResult>;
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
	let engine: Awaited<ReturnType<typeof createEngine>>;
	try {
		engine = await createEngine({
			cwd: PACKAGE_ROOT,
			color: false,
			formatter: "json",
			terminalLink: false,
			maskSecrets: true,
			configFileJSON: {
				rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }],
			},
		});
	} catch {
		throw new SecretScannerFailure("configuration", "Secret scanner configuration failed.");
	}
	return Object.freeze({
		async scan(content: string, filePath: string, signal?: AbortSignal): Promise<SecretScanResult> {
			signal?.throwIfAborted();
			try {
				const result = await engine.executeOnContent({ content, filePath });
				signal?.throwIfAborted();
				return result;
			} catch {
				throw new SecretScannerFailure("read", "Secret scanner could not scan an input.");
			}
		},
	});
}

function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	phase: SecretScannerFailure["phase"],
): Promise<T> {
	return new Promise((accept, reject) => {
		let complete = false;
		const finish = (callback: () => void) => {
			if (complete) return;
			complete = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => finish(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));
		const timeout = setTimeout(
			() => finish(() => reject(new SecretScannerFailure("timeout", `Secret scanner ${phase} timed out.`))),
			timeoutMs,
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		operation.then(
			(value) => finish(() => accept(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

function lineFromMessage(message: Record<string, unknown>): number | undefined {
	if (typeof message.line === "number") return message.line;
	const location = message.loc;
	if (!location || typeof location !== "object") return undefined;
	const start = (location as { start?: unknown }).start;
	if (!start || typeof start !== "object") return undefined;
	const line = (start as { line?: unknown }).line;
	return typeof line === "number" ? line : undefined;
}

function parseScannerOutput(output: string, path: string): readonly Readonly<SecretFinding>[] {
	let records: unknown;
	try {
		records = JSON.parse(output);
	} catch {
		throw new SecretScannerFailure("parse", "Secret scanner output was invalid.");
	}
	if (!Array.isArray(records)) throw new SecretScannerFailure("parse", "Secret scanner output was invalid.");
	const findings: Readonly<SecretFinding>[] = [];
	for (const record of records) {
		if (!record || typeof record !== "object") {
			throw new SecretScannerFailure("parse", "Secret scanner output was invalid.");
		}
		const messages = (record as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) throw new SecretScannerFailure("parse", "Secret scanner output was invalid.");
		for (const message of messages) {
			if (!message || typeof message !== "object") {
				throw new SecretScannerFailure("parse", "Secret scanner output was invalid.");
			}
			const value = message as Record<string, unknown>;
			const type = typeof value.ruleId === "string" ? value.ruleId : value.messageId;
			const line = lineFromMessage(value);
			if (typeof type !== "string" || !Number.isSafeInteger(line) || (line ?? 0) < 1) {
				throw new SecretScannerFailure("parse", "Secret scanner output was invalid.");
			}
			findings.push(Object.freeze({ type, path, line: line as number }));
		}
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
	let result: SecretScanResult;
	try {
		result = await withTimeout(
			options.scanner.scan(options.content, options.path, options.signal),
			options.timeoutMs,
			options.signal,
			"read",
		);
	} catch (error) {
		if (error instanceof SecretScannerFailure || (error instanceof Error && error.name === "AbortError")) throw error;
		throw new SecretScannerFailure("read", "Secret scanner could not scan an input.");
	}
	const findings = parseScannerOutput(result.output, options.path);
	if (!result.ok && findings.length === 0) {
		throw new SecretScannerFailure("parse", "Secret scanner reported failure without valid findings.");
	}
	return findings;
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
			if (path === "settings.json") parseSettings(text, { source: "shared", policy: options.policy });
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
		scanner = await withTimeout(factory(options.signal), timeoutMs, options.signal, "startup");
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
