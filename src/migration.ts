import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import stableStringify from "json-stable-stringify";
import { minimatch } from "minimatch";
import npa from "npm-package-arg";
import semver from "semver";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	createDefaultLocalPolicy,
	createDefaultSharedManifest,
	DEFAULT_MANAGED_SCOPE,
	resolveEffectivePaths,
} from "./config.ts";
import { discoverFileInventory, type InventoryFile, resolveManagedPath } from "./files.ts";
import { type PackageDeclaration, parsePackageDeclarations } from "./packages.ts";
import { loadConfig, loadState, saveConfig, saveState } from "./state.ts";
import type { Baseline, ConfigDocument, SharedManifest, StateDocument } from "./types.ts";

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const CommitSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const LegacyManifestSchema = Type.Object(
	{
		schemaVersion: Type.Literal(2),
		branch: Type.String({ minLength: 1 }),
		root: Type.String({ minLength: 1 }),
		include: Type.Array(Type.String({ minLength: 1 })),
		exclude: Type.Array(Type.String({ minLength: 1 })),
		delete: Type.Union([Type.Literal("tracked"), Type.Literal("none")]),
		pullTimeoutMs: Type.Integer({ minimum: 1 }),
		security: Type.Object({ scanSecretsBeforePush: Type.Boolean() }, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);
const LegacyStateSchema = Type.Object(
	{
		schemaVersion: Type.Literal(3),
		repoPath: Type.String({ minLength: 1 }),
		branch: Type.String({ minLength: 1 }),
		lastSyncedCommit: CommitSchema,
		lastSyncedAt: Type.String({ minLength: 1 }),
		files: Type.Record(
			Type.String({ minLength: 1 }),
			Type.Object({ sha256: Sha256Schema, mode: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
		),
		pendingOperation: Type.Unknown(),
		lastBackup: Type.Optional(Type.String()),
		deviceId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

type LegacyManifest = Static<typeof LegacyManifestSchema>;
type LegacyState = Static<typeof LegacyStateSchema>;
export type MigrationExec = ExtensionAPI["exec"];

export interface LegacyMigrationDetection {
	compatibilitySymlink: { path: string; target: string } | null;
	legacyPackageDeclared: boolean;
	legacyRepositoryDirectory: string | null;
	manifestPath: string | null;
	statePath: string | null;
}

export interface MigrationPreview {
	baseline: Baseline | null;
	branch: string | null;
	deletionAllowed: boolean;
	detection: Readonly<LegacyMigrationDetection>;
	finalSharedTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	lastSyncedAt: string | null;
	migrationId: string;
	repositoryPath: string | null;
	requiredMode: "reconcile";
	reviewedManifest: Readonly<SharedManifest> | null;
	schemaVersion: 1;
	sharedScope: readonly string[];
	status: "ready" | "no_delete_reconcile" | "unavailable";
	warnings: readonly string[];
}

export interface MigrationAuthorization {
	migrationId: string;
}

export type MigrationReviewResult =
	| { status: "preview_only"; preview: Readonly<MigrationPreview>; text: string }
	| { status: "cancelled"; preview: Readonly<MigrationPreview> }
	| { status: "id_mismatch"; preview: Readonly<MigrationPreview> }
	| {
			status: "confirmed";
			preview: Readonly<MigrationPreview>;
			authorization: Readonly<MigrationAuthorization>;
	  };

const LEGACY_PACKAGE_NAME = "@jachy/pi-git-sync";
const MATCH_OPTIONS = {
	dot: true,
	matchBase: false,
	nocase: false,
	nonegate: true,
	windowsPathsNoEscape: true,
} as const;

async function details(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	return typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source : undefined;
}

function declaresLegacyPackage(settings: unknown): boolean {
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
	const packages = (settings as { packages?: unknown }).packages;
	if (!Array.isArray(packages)) return false;
	return packages.some((entry) => {
		const source = packageSource(entry);
		return source === `npm:${LEGACY_PACKAGE_NAME}` || source?.startsWith(`npm:${LEGACY_PACKAGE_NAME}@`) === true;
	});
}

export async function detectLegacyMigration(options: {
	agentDirectory: string;
	homeDirectory: string;
}): Promise<Readonly<LegacyMigrationDetection>> {
	const piDirectory = resolve(options.homeDirectory, ".pi");
	const repositoryDirectory = resolve(piDirectory, "config-repo");
	const manifestPath = resolve(repositoryDirectory, "pi-sync.json");
	const repositoryStatePath = resolve(repositoryDirectory, ".pi-sync", "state.json");
	const agentStatePath = resolve(options.agentDirectory, ".pi-sync", "state.json");
	const compatibilityPath = resolve(options.agentDirectory, ".pi-sync");
	const compatibilityDetails = await details(compatibilityPath);
	const settings = await readJson(resolve(options.agentDirectory, "settings.json"));
	let compatibilitySymlink: LegacyMigrationDetection["compatibilitySymlink"] = null;
	if (compatibilityDetails?.isSymbolicLink()) {
		compatibilitySymlink = { path: compatibilityPath, target: await readlink(compatibilityPath) };
	}
	const repositoryDetails = await details(repositoryDirectory);
	const selectedStatePath = (await details(repositoryStatePath))
		? repositoryStatePath
		: (await details(agentStatePath))
			? agentStatePath
			: null;
	return Object.freeze({
		compatibilitySymlink: compatibilitySymlink ? Object.freeze(compatibilitySymlink) : null,
		legacyPackageDeclared: declaresLegacyPackage(settings),
		legacyRepositoryDirectory:
			repositoryDetails?.isDirectory() && !repositoryDetails.isSymbolicLink() ? repositoryDirectory : null,
		manifestPath: (await details(manifestPath))?.isFile() ? manifestPath : null,
		statePath: selectedStatePath,
	});
}

function previewSecurityData(preview: Omit<MigrationPreview, "migrationId">): Record<string, unknown> {
	return {
		baseline: preview.baseline,
		branch: preview.branch,
		deletionAllowed: preview.deletionAllowed,
		detection: preview.detection,
		finalSharedTree: Object.fromEntries(
			Object.entries(preview.finalSharedTree).map(([path, file]) => [
				path,
				{
					comparisonSha256: file.comparisonSha256,
					executable: file.executable,
					sha256: file.sha256,
				},
			]),
		),
		lastSyncedAt: preview.lastSyncedAt,
		repositoryPath: preview.repositoryPath,
		requiredMode: preview.requiredMode,
		reviewedManifest: preview.reviewedManifest,
		schemaVersion: preview.schemaVersion,
		sharedScope: preview.sharedScope,
		status: preview.status,
	};
}

function migrationId(preview: Omit<MigrationPreview, "migrationId">): string {
	const canonical = stableStringify(previewSecurityData(preview));
	if (canonical === undefined) throw new Error("Cannot fingerprint the migration preview.");
	return createHash("sha256").update(canonical).digest("hex");
}

function freezePreview(preview: Omit<MigrationPreview, "migrationId">): Readonly<MigrationPreview> {
	return Object.freeze({
		...preview,
		baseline: preview.baseline
			? Object.freeze({ commit: preview.baseline.commit, files: Object.freeze({ ...preview.baseline.files }) })
			: null,
		detection: Object.freeze({ ...preview.detection }),
		finalSharedTree: Object.freeze(
			Object.fromEntries(
				Object.entries(preview.finalSharedTree).map(([path, file]) => [path, Object.freeze({ ...file })]),
			),
		),
		migrationId: migrationId(preview),
		reviewedManifest: preview.reviewedManifest
			? Object.freeze({
					...preview.reviewedManifest,
					bitwarden: Object.freeze({
						...preview.reviewedManifest.bitwarden,
						environment: Object.freeze({ ...preview.reviewedManifest.bitwarden.environment }),
					}),
					managedScope: [...preview.reviewedManifest.managedScope],
				})
			: null,
		sharedScope: Object.freeze([...preview.sharedScope]),
		warnings: Object.freeze([...preview.warnings]),
	});
}

function noDeletePreview(
	detection: Readonly<LegacyMigrationDetection>,
	values: {
		branch?: string | null;
		repositoryPath?: string | null;
		sharedScope?: readonly string[];
		lastSyncedAt?: string | null;
		warning: string;
	},
): Readonly<MigrationPreview> {
	return freezePreview({
		baseline: null,
		branch: values.branch ?? null,
		deletionAllowed: false,
		detection,
		finalSharedTree: {},
		lastSyncedAt: values.lastSyncedAt ?? null,
		repositoryPath: values.repositoryPath ?? null,
		requiredMode: "reconcile",
		reviewedManifest: null,
		schemaVersion: 1,
		sharedScope: values.sharedScope ?? [],
		status: values.branch && values.repositoryPath ? "no_delete_reconcile" : "unavailable",
		warnings: [values.warning],
	});
}

async function gitValue(options: {
	exec: MigrationExec;
	cwd: string;
	args: string[];
	signal?: AbortSignal;
}): Promise<string> {
	options.signal?.throwIfAborted();
	const result = await options.exec("git", options.args, {
		cwd: options.cwd,
		signal: options.signal,
		timeout: 30_000,
	});
	options.signal?.throwIfAborted();
	if (result.code !== 0 || result.killed) throw new Error("Legacy Git validation failed.");
	return result.stdout.trim();
}

function validateRepositoryPath(repositoryPath: string): void {
	if (/[\0\r\n]/.test(repositoryPath)) throw new Error("Legacy Git origin is invalid.");
	if (!repositoryPath.includes("://")) return;
	const url = new URL(repositoryPath);
	if (url.username || url.password) throw new Error("Legacy Git origin contains embedded credentials.");
}

function isExcluded(path: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => minimatch(path, pattern, MATCH_OPTIONS));
}

function migrationInventoryFile(path: string, content: Buffer, executable = false): Readonly<InventoryFile> {
	let comparison = content;
	if (path === "agent/settings.json") {
		const canonical = stableStringify(JSON.parse(content.toString("utf8")));
		if (canonical === undefined) throw new Error("Cannot canonicalize migrated agent/settings.json.");
		comparison = Buffer.from(canonical);
	}
	return Object.freeze({
		path,
		size: content.byteLength,
		sha256: createHash("sha256").update(content).digest("hex"),
		comparisonSha256: createHash("sha256").update(comparison).digest("hex"),
		executable,
		exactBytesBase64: content.toString("base64"),
	});
}

function remapLegacyFile(path: string, file: Readonly<InventoryFile>): Readonly<InventoryFile> {
	if (file.exactBytesBase64 === undefined) throw new Error(`Legacy content is unavailable: ${path}`);
	return migrationInventoryFile(path, Buffer.from(file.exactBytesBase64, "base64"), file.executable);
}

async function exactNpmSource(source: string, exec: MigrationExec, signal?: AbortSignal): Promise<string> {
	const spec = source.slice("npm:".length);
	let parsed: ReturnType<typeof npa>;
	try {
		parsed = npa(spec);
	} catch {
		throw new Error("A migrated npm package source is invalid.");
	}
	if (!parsed.name || !parsed.rawSpec) throw new Error("A migrated npm package source is invalid.");
	if (parsed.type === "version" && semver.valid(parsed.rawSpec)) return `npm:${parsed.name}@${parsed.rawSpec}`;
	const result = await exec("npm", ["view", spec, "version", "--json"], { signal, timeout: 30_000 });
	if (result.code !== 0 || result.killed) throw new Error("A migrated npm package version could not be resolved.");
	let value: unknown;
	try {
		value = JSON.parse(result.stdout);
	} catch {
		throw new Error("The npm registry returned an invalid package version result.");
	}
	const versions = (Array.isArray(value) ? value : [value]).filter(
		(candidate): candidate is string => typeof candidate === "string" && semver.valid(candidate) !== null,
	);
	const version = semver.rsort(versions)[0];
	if (!version) throw new Error("The npm registry returned no compatible package version.");
	return `npm:${parsed.name}@${version}`;
}

function gitSourceParts(source: string): { prefix: string; repository: string; ref?: string } {
	const prefix = source.startsWith("git:") ? "git:" : "";
	const body = prefix ? source.slice(prefix.length) : source;
	const delimiter = body.lastIndexOf("@");
	const separator = Math.max(body.lastIndexOf("/"), body.lastIndexOf(":"));
	const hasRef = delimiter > separator;
	const repository = hasRef ? body.slice(0, delimiter) : body;
	const ref = hasRef ? body.slice(delimiter + 1) : undefined;
	if (!repository || (hasRef && !ref)) throw new Error("A migrated Git package source is invalid.");
	return { prefix, repository, ref };
}

async function exactGitSource(source: string, exec: MigrationExec, signal?: AbortSignal): Promise<string> {
	const parts = gitSourceParts(source);
	if (parts.ref && /^[a-f0-9]{40,64}$/i.test(parts.ref)) return source;
	const repository =
		!parts.repository.includes("://") && parts.repository.startsWith("github.com/")
			? `https://${parts.repository}`
			: parts.repository;
	const patterns = parts.ref
		? [parts.ref, `refs/heads/${parts.ref}`, `refs/tags/${parts.ref}`, `refs/tags/${parts.ref}^{}`]
		: ["HEAD"];
	const result = await exec("git", ["ls-remote", "--", repository, ...patterns], { signal, timeout: 30_000 });
	if (result.code !== 0 || result.killed) throw new Error("A migrated Git package commit could not be resolved.");
	const refs = result.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/, 2))
		.filter((entry): entry is [string, string] => entry.length === 2 && /^[a-f0-9]{40,64}$/i.test(entry[0]));
	const peeledTag = parts.ref ? refs.find(([, name]) => name === `refs/tags/${parts.ref}^{}`) : undefined;
	const commit = peeledTag?.[0] ?? refs[0]?.[0];
	if (!commit) throw new Error("A migrated Git package commit could not be resolved.");
	return `${parts.prefix}${parts.repository}@${commit.toLowerCase()}`;
}

async function normalizedSettingsFile(
	file: Readonly<InventoryFile>,
	exec: MigrationExec,
	signal?: AbortSignal,
): Promise<Readonly<InventoryFile>> {
	if (file.exactBytesBase64 === undefined) throw new Error("Migrated agent/settings.json content is unavailable.");
	let settings: Record<string, unknown>;
	try {
		const value: unknown = JSON.parse(Buffer.from(file.exactBytesBase64, "base64").toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		settings = value as Record<string, unknown>;
	} catch {
		throw new Error("Migrated agent/settings.json is invalid.");
	}
	if (settings.packages === undefined) return file;
	const parsed = parsePackageDeclarations(settings.packages, {
		source: "machine",
		policy: createDefaultLocalPolicy(),
	});
	const declarations = Array.isArray(settings.packages) ? (settings.packages as PackageDeclaration[]) : [];
	settings.packages = await Promise.all(
		parsed.map(async (entry, index) => {
			let source: string;
			if (entry.scheme === "npm") source = await exactNpmSource(entry.exactSource, exec, signal);
			else if (entry.scheme === "git" || entry.scheme === "https" || entry.scheme === "ssh") {
				source = await exactGitSource(entry.exactSource, exec, signal);
			} else throw new Error("A migrated package source cannot be shared.");
			const declaration = declarations[index];
			return typeof declaration === "string" ? source : { ...declaration, source };
		}),
	);
	const text = stableStringify(settings, { space: 2 });
	if (text === undefined) throw new Error("Migrated agent/settings.json could not be serialized.");
	return migrationInventoryFile("agent/settings.json", Buffer.from(`${text}\n`), file.executable);
}

export async function buildMigrationPreview(options: {
	exec: MigrationExec;
	agentDirectory: string;
	homeDirectory: string;
	signal?: AbortSignal;
}): Promise<Readonly<MigrationPreview>> {
	const detection = await detectLegacyMigration(options);
	if (!detection.legacyRepositoryDirectory || !detection.manifestPath) {
		return noDeletePreview(detection, {
			warning: "Legacy repository or schema-2 pi-sync.json was not found. No import is available.",
		});
	}
	let manifest: LegacyManifest;
	try {
		const value = await readJson(detection.manifestPath);
		if (!Value.Check(LegacyManifestSchema, value)) throw new Error("Invalid schema-2 manifest.");
		manifest = value as LegacyManifest;
	} catch {
		return noDeletePreview(detection, {
			warning: "Legacy schema-2 pi-sync.json is invalid. No values were imported.",
		});
	}
	const sharedScope = [
		...new Set([...manifest.include.map((pattern) => `agent/${pattern}`), ...DEFAULT_MANAGED_SCOPE]),
	].sort();
	let repositoryPath: string;
	try {
		repositoryPath = await gitValue({
			exec: options.exec,
			cwd: detection.legacyRepositoryDirectory,
			args: ["remote", "get-url", "origin"],
			signal: options.signal,
		});
		if (!repositoryPath) throw new Error("Legacy origin is empty.");
		validateRepositoryPath(repositoryPath);
	} catch {
		return noDeletePreview(detection, {
			branch: manifest.branch,
			sharedScope,
			warning: "Legacy SHARED REPOSITORY access could not be validated. No values were imported.",
		});
	}
	if (!detection.statePath) {
		return noDeletePreview(detection, {
			branch: manifest.branch,
			repositoryPath,
			sharedScope,
			warning: "Legacy schema-3 state is missing. RECONCILE will use no deletion baseline.",
		});
	}
	let state: LegacyState;
	try {
		const value = await readJson(detection.statePath);
		if (!Value.Check(LegacyStateSchema, value)) throw new Error("Invalid schema-3 state.");
		state = value as LegacyState;
	} catch {
		return noDeletePreview(detection, {
			branch: manifest.branch,
			repositoryPath,
			sharedScope: manifest.include,
			warning: "Legacy schema-3 state is invalid. RECONCILE will use no deletion baseline.",
		});
	}
	if (
		resolve(state.repoPath) !== resolve(detection.legacyRepositoryDirectory) ||
		state.branch !== manifest.branch ||
		state.pendingOperation !== null
	) {
		return noDeletePreview(detection, {
			branch: manifest.branch,
			repositoryPath,
			sharedScope,
			lastSyncedAt: state.lastSyncedAt,
			warning: "Legacy baseline metadata is ambiguous. RECONCILE will use no deletion baseline.",
		});
	}
	try {
		await gitValue({
			exec: options.exec,
			cwd: detection.legacyRepositoryDirectory,
			args: ["cat-file", "-e", `${state.lastSyncedCommit}^{commit}`],
			signal: options.signal,
		});
		const syncRoot = resolveManagedPath(detection.legacyRepositoryDirectory, manifest.root).absolutePath;
		const inventory = await discoverFileInventory(syncRoot, "shared", {
			managedPatterns: manifest.include,
			signal: options.signal,
		});
		const machine = await discoverFileInventory(dirname(options.agentDirectory), "machine", {
			managedPatterns: sharedScope,
			signal: options.signal,
		});
		const candidates = [...new Set([...Object.keys(state.files), ...Object.keys(inventory.files)])]
			.filter((path) => !isExcluded(path, manifest.exclude))
			.map((path) => `agent/${path}`)
			.sort();
		const effectivePaths = resolveEffectivePaths(candidates, sharedScope, sharedScope);
		const files: Baseline["files"] = {};
		const finalSharedTree: Record<string, Readonly<InventoryFile>> = { ...machine.files };
		for (const path of effectivePaths) {
			const legacyPath = path.slice("agent/".length);
			const oldFile = state.files[legacyPath];
			const currentFile = inventory.files[legacyPath];
			if (
				!oldFile ||
				!currentFile ||
				oldFile.sha256 !== currentFile.sha256 ||
				(oldFile.mode & 0o111) !== (currentFile.executable ? 0o111 : 0)
			) {
				throw new Error("Legacy file hash or mode is ambiguous.");
			}
			const migratedFile = remapLegacyFile(path, currentFile);
			finalSharedTree[path] = migratedFile;
			files[path] = {
				comparisonSha256: migratedFile.comparisonSha256,
				executable: migratedFile.executable,
				sha256: migratedFile.sha256,
			};
		}
		const settingsFile = finalSharedTree["agent/settings.json"];
		if (settingsFile)
			finalSharedTree["agent/settings.json"] = await normalizedSettingsFile(settingsFile, options.exec, options.signal);
		const reviewedManifest = createDefaultSharedManifest(sharedScope);
		const manifestText = stableStringify(reviewedManifest, { space: 2 });
		if (manifestText === undefined) throw new Error("Cannot serialize the reviewed SHARED REPOSITORY manifest.");
		finalSharedTree["pi-sync.json"] = migrationInventoryFile("pi-sync.json", Buffer.from(`${manifestText}\n`));
		return freezePreview({
			baseline: { commit: state.lastSyncedCommit, files },
			branch: manifest.branch,
			deletionAllowed: manifest.delete === "tracked",
			detection,
			finalSharedTree,
			lastSyncedAt: state.lastSyncedAt,
			repositoryPath,
			requiredMode: "reconcile",
			reviewedManifest,
			schemaVersion: 1,
			sharedScope,
			status: "ready",
			warnings: detection.legacyPackageDeclared
				? [
						"Disable or remove @jachy/pi-git-sync before enabling synchronization with this package if command names conflict.",
					]
				: [],
		});
	} catch {
		return noDeletePreview(detection, {
			branch: manifest.branch,
			repositoryPath,
			sharedScope,
			lastSyncedAt: state.lastSyncedAt,
			warning: "Legacy baseline validation failed. RECONCILE will use no deletion baseline.",
		});
	}
}

export function formatMigrationPreview(preview: Readonly<MigrationPreview>): string {
	const baseline = preview.baseline
		? `${Object.keys(preview.baseline.files).length} validated file hashes at commit ${preview.baseline.commit}`
		: "No deletion baseline will be imported";
	const artifacts = [
		preview.detection.legacyPackageDeclared ? "installed package declaration" : undefined,
		preview.detection.legacyRepositoryDirectory ? "~/.pi/config-repo" : undefined,
		preview.detection.manifestPath ? "schema-2 pi-sync.json" : undefined,
		preview.detection.statePath ? "schema-3 state" : undefined,
		preview.detection.compatibilitySymlink ? "old .pi-sync compatibility symlink" : undefined,
	].filter((value): value is string => value !== undefined);
	return [
		"MIGRATION PREVIEW — READ ONLY",
		`Migration ID: ${preview.migrationId}`,
		`Detected: ${artifacts.join(", ") || "no legacy artifacts"}`,
		`Result: ${baseline}.`,
		`Next mode: ${preview.requiredMode.toUpperCase()}.`,
		"WILL NOT HAPPEN: old state, backups, clone data, package declarations, and SHARED REPOSITORY history will not be removed or changed.",
		...preview.warnings.map((warning) => `WARNING: ${warning}`),
	].join("\n");
}

export function authorizeMigration(
	preview: Readonly<MigrationPreview>,
	suppliedMigrationId: string,
): Readonly<MigrationAuthorization> {
	if (preview.migrationId !== suppliedMigrationId) throw new Error("Exact migration ID does not match the preview.");
	if (!preview.branch || !preview.repositoryPath || preview.status === "unavailable") {
		throw new Error("The migration preview has no fully validated repository configuration.");
	}
	return Object.freeze({ migrationId: preview.migrationId });
}

export async function reviewMigration(options: {
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">;
	preview: Readonly<MigrationPreview>;
}): Promise<MigrationReviewResult> {
	const text = formatMigrationPreview(options.preview);
	if (!options.ctx.hasUI) return { status: "preview_only", preview: options.preview, text };
	const selected = await options.ctx.ui.select(text, ["Enter exact migration ID", "Cancel without changes"]);
	if (selected !== "Enter exact migration ID") return { status: "cancelled", preview: options.preview };
	const supplied = await options.ctx.ui.input("Enter exact migration ID", options.preview.migrationId);
	if (supplied !== options.preview.migrationId) return { status: "id_mismatch", preview: options.preview };
	return {
		status: "confirmed",
		preview: options.preview,
		authorization: authorizeMigration(options.preview, supplied),
	};
}

function assertPreviewIntegrity(preview: Readonly<MigrationPreview>): void {
	const data: Record<string, unknown> = { ...preview };
	delete data.migrationId;
	if (migrationId(data as Omit<MigrationPreview, "migrationId">) !== preview.migrationId) {
		throw new Error("Migration preview integrity check failed.");
	}
}

export async function importLegacyMigration(options: {
	agentDirectory: string;
	preview: Readonly<MigrationPreview>;
	authorization: Readonly<MigrationAuthorization>;
	publishedCommit: string;
}): Promise<{ status: "success"; requiredMode: "reconcile"; deletionAllowed: boolean }> {
	assertPreviewIntegrity(options.preview);
	if (options.authorization.migrationId !== options.preview.migrationId) {
		throw new Error("Migration authorization does not match the read-only preview.");
	}
	if (!options.preview.branch || !options.preview.repositoryPath || options.preview.status !== "ready") {
		throw new Error("Migration cannot import unvalidated repository configuration.");
	}
	if (!/^[a-f0-9]{40,64}$/.test(options.publishedCommit)) {
		throw new Error("Migration publication commit is invalid.");
	}
	const [currentConfig, currentState] = await Promise.all([
		loadConfig(options.agentDirectory),
		loadState(options.agentDirectory),
	]);
	if (currentConfig || currentState) throw new Error("Migration will not replace existing pi-sync data.");
	const policy = createDefaultLocalPolicy();
	const managedPaths = resolveEffectivePaths(
		Object.keys(options.preview.finalSharedTree),
		options.preview.sharedScope,
		options.preview.sharedScope,
	);
	const baselineFiles: Baseline["files"] = Object.fromEntries(
		managedPaths.map((path) => {
			const file = options.preview.finalSharedTree[path];
			if (!file) throw new Error(`Migration file is unavailable: ${path}`);
			return [
				path,
				{
					comparisonSha256: file.comparisonSha256,
					executable: file.executable,
					sha256: file.sha256,
				},
			];
		}),
	);
	const config: ConfigDocument = {
		policy: {
			...policy,
			acceptedSharedScope: [...options.preview.sharedScope],
			approvedScope: [...options.preview.sharedScope],
		},
		repository: { branch: options.preview.branch, repositoryPath: options.preview.repositoryPath },
		schemaVersion: 1,
	};
	const state: StateDocument = {
		baseline: { commit: options.publishedCommit, files: baselineFiles },
		deviceId: options.preview.detection.statePath ? randomUUID() : `migration-${randomUUID()}`,
		lastBackupId: null,
		lastSuccessTime: options.preview.lastSyncedAt,
		pendingOperation: null,
		schemaVersion: 1,
	};
	await saveState(options.agentDirectory, state);
	await saveConfig(options.agentDirectory, config);
	return {
		status: "success",
		requiredMode: "reconcile",
		deletionAllowed: options.preview.deletionAllowed,
	};
}
