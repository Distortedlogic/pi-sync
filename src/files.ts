import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep, win32 } from "node:path";
import stableStringify from "json-stable-stringify";
import { minimatch } from "minimatch";
import { DEFAULT_MANAGED_SCOPE, isPermanentlyDenied } from "./config.ts";
import type { Baseline } from "./types.ts";

export interface InventoryLimits {
	maxFileBytes: number;
	maxTotalBytes: number;
}

export interface ResolvedInventoryRoots {
	machine: string;
	shared: string;
}

export interface InventoryFile {
	path: string;
	size?: number;
	sha256: string;
	comparisonSha256: string;
	executable: boolean;
	exactBytesBase64?: string;
}

export interface FileInventory {
	source: "machine" | "shared" | "baseline";
	root?: string;
	files: Readonly<Record<string, Readonly<InventoryFile>>>;
	totalBytes: number;
}

export interface InventorySet {
	roots: Readonly<ResolvedInventoryRoots>;
	machine: Readonly<FileInventory>;
	shared: Readonly<FileInventory>;
	baseline: Readonly<FileInventory>;
}

export interface DiscoverInventoryOptions {
	managedPatterns?: readonly string[];
	limits?: Partial<InventoryLimits>;
	signal?: AbortSignal;
}

export const DEFAULT_INVENTORY_LIMITS = Object.freeze({
	maxFileBytes: 10 * 1024 * 1024,
	maxTotalBytes: 50 * 1024 * 1024,
});

const MATCH_OPTIONS = {
	dot: true,
	matchBase: false,
	nocase: false,
	nonegate: true,
	windowsPathsNoEscape: true,
} as const;

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const GLOB_CHARACTER = /[*?[\]{}()!+@]/;

interface ManagedPath {
	relativePath: string;
	absolutePath: string;
}

interface CandidateFile extends ManagedPath {
	size: number;
}

interface InventoryScan {
	root: string;
	files: CandidateFile[];
}

export class InventoryError extends Error {
	readonly managedPath?: string;

	constructor(message: string, managedPath?: string, options?: ErrorOptions) {
		super(managedPath ? `${message}: ${managedPath}` : message, options);
		this.name = "InventoryError";
		this.managedPath = managedPath;
	}
}

function abortIfRequested(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

function normalizeRelativePath(input: string): string {
	if (input.includes("\0")) throw new InventoryError("Managed path contains a NUL character", input);
	if (isAbsolute(input) || win32.isAbsolute(input)) throw new InventoryError("Managed path must be relative", input);
	const segments = input
		.replaceAll("\\", "/")
		.normalize("NFC")
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
	if (segments.length === 0) throw new InventoryError("Managed path is empty", input);
	for (const segment of segments) {
		if (segment === "..") throw new InventoryError("Managed path cannot contain '..'", input);
		if (segment.endsWith(".") || segment.endsWith(" ")) {
			throw new InventoryError("Managed path is not portable to Windows", input);
		}
		if (/[<>:"|?*]/.test(segment)) throw new InventoryError("Managed path is not portable to Windows", input);
		const deviceName = segment.split(".", 1)[0];
		if (WINDOWS_RESERVED_NAME.test(deviceName))
			throw new InventoryError("Managed path uses a Windows reserved name", input);
	}
	return segments.join("/");
}

function normalizePattern(input: string): string {
	if (input.includes("\0")) throw new InventoryError("Managed scope contains a NUL character", input);
	if (isAbsolute(input) || win32.isAbsolute(input)) throw new InventoryError("Managed scope must be relative", input);
	const segments = input
		.replaceAll("\\", "/")
		.normalize("NFC")
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
	if (segments.length === 0 || segments.includes("..")) throw new InventoryError("Managed scope is invalid", input);
	return segments.join("/");
}

export function resolveManagedPath(root: string, input: string): Readonly<ManagedPath> {
	const resolvedRoot = resolve(root);
	const relativePath = normalizeRelativePath(input);
	const absolutePath = resolve(resolvedRoot, ...relativePath.split("/"));
	const rootRelativePath = relative(resolvedRoot, absolutePath);
	if (rootRelativePath === ".." || rootRelativePath.startsWith(`..${sep}`) || isAbsolute(rootRelativePath)) {
		throw new InventoryError("Managed path resolves outside its approved root", input);
	}
	return Object.freeze({ relativePath, absolutePath });
}

export function resolveInventoryRoots(machineRoot: string, sharedRoot: string): Readonly<ResolvedInventoryRoots> {
	return Object.freeze({ machine: resolve(machineRoot), shared: resolve(sharedRoot) });
}

export function assertNoPathCollisions(paths: readonly string[]): void {
	const byPortablePath = new Map<string, string>();
	for (const originalPath of paths) {
		const normalizedPath = normalizeRelativePath(originalPath);
		const portablePath = normalizedPath.toLowerCase();
		const existing = byPortablePath.get(portablePath);
		if (existing !== undefined && existing !== originalPath) {
			throw new InventoryError(`Case-insensitive or Unicode-normalized path collision with ${existing}`, originalPath);
		}
		byPortablePath.set(portablePath, originalPath);
	}
}

export function portableExecutableBit(mode: number, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" ? false : (mode & 0o111) !== 0;
}

async function assertNoSymlinkComponents(path: string, label: string): Promise<void> {
	const absolutePath = resolve(path);
	const parsed = parse(absolutePath);
	let current = parsed.root;
	for (const component of absolutePath.slice(parsed.root.length).split(sep).filter(Boolean)) {
		current = resolve(current, component);
		let details: Stats;
		try {
			details = await lstat(current);
		} catch (error) {
			throw new InventoryError(`Cannot inspect ${label} path component`, current, { cause: error });
		}
		if (details.isSymbolicLink()) throw new InventoryError(`${label} path component is a symlink`, current);
	}
}

async function validateRoot(root: string, label: string): Promise<void> {
	await assertNoSymlinkComponents(root, label);
	const details = await lstat(root);
	if (!details.isDirectory()) throw new InventoryError(`${label} root is not a directory`, root);
}

function staticPatternPrefix(pattern: string): string {
	const parts: string[] = [];
	for (const segment of pattern.split("/")) {
		if (GLOB_CHARACTER.test(segment)) break;
		parts.push(segment);
	}
	return parts.join("/");
}

function canContainManagedPath(directoryPath: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => {
		const prefix = staticPatternPrefix(pattern);
		return (
			prefix === "" ||
			prefix === directoryPath ||
			prefix.startsWith(`${directoryPath}/`) ||
			directoryPath.startsWith(`${prefix}/`)
		);
	});
}

function matchesManagedPath(path: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => minimatch(path, pattern, MATCH_OPTIONS));
}

function isDeniedTree(path: string): boolean {
	return isPermanentlyDenied(path) || isPermanentlyDenied(`${path}/_`);
}

async function scanRoot(
	root: string,
	patterns: readonly string[],
	limits: Readonly<InventoryLimits>,
	signal?: AbortSignal,
): Promise<InventoryScan> {
	const files: CandidateFile[] = [];
	const collisionPaths: string[] = [];
	let totalBytes = 0;

	const visit = async (directory: string, parentPath: string): Promise<void> => {
		abortIfRequested(signal);
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			throw new InventoryError("Cannot read managed directory", parentPath || ".", { cause: error });
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));

		for (const entry of entries) {
			abortIfRequested(signal);
			const rawRelativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
			const managedPath = resolveManagedPath(root, rawRelativePath);
			if (parentPath === "" && entry.name === ".git") continue;
			if (entry.name === ".git")
				throw new InventoryError("Nested Git repository is not supported", managedPath.relativePath);
			if (isDeniedTree(managedPath.relativePath)) continue;

			let details: Stats;
			try {
				details = await lstat(managedPath.absolutePath);
			} catch (error) {
				throw new InventoryError("Cannot inspect managed path", managedPath.relativePath, { cause: error });
			}
			if (details.isSymbolicLink()) throw new InventoryError("Managed path is a symlink", managedPath.relativePath);
			collisionPaths.push(rawRelativePath);

			if (details.isDirectory()) {
				if (canContainManagedPath(managedPath.relativePath, patterns)) {
					await visit(managedPath.absolutePath, managedPath.relativePath);
				}
				continue;
			}
			if (!matchesManagedPath(managedPath.relativePath, patterns)) continue;
			if (!details.isFile()) throw new InventoryError("Managed path is not a regular file", managedPath.relativePath);
			if (details.size > limits.maxFileBytes) {
				throw new InventoryError(
					`Managed file exceeds the ${limits.maxFileBytes}-byte limit`,
					managedPath.relativePath,
				);
			}
			totalBytes += details.size;
			if (totalBytes > limits.maxTotalBytes) {
				throw new InventoryError(
					`Managed files exceed the ${limits.maxTotalBytes}-byte total limit`,
					managedPath.relativePath,
				);
			}
			files.push({ ...managedPath, size: details.size });
		}
	};

	await visit(root, "");
	assertNoPathCollisions(collisionPaths);
	return { root, files };
}

function assertTotalPlanSize(machineScan: InventoryScan, sharedScan: InventoryScan, maxTotalBytes: number): void {
	let totalBytes = 0;
	for (const [label, scan] of [
		["THIS MACHINE", machineScan],
		["SHARED REPOSITORY", sharedScan],
	] as const) {
		for (const file of scan.files) {
			totalBytes += file.size;
			if (totalBytes > maxTotalBytes) {
				throw new InventoryError(
					`${label} causes managed files to exceed the ${maxTotalBytes}-byte total plan limit`,
					file.relativePath,
				);
			}
		}
	}
}

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function comparisonBytes(path: string, exactBytes: Buffer): Buffer {
	if (path !== "settings.json") return exactBytes;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(exactBytes);
		const value: unknown = JSON.parse(text);
		const canonical = stableStringify(value);
		if (canonical === undefined) throw new TypeError("Cannot canonicalize settings.json");
		return Buffer.from(canonical, "utf8");
	} catch (error) {
		throw new InventoryError("Cannot canonicalize managed JSON", path, { cause: error });
	}
}

async function materializeInventory(
	scan: InventoryScan,
	source: "machine" | "shared",
	limits: Readonly<InventoryLimits>,
	signal?: AbortSignal,
): Promise<Readonly<FileInventory>> {
	const files: Record<string, Readonly<InventoryFile>> = {};
	let totalBytes = 0;

	for (const candidate of scan.files) {
		abortIfRequested(signal);
		let handle: FileHandle | undefined;
		try {
			handle = await open(candidate.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			const details = await handle.stat();
			if (!details.isFile()) throw new InventoryError("Managed path is not a regular file", candidate.relativePath);
			if (details.size !== candidate.size)
				throw new InventoryError("Managed file changed during inventory", candidate.relativePath);
			if (details.size > limits.maxFileBytes) {
				throw new InventoryError(`Managed file exceeds the ${limits.maxFileBytes}-byte limit`, candidate.relativePath);
			}
			abortIfRequested(signal);
			const exactBytes = await handle.readFile();
			if (exactBytes.byteLength !== details.size) {
				throw new InventoryError("Managed file changed during inventory", candidate.relativePath);
			}
			totalBytes += exactBytes.byteLength;
			if (totalBytes > limits.maxTotalBytes) {
				throw new InventoryError(
					`Managed files exceed the ${limits.maxTotalBytes}-byte total limit`,
					candidate.relativePath,
				);
			}
			const comparedBytes = comparisonBytes(candidate.relativePath, exactBytes);
			files[candidate.relativePath] = Object.freeze({
				path: candidate.relativePath,
				size: exactBytes.byteLength,
				sha256: hash(exactBytes),
				comparisonSha256: hash(comparedBytes),
				executable: portableExecutableBit(details.mode),
				exactBytesBase64: exactBytes.toString("base64"),
			});
		} catch (error) {
			if (error instanceof InventoryError) throw error;
			throw new InventoryError("Cannot read managed file", candidate.relativePath, { cause: error });
		} finally {
			await handle?.close();
		}
	}

	return Object.freeze({ source, root: scan.root, files: Object.freeze(files), totalBytes });
}

function resolveLimits(limits?: Partial<InventoryLimits>): Readonly<InventoryLimits> {
	const resolvedLimits = {
		maxFileBytes: limits?.maxFileBytes ?? DEFAULT_INVENTORY_LIMITS.maxFileBytes,
		maxTotalBytes: limits?.maxTotalBytes ?? DEFAULT_INVENTORY_LIMITS.maxTotalBytes,
	};
	if (!Number.isSafeInteger(resolvedLimits.maxFileBytes) || resolvedLimits.maxFileBytes < 0) {
		throw new TypeError("maxFileBytes must be a non-negative safe integer.");
	}
	if (!Number.isSafeInteger(resolvedLimits.maxTotalBytes) || resolvedLimits.maxTotalBytes < 0) {
		throw new TypeError("maxTotalBytes must be a non-negative safe integer.");
	}
	return Object.freeze(resolvedLimits);
}

function resolvePatterns(patterns?: readonly string[]): readonly string[] {
	return Object.freeze([...(patterns ?? DEFAULT_MANAGED_SCOPE)].map(normalizePattern).sort());
}

function baselineInventory(baseline: Baseline | null): Readonly<FileInventory> {
	const files: Record<string, Readonly<InventoryFile>> = {};
	for (const [path, fingerprint] of Object.entries(baseline?.files ?? {}).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const normalizedPath = normalizeRelativePath(path);
		files[normalizedPath] = Object.freeze({ path: normalizedPath, ...fingerprint });
	}
	assertNoPathCollisions(Object.keys(files));
	return Object.freeze({ source: "baseline", files: Object.freeze(files), totalBytes: 0 });
}

export async function discoverFileInventory(
	root: string,
	source: "machine" | "shared",
	options: DiscoverInventoryOptions = {},
): Promise<Readonly<FileInventory>> {
	const resolvedRoot = resolve(root);
	const limits = resolveLimits(options.limits);
	const patterns = resolvePatterns(options.managedPatterns);
	abortIfRequested(options.signal);
	await validateRoot(resolvedRoot, source === "machine" ? "THIS MACHINE" : "SHARED REPOSITORY");
	const scan = await scanRoot(resolvedRoot, patterns, limits, options.signal);
	return materializeInventory(scan, source, limits, options.signal);
}

export async function buildInventorySet(options: {
	machineRoot: string;
	sharedRoot: string;
	baseline: Baseline | null;
	managedPatterns?: readonly string[];
	limits?: Partial<InventoryLimits>;
	signal?: AbortSignal;
}): Promise<Readonly<InventorySet>> {
	const roots = resolveInventoryRoots(options.machineRoot, options.sharedRoot);
	const limits = resolveLimits(options.limits);
	const patterns = resolvePatterns(options.managedPatterns);
	abortIfRequested(options.signal);
	await Promise.all([validateRoot(roots.machine, "THIS MACHINE"), validateRoot(roots.shared, "SHARED REPOSITORY")]);
	const [machineScan, sharedScan] = await Promise.all([
		scanRoot(roots.machine, patterns, limits, options.signal),
		scanRoot(roots.shared, patterns, limits, options.signal),
	]);
	assertTotalPlanSize(machineScan, sharedScan, limits.maxTotalBytes);
	const machine = await materializeInventory(machineScan, "machine", limits, options.signal);
	const shared = await materializeInventory(sharedScan, "shared", limits, options.signal);
	return Object.freeze({ roots, machine, shared, baseline: baselineInventory(options.baseline) });
}
