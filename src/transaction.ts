import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rm, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import stableStringify from "json-stable-stringify";
import writeFileAtomic from "write-file-atomic";
import { ensureConfigSyncDirectories, getConfigSyncPaths } from "./config.ts";
import { type InventoryFile, portableExecutableBit, resolveManagedPath } from "./files.ts";
import { getBackupMetadataPath, loadBackupMetadata, saveBackupMetadata } from "./state.ts";
import type { BackupMetadata, Baseline, FileFingerprint, PlanArtifact } from "./types.ts";
import type { PlanExecutionAuthorization } from "./ui.ts";

export type MachineApplyOperation =
	| { kind: "write"; path: string; current?: Readonly<InventoryFile>; final: Readonly<InventoryFile> }
	| { kind: "delete"; path: string; current: Readonly<InventoryFile> };

export interface MachineApplySet {
	planId: string;
	operations: readonly Readonly<MachineApplyOperation>[];
	deferredPaths: readonly string[];
	finalTree: Readonly<Record<string, Readonly<InventoryFile>>>;
}

export interface MachineApplyOperations {
	lstat(path: string): Promise<Stats>;
	readFile(path: string): Promise<Buffer>;
	mkdir(path: string): Promise<void>;
	writeAtomic(path: string, content: Uint8Array, mode: number): Promise<void>;
	unlink(path: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	readdir(path: string): Promise<Dirent[]>;
	rm(path: string): Promise<void>;
	syncDirectory(path: string): Promise<void>;
}

export interface MachineApplySuccess {
	status: "success";
	planId: string;
	backupId: string;
	appliedPaths: readonly string[];
}

export interface BackupCleanupResult {
	keptBackupIds: readonly string[];
	deletedBackupIds: readonly string[];
	failedBackupIds: readonly string[];
}

export interface MachineRestoreSuccess {
	status: "success";
	backupId: string;
	restoredPaths: readonly string[];
}

export class MachineApplyError extends Error {
	readonly backupId?: string;
	readonly restored: boolean;
	readonly manualRecoveryPaths: readonly string[];

	constructor(
		message: string,
		options: { backupId?: string; restored?: boolean; manualRecoveryPaths?: readonly string[]; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "MachineApplyError";
		this.backupId = options.backupId;
		this.restored = options.restored ?? false;
		this.manualRecoveryPaths = Object.freeze([...(options.manualRecoveryPaths ?? [])]);
	}
}

function hash(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

async function pathDetails(operations: MachineApplyOperations, path: string): Promise<Stats | undefined> {
	try {
		return await operations.lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function assertSafePath(operations: MachineApplyOperations, root: string, path: string): Promise<string> {
	const managedPath = resolveManagedPath(root, path);
	const rootRelative = managedPath.absolutePath.slice(resolve(root).length).split(sep).filter(Boolean);
	let current = resolve(root);
	for (const component of rootRelative) {
		current = resolve(current, component);
		const details = await pathDetails(operations, current);
		if (!details) break;
		if (details.isSymbolicLink()) throw new MachineApplyError(`Managed path is a symlink: ${path}`);
	}
	return managedPath.absolutePath;
}

function fileMatches(
	left: Readonly<Pick<InventoryFile, "sha256" | "executable">> | undefined,
	right: Readonly<Pick<InventoryFile, "sha256" | "executable">> | undefined,
): boolean {
	if (!left || !right) return left === right;
	return left.sha256 === right.sha256 && left.executable === right.executable;
}

function assertFinalTreeMatchesPlan(
	planTree: Readonly<Record<string, Readonly<FileFingerprint>>>,
	committedTree: Readonly<Record<string, Readonly<InventoryFile>>>,
): void {
	const paths = [...new Set([...Object.keys(planTree), ...Object.keys(committedTree)])].sort();
	for (const path of paths) {
		const planned = planTree[path];
		const committed = committedTree[path];
		if (
			!planned ||
			!committed ||
			planned.sha256 !== committed.sha256 ||
			planned.comparisonSha256 !== committed.comparisonSha256 ||
			planned.executable !== committed.executable ||
			committed.exactBytesBase64 === undefined
		) {
			throw new MachineApplyError(`Committed final tree does not match the confirmed plan: ${path}`);
		}
	}
}

function machineFileActions(plan: Readonly<PlanArtifact>, path: string): PlanArtifact["actions"] {
	return plan.actions.filter(
		(action) => action.path === path && action.destination === "THIS MACHINE" && !action.codeExecution,
	);
}

export function buildMachineApplySet(options: {
	plan: Readonly<PlanArtifact>;
	authorization: Readonly<PlanExecutionAuthorization>;
	currentMachineTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	committedFinalMachineTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	baseline: Baseline | null;
	deferredPaths?: readonly string[];
}): Readonly<MachineApplySet> {
	if (options.authorization.planId !== options.plan.planId) {
		throw new MachineApplyError("Execution authorization does not match the confirmed plan.");
	}
	assertFinalTreeMatchesPlan(options.plan.finalMachineTree, options.committedFinalMachineTree);
	const operations: Readonly<MachineApplyOperation>[] = [];
	const deferredPaths = new Set(options.deferredPaths ?? []);
	const paths = [
		...new Set([...Object.keys(options.currentMachineTree), ...Object.keys(options.committedFinalMachineTree)]),
	].sort();
	for (const path of paths) {
		const current = options.currentMachineTree[path];
		const final = options.committedFinalMachineTree[path];
		if (fileMatches(current, final)) continue;
		const actions = machineFileActions(options.plan, path);
		if (actions.length !== 1)
			throw new MachineApplyError(`Confirmed plan does not name one machine file action: ${path}`);
		const action = actions[0];
		if (final) {
			if (action.action !== "WRITE ON THIS MACHINE" || action.resultSha256 !== final.sha256) {
				throw new MachineApplyError(`Confirmed plan does not name the exact machine write: ${path}`);
			}
			operations.push(Object.freeze({ kind: "write", path, current, final }));
		} else {
			if (
				!current ||
				action.action !== "DELETE FROM THIS MACHINE" ||
				action.resultSha256 !== null ||
				!options.baseline?.files[path]
			) {
				throw new MachineApplyError(`Confirmed plan does not permit the machine deletion: ${path}`);
			}
			operations.push(Object.freeze({ kind: "delete", path, current }));
		}
	}
	return Object.freeze({
		planId: options.plan.planId,
		operations: Object.freeze(operations),
		deferredPaths: Object.freeze([...deferredPaths]),
		finalTree: Object.freeze({ ...options.committedFinalMachineTree }),
	});
}

export function createMachineApplyOperations(): MachineApplyOperations {
	return {
		lstat,
		readFile,
		mkdir: async (path) => {
			await mkdir(path, { recursive: true });
		},
		writeAtomic: async (path, content, mode) => {
			await writeFileAtomic(path, Buffer.from(content), { fsync: true, mode });
		},
		unlink,
		chmod,
		readdir: (path) => readdir(path, { withFileTypes: true }),
		rm: (path) => rm(path, { force: true, recursive: true }),
		syncDirectory: async (path) => {
			if (process.platform === "win32") return;
			const handle = await open(path, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		},
	};
}

function backupRoot(agentDirectory: string, backupId: string): string {
	return dirname(getBackupMetadataPath(agentDirectory, backupId));
}

function backupFileRoot(agentDirectory: string, backupId: string): string {
	return resolve(backupRoot(agentDirectory, backupId), "files");
}

async function exactBytes(file: Readonly<InventoryFile>, path: string): Promise<Buffer> {
	if (file.exactBytesBase64 === undefined) throw new MachineApplyError(`Exact bytes are unavailable: ${path}`);
	return Buffer.from(file.exactBytesBase64, "base64");
}

async function createBackup(options: {
	agentDirectory: string;
	machineRoot: string;
	backupId: string;
	createdAt: string;
	applySet: Readonly<MachineApplySet>;
	operations: MachineApplyOperations;
	signal?: AbortSignal;
}): Promise<BackupMetadata> {
	await ensureConfigSyncDirectories(options.agentDirectory);
	const root = backupRoot(options.agentDirectory, options.backupId);
	if (await pathDetails(options.operations, root)) throw new MachineApplyError("Backup ID already exists.");
	const filesRoot = backupFileRoot(options.agentDirectory, options.backupId);
	await options.operations.mkdir(filesRoot);
	const entries: BackupMetadata["entries"] = [];
	for (const operation of options.applySet.operations) {
		options.signal?.throwIfAborted();
		if (!operation.current) {
			const machinePath = await assertSafePath(options.operations, options.machineRoot, operation.path);
			if (await pathDetails(options.operations, machinePath)) {
				throw new MachineApplyError(`Machine path changed before backup: ${operation.path}`);
			}
			entries.push({ executable: null, existed: false, path: operation.path, sha256: null });
			continue;
		}
		const machinePath = await assertSafePath(options.operations, options.machineRoot, operation.path);
		const details = await pathDetails(options.operations, machinePath);
		if (!details?.isFile()) throw new MachineApplyError(`Machine file is unavailable for backup: ${operation.path}`);
		const content = await options.operations.readFile(machinePath);
		if (
			hash(content) !== operation.current.sha256 ||
			portableExecutableBit(details.mode) !== operation.current.executable
		) {
			throw new MachineApplyError(`Machine file changed before backup: ${operation.path}`);
		}
		const backupPath = resolveManagedPath(filesRoot, operation.path).absolutePath;
		await options.operations.mkdir(dirname(backupPath));
		await options.operations.writeAtomic(backupPath, content, operation.current.executable ? 0o755 : 0o644);
		await options.operations.syncDirectory(dirname(backupPath));
		entries.push({
			executable: operation.current.executable,
			existed: true,
			path: operation.path,
			sha256: operation.current.sha256,
		});
	}
	const metadata: BackupMetadata = {
		backupId: options.backupId,
		createdAt: options.createdAt,
		entries,
		planId: options.applySet.planId,
		schemaVersion: 1,
	};
	await saveBackupMetadata(options.agentDirectory, metadata);
	return metadata;
}

export async function verifyBackup(options: {
	agentDirectory: string;
	backupId: string;
	expectedMetadata?: BackupMetadata;
	operations?: MachineApplyOperations;
}): Promise<BackupMetadata> {
	const operations = options.operations ?? createMachineApplyOperations();
	const metadata = await loadBackupMetadata(options.agentDirectory, options.backupId);
	if (!metadata) throw new MachineApplyError("Backup manifest is missing.", { backupId: options.backupId });
	if (options.expectedMetadata && stableStringify(metadata) !== stableStringify(options.expectedMetadata)) {
		throw new MachineApplyError("Backup manifest verification failed.", { backupId: options.backupId });
	}
	const filesRoot = backupFileRoot(options.agentDirectory, options.backupId);
	for (const entry of metadata.entries) {
		const path = resolveManagedPath(filesRoot, entry.path).absolutePath;
		const details = await pathDetails(operations, path);
		if (!entry.existed) {
			if (details) throw new MachineApplyError(`Unexpected backup file: ${entry.path}`, { backupId: options.backupId });
			continue;
		}
		if (!details?.isFile() || details.isSymbolicLink()) {
			throw new MachineApplyError(`Backup file is invalid: ${entry.path}`, { backupId: options.backupId });
		}
		const content = await operations.readFile(path);
		if (hash(content) !== entry.sha256 || portableExecutableBit(details.mode) !== entry.executable) {
			throw new MachineApplyError(`Backup verification failed: ${entry.path}`, { backupId: options.backupId });
		}
	}
	return metadata;
}

async function writeMachineFile(
	operations: MachineApplyOperations,
	machineRoot: string,
	path: string,
	file: Readonly<InventoryFile>,
): Promise<void> {
	const absolutePath = await assertSafePath(operations, machineRoot, path);
	const existing = await pathDetails(operations, absolutePath);
	if (existing && !existing.isFile()) throw new MachineApplyError(`Machine path is not a regular file: ${path}`);
	await operations.mkdir(dirname(absolutePath));
	await operations.writeAtomic(absolutePath, await exactBytes(file, path), file.executable ? 0o755 : 0o644);
	if (process.platform !== "win32") await operations.chmod(absolutePath, file.executable ? 0o755 : 0o644);
	await operations.syncDirectory(dirname(absolutePath));
}

async function deleteMachineFile(operations: MachineApplyOperations, machineRoot: string, path: string): Promise<void> {
	const absolutePath = await assertSafePath(operations, machineRoot, path);
	const existing = await pathDetails(operations, absolutePath);
	if (!existing?.isFile()) throw new MachineApplyError(`Machine file is unavailable for deletion: ${path}`);
	await operations.unlink(absolutePath);
	await operations.syncDirectory(dirname(absolutePath));
}

async function verifyMachineTree(options: {
	operations: MachineApplyOperations;
	machineRoot: string;
	applySet: Readonly<MachineApplySet>;
}): Promise<void> {
	for (const [path, file] of Object.entries(options.applySet.finalTree)) {
		const absolutePath = await assertSafePath(options.operations, options.machineRoot, path);
		const details = await pathDetails(options.operations, absolutePath);
		if (!details?.isFile()) throw new MachineApplyError(`Final machine file is unavailable: ${path}`);
		const content = await options.operations.readFile(absolutePath);
		if (hash(content) !== file.sha256 || portableExecutableBit(details.mode) !== file.executable) {
			throw new MachineApplyError(`Final machine verification failed: ${path}`);
		}
	}
	for (const operation of options.applySet.operations) {
		if (operation.kind !== "delete") continue;
		const absolutePath = await assertSafePath(options.operations, options.machineRoot, operation.path);
		if (await pathDetails(options.operations, absolutePath)) {
			throw new MachineApplyError(`Deleted machine path still exists: ${operation.path}`);
		}
	}
}

async function restoreBackup(options: {
	agentDirectory: string;
	machineRoot: string;
	metadata: BackupMetadata;
	operations: MachineApplyOperations;
}): Promise<string[]> {
	const manualRecoveryPaths: string[] = [];
	const filesRoot = backupFileRoot(options.agentDirectory, options.metadata.backupId);
	for (const entry of options.metadata.entries) {
		try {
			if (entry.existed) {
				const backupPath = resolveManagedPath(filesRoot, entry.path).absolutePath;
				const content = await options.operations.readFile(backupPath);
				if (hash(content) !== entry.sha256) throw new MachineApplyError(`Backup content is invalid: ${entry.path}`);
				await writeMachineFile(options.operations, options.machineRoot, entry.path, {
					path: entry.path,
					sha256: entry.sha256 as string,
					comparisonSha256: entry.sha256 as string,
					executable: entry.executable as boolean,
					exactBytesBase64: content.toString("base64"),
				});
			} else {
				const machinePath = await assertSafePath(options.operations, options.machineRoot, entry.path);
				const details = await pathDetails(options.operations, machinePath);
				if (details?.isFile()) {
					await options.operations.unlink(machinePath);
					await options.operations.syncDirectory(dirname(machinePath));
				} else if (details) {
					throw new MachineApplyError(`Created machine path is not a regular file: ${entry.path}`);
				}
			}
		} catch {
			manualRecoveryPaths.push(entry.path);
		}
	}
	return manualRecoveryPaths;
}

async function verifyRestoredBackup(options: {
	machineRoot: string;
	metadata: BackupMetadata;
	operations: MachineApplyOperations;
}): Promise<string[]> {
	const failedPaths: string[] = [];
	for (const entry of options.metadata.entries) {
		try {
			const machinePath = await assertSafePath(options.operations, options.machineRoot, entry.path);
			const details = await pathDetails(options.operations, machinePath);
			if (!entry.existed) {
				if (details) throw new MachineApplyError(`Restored path must not exist: ${entry.path}`);
				continue;
			}
			if (!details?.isFile()) throw new MachineApplyError(`Restored file is unavailable: ${entry.path}`);
			const content = await options.operations.readFile(machinePath);
			if (hash(content) !== entry.sha256 || portableExecutableBit(details.mode) !== entry.executable) {
				throw new MachineApplyError(`Restored file verification failed: ${entry.path}`);
			}
		} catch {
			failedPaths.push(entry.path);
		}
	}
	return failedPaths;
}

export async function restoreVerifiedMachineBackup(options: {
	agentDirectory: string;
	machineRoot: string;
	backupId: string;
	expectedPlanId?: string;
	operations?: MachineApplyOperations;
}): Promise<MachineRestoreSuccess> {
	const operations = options.operations ?? createMachineApplyOperations();
	const metadata = await verifyBackup({
		agentDirectory: options.agentDirectory,
		backupId: options.backupId,
		operations,
	});
	if (options.expectedPlanId && metadata.planId !== options.expectedPlanId) {
		throw new MachineApplyError("Backup does not match the confirmed restore plan.", { backupId: options.backupId });
	}
	const restoreFailures = await restoreBackup({
		agentDirectory: options.agentDirectory,
		machineRoot: options.machineRoot,
		metadata,
		operations,
	});
	const verificationFailures = await verifyRestoredBackup({
		machineRoot: options.machineRoot,
		metadata,
		operations,
	});
	const manualRecoveryPaths = [...new Set([...restoreFailures, ...verificationFailures])].sort();
	if (manualRecoveryPaths.length > 0) {
		throw new MachineApplyError("Backup restore failed. Manual recovery is required.", {
			backupId: options.backupId,
			manualRecoveryPaths,
		});
	}
	return {
		status: "success",
		backupId: options.backupId,
		restoredPaths: Object.freeze(metadata.entries.map((entry) => entry.path)),
	};
}

export async function createVerifiedMachineBackup(options: {
	agentDirectory: string;
	machineRoot: string;
	backupId: string;
	createdAt: string;
	applySet: Readonly<MachineApplySet>;
	operations?: MachineApplyOperations;
	signal?: AbortSignal;
}): Promise<BackupMetadata> {
	const operations = options.operations ?? createMachineApplyOperations();
	try {
		const metadata = await createBackup({ ...options, operations });
		return await verifyBackup({
			agentDirectory: options.agentDirectory,
			backupId: options.backupId,
			expectedMetadata: metadata,
			operations,
		});
	} catch (error) {
		throw new MachineApplyError("Verified backup was not created. THIS MACHINE was not changed.", {
			backupId: options.backupId,
			cause: error,
		});
	}
}

export async function applyMachineFilesFromBackup(options: {
	agentDirectory: string;
	machineRoot: string;
	backupId: string;
	applySet: Readonly<MachineApplySet>;
	operations?: MachineApplyOperations;
	signal?: AbortSignal;
	verifyFinal?: boolean;
}): Promise<MachineApplySuccess> {
	const operations = options.operations ?? createMachineApplyOperations();
	const metadata = await verifyBackup({
		agentDirectory: options.agentDirectory,
		backupId: options.backupId,
		operations,
	});
	if (metadata.planId !== options.applySet.planId) {
		throw new MachineApplyError("Backup does not match the confirmed machine plan.", { backupId: options.backupId });
	}
	try {
		for (const operation of options.applySet.operations) {
			options.signal?.throwIfAborted();
			if (options.applySet.deferredPaths.includes(operation.path)) continue;
			if (operation.kind === "write") {
				await writeMachineFile(operations, options.machineRoot, operation.path, operation.final);
			} else {
				await deleteMachineFile(operations, options.machineRoot, operation.path);
			}
			options.signal?.throwIfAborted();
		}
		if (options.verifyFinal) {
			await verifyMachineTree({ operations, machineRoot: options.machineRoot, applySet: options.applySet });
		}
	} catch (error) {
		const manualRecoveryPaths = await restoreBackup({
			agentDirectory: options.agentDirectory,
			machineRoot: options.machineRoot,
			metadata,
			operations,
		});
		if (manualRecoveryPaths.length > 0) {
			throw new MachineApplyError("Machine apply and automatic restore failed. Manual recovery is required.", {
				backupId: options.backupId,
				manualRecoveryPaths,
				cause: error,
			});
		}
		throw new MachineApplyError("Machine apply failed. THIS MACHINE was restored from the verified backup.", {
			backupId: options.backupId,
			restored: true,
			cause: error,
		});
	}
	return {
		status: "success",
		planId: options.applySet.planId,
		backupId: options.backupId,
		appliedPaths: Object.freeze(options.applySet.operations.map((operation) => operation.path)),
	};
}

export async function verifyMachineApplySet(options: {
	machineRoot: string;
	applySet: Readonly<MachineApplySet>;
	operations?: MachineApplyOperations;
}): Promise<void> {
	await verifyMachineTree({
		operations: options.operations ?? createMachineApplyOperations(),
		machineRoot: options.machineRoot,
		applySet: options.applySet,
	});
}

export async function applyMachinePlan(options: {
	agentDirectory: string;
	machineRoot: string;
	backupId: string;
	createdAt: string;
	applySet: Readonly<MachineApplySet>;
	operations?: MachineApplyOperations;
	signal?: AbortSignal;
}): Promise<MachineApplySuccess> {
	await createVerifiedMachineBackup(options);
	return applyMachineFilesFromBackup({ ...options, verifyFinal: true });
}

export async function cleanupMachineBackups(options: {
	agentDirectory: string;
	retain: number;
	operations?: MachineApplyOperations;
}): Promise<BackupCleanupResult> {
	const operations = options.operations ?? createMachineApplyOperations();
	const paths = getConfigSyncPaths(options.agentDirectory);
	const entries = await operations.readdir(paths.backupsDirectory);
	const valid: BackupMetadata[] = [];
	const failedBackupIds: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			valid.push(await verifyBackup({ agentDirectory: options.agentDirectory, backupId: entry.name, operations }));
		} catch {
			failedBackupIds.push(entry.name);
		}
	}
	valid.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	const keepCount = Math.max(1, options.retain);
	const keptBackupIds = valid.slice(0, keepCount).map((backup) => backup.backupId);
	const deletedBackupIds: string[] = [];
	for (const backup of valid.slice(keepCount)) {
		try {
			await operations.rm(backupRoot(options.agentDirectory, backup.backupId));
			deletedBackupIds.push(backup.backupId);
		} catch {
			failedBackupIds.push(backup.backupId);
		}
	}
	return {
		keptBackupIds: Object.freeze(keptBackupIds),
		deletedBackupIds: Object.freeze(deletedBackupIds),
		failedBackupIds: Object.freeze(failedBackupIds.sort()),
	};
}
