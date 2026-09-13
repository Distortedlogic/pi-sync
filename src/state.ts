import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import stableStringify from "json-stable-stringify";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import writeFileAtomic from "write-file-atomic";
import { ensureConfigSyncDirectories, getConfigSyncPaths } from "./config.ts";
import {
	type BackupMetadata,
	BackupMetadataSchema,
	CONFIG_SYNC_SCHEMA_VERSION,
	type ConfigDocument,
	ConfigDocumentSchema,
	type OperationJournal,
	OperationJournalSchema,
	type PlanArtifact,
	PlanArtifactSchema,
	type StateDocument,
	StateDocumentSchema,
} from "./types.ts";

export class RecoveryRequiredError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`RECOVERY REQUIRED: ${message}`, options);
		this.name = "RecoveryRequiredError";
	}
}

function schemaVersionOf(value: unknown): unknown {
	return value && typeof value === "object" && "schemaVersion" in value
		? (value as { schemaVersion?: unknown }).schemaVersion
		: undefined;
}

export function validateArtifact<TSchemaType extends TSchema>(
	schema: TSchemaType,
	value: unknown,
	label: string,
): Static<TSchemaType> {
	const schemaVersion = schemaVersionOf(value);
	if (schemaVersion !== undefined && schemaVersion !== CONFIG_SYNC_SCHEMA_VERSION) {
		throw new RecoveryRequiredError(`Unsupported ${label} schema version. No migration was attempted.`);
	}
	if (!Value.Check(schema, value)) {
		throw new RecoveryRequiredError(`Invalid ${label}.`);
	}
	return value as Static<TSchemaType>;
}

export async function readArtifact<TSchemaType extends TSchema>(
	path: string,
	schema: TSchemaType,
	label: string,
): Promise<Static<TSchemaType> | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new RecoveryRequiredError(`Cannot read ${label}.`, { cause: error });
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new RecoveryRequiredError(`Invalid JSON in ${label}.`, { cause: error });
	}
	return validateArtifact(schema, value, label);
}

async function syncParentDirectory(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(dirname(path), "r");
		await handle.sync();
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (process.platform === "win32" && ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(String(code))) return;
		throw error;
	} finally {
		await handle?.close();
	}
}

export async function writeDurableJson(path: string, value: unknown): Promise<void> {
	const text = stableStringify(value, { space: 2 });
	if (text === undefined) throw new TypeError("Cannot serialize configuration data.");
	await mkdir(dirname(path), { recursive: true });
	await writeFileAtomic(path, `${text}\n`, { encoding: "utf8", fsync: true });
	await syncParentDirectory(path);
}

async function saveArtifact<TSchemaType extends TSchema>(
	agentDirectory: string,
	path: string,
	schema: TSchemaType,
	value: Static<TSchemaType>,
	label: string,
): Promise<void> {
	validateArtifact(schema, value, label);
	await ensureConfigSyncDirectories(agentDirectory);
	await writeDurableJson(path, value);
}

function requireSafeId(id: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new TypeError(`Invalid ${label}.`);
}

export function getPlanArtifactPath(agentDirectory: string, planId: string): string {
	requireSafeId(planId, "plan ID");
	return resolve(getConfigSyncPaths(agentDirectory).plansDirectory, `${planId}.json`);
}

export function getBackupMetadataPath(agentDirectory: string, backupId: string): string {
	requireSafeId(backupId, "backup ID");
	return resolve(getConfigSyncPaths(agentDirectory).backupsDirectory, backupId, "metadata.json");
}

export function loadConfig(agentDirectory: string): Promise<ConfigDocument | undefined> {
	return readArtifact(getConfigSyncPaths(agentDirectory).configFile, ConfigDocumentSchema, "configuration");
}

export function saveConfig(agentDirectory: string, value: ConfigDocument): Promise<void> {
	return saveArtifact(
		agentDirectory,
		getConfigSyncPaths(agentDirectory).configFile,
		ConfigDocumentSchema,
		value,
		"configuration",
	);
}

export function loadState(agentDirectory: string): Promise<StateDocument | undefined> {
	return readArtifact(getConfigSyncPaths(agentDirectory).stateFile, StateDocumentSchema, "state");
}

export function saveState(agentDirectory: string, value: StateDocument): Promise<void> {
	return saveArtifact(
		agentDirectory,
		getConfigSyncPaths(agentDirectory).stateFile,
		StateDocumentSchema,
		value,
		"state",
	);
}

export function loadJournal(agentDirectory: string): Promise<OperationJournal | undefined> {
	return readArtifact(getConfigSyncPaths(agentDirectory).journalFile, OperationJournalSchema, "operation journal");
}

export function saveJournal(agentDirectory: string, value: OperationJournal): Promise<void> {
	return saveArtifact(
		agentDirectory,
		getConfigSyncPaths(agentDirectory).journalFile,
		OperationJournalSchema,
		value,
		"operation journal",
	);
}

export function loadPlanArtifact(agentDirectory: string, planId: string): Promise<PlanArtifact | undefined> {
	return readArtifact(getPlanArtifactPath(agentDirectory, planId), PlanArtifactSchema, "plan artifact");
}

export function savePlanArtifact(agentDirectory: string, value: PlanArtifact): Promise<void> {
	return saveArtifact(
		agentDirectory,
		getPlanArtifactPath(agentDirectory, value.planId),
		PlanArtifactSchema,
		value,
		"plan artifact",
	);
}

export function loadBackupMetadata(agentDirectory: string, backupId: string): Promise<BackupMetadata | undefined> {
	return readArtifact(getBackupMetadataPath(agentDirectory, backupId), BackupMetadataSchema, "backup metadata");
}

export function saveBackupMetadata(agentDirectory: string, value: BackupMetadata): Promise<void> {
	return saveArtifact(
		agentDirectory,
		getBackupMetadataPath(agentDirectory, value.backupId),
		BackupMetadataSchema,
		value,
		"backup metadata",
	);
}
