import { hash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import stableStringify from "json-stable-stringify";
import { lock } from "proper-lockfile";
import { ensureConfigSyncDirectories, getConfigSyncPaths } from "./config.ts";
import { nextTransactionRecoveryStep, TransactionLockedError } from "./coordinator.ts";
import { discoverFileInventory, type InventoryFile, sameExactFile } from "./files.ts";
import { getBackupMetadataPath, loadJournal } from "./state.ts";
import { restoreVerifiedMachineBackup, verifyBackup } from "./transaction.ts";
import type { BackupMetadata, FileFingerprint, JournalStage } from "./types.ts";
import { type FormattedPlanRow, formatFixedSections } from "./ui.ts";

export interface IncompleteJournal {
	backupId?: string;
	message: string;
	planId: string;
	publishedCommit?: string;
	stage: JournalStage;
	nextStep: ReturnType<typeof nextTransactionRecoveryStep>;
}

export type RecoveryChoice = "resume" | "rollback_machine" | "stop";

export const RECOVERY_CHOICES = Object.freeze([
	{ choice: "resume" as const, label: "RESUME THE RECORDED OPERATION" },
	{ choice: "rollback_machine" as const, label: "ROLL BACK THIS MACHINE" },
	{ choice: "stop" as const, label: "STOP WITHOUT CHANGES" },
]);

export type RecoveryDecisionResult =
	| { status: "not_required" }
	| { status: "decision_required"; recovery: Readonly<IncompleteJournal> }
	| { status: "cancelled"; recovery: Readonly<IncompleteJournal> }
	| { status: "selected"; recovery: Readonly<IncompleteJournal>; choice: RecoveryChoice };

export interface BackupListItem {
	backupId: string;
	createdAt?: string;
	entryCount?: number;
	planId?: string;
	status: "valid" | "invalid";
}

export type RestoreActionName = "WRITE ON THIS MACHINE" | "DELETE FROM THIS MACHINE";

export interface RestoreAction {
	action: RestoreActionName;
	currentSha256: string | null;
	executable: boolean | null;
	path: string;
	resultSha256: string | null;
}

export interface RestorePlan {
	actions: readonly Readonly<RestoreAction>[];
	backupId: string;
	createdAt: string;
	currentTree: Readonly<Record<string, Readonly<FileFingerprint>>>;
	finalTree: Readonly<Record<string, Readonly<FileFingerprint>>>;
	planId: string;
	schemaVersion: 1;
	shortPlanId: string;
	sourcePlanId: string;
}

export interface RestoreAuthorization {
	planId: string;
}

export type RestoreReviewResult =
	| { status: "plan_only"; plan: Readonly<RestorePlan>; text: string }
	| { status: "cancelled"; plan: Readonly<RestorePlan> }
	| { status: "id_mismatch"; plan: Readonly<RestorePlan> }
	| { status: "confirmed"; plan: Readonly<RestorePlan>; authorization: Readonly<RestoreAuthorization> };

export class RestorePlanExpiredError extends Error {
	constructor() {
		super("PLAN EXPIRED: The restore plan no longer matches THIS MACHINE or its verified backup.");
		this.name = "RestorePlanExpiredError";
	}
}

export function getActiveAgentDirectory(
	environment: { PI_CODING_AGENT_DIR?: string } = process.env,
	homeDirectory = homedir(),
): string {
	return resolve(environment.PI_CODING_AGENT_DIR ?? resolve(homeDirectory, ".pi", "agent"));
}

export function formatRecoveryNotice(recovery: Readonly<IncompleteJournal>): string {
	return `RECOVERY REQUIRED: Plan ${recovery.planId} stopped after ${recovery.stage}.`;
}

export async function detectIncompleteJournal(
	agentDirectory: string,
): Promise<Readonly<IncompleteJournal> | undefined> {
	const journal = await loadJournal(agentDirectory);
	if (!journal || journal.stage === "complete") return undefined;
	const recovery = {
		backupId: journal.backupId,
		message: "",
		nextStep: nextTransactionRecoveryStep(journal.stage),
		planId: journal.planId,
		publishedCommit: journal.publishedCommit,
		stage: journal.stage,
	};
	return Object.freeze({ ...recovery, message: formatRecoveryNotice(recovery) });
}

export async function requestRecoveryDecision(options: {
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">;
	recovery: Readonly<IncompleteJournal> | undefined;
}): Promise<RecoveryDecisionResult> {
	if (!options.recovery) return { status: "not_required" };
	if (!options.ctx.hasUI) return { status: "decision_required", recovery: options.recovery };
	const selected = await options.ctx.ui.select(
		formatRecoveryNotice(options.recovery),
		RECOVERY_CHOICES.map((choice) => choice.label),
	);
	const choice = RECOVERY_CHOICES.find((candidate) => candidate.label === selected)?.choice;
	return choice
		? { status: "selected", recovery: options.recovery, choice }
		: { status: "cancelled", recovery: options.recovery };
}

export async function listMachineBackups(agentDirectory: string): Promise<readonly Readonly<BackupListItem>[]> {
	const backupsDirectory = getConfigSyncPaths(agentDirectory).backupsDirectory;
	let entries: Dirent[];
	try {
		entries = await readdir(backupsDirectory, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return Object.freeze([]);
		throw error;
	}
	const backups: BackupListItem[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const metadata = await verifyBackup({ agentDirectory, backupId: entry.name });
			backups.push({
				backupId: metadata.backupId,
				createdAt: metadata.createdAt,
				entryCount: metadata.entries.length,
				planId: metadata.planId,
				status: "valid",
			});
		} catch {
			backups.push({ backupId: entry.name, status: "invalid" });
		}
	}
	return Object.freeze(
		backups
			.sort(
				(left, right) =>
					(right.createdAt ?? "").localeCompare(left.createdAt ?? "") || left.backupId.localeCompare(right.backupId),
			)
			.map((backup) => Object.freeze(backup)),
	);
}

function fingerprint(file: Readonly<InventoryFile>): Readonly<FileFingerprint> {
	return Object.freeze({
		comparisonSha256: file.comparisonSha256,
		executable: file.executable,
		sha256: file.sha256,
	});
}

function fingerprintTree(
	files: Readonly<Record<string, Readonly<InventoryFile>>>,
): Readonly<Record<string, Readonly<FileFingerprint>>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(files)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([path, file]) => [path, fingerprint(file)]),
		),
	);
}

function createRestorePlanId(data: Omit<RestorePlan, "planId" | "shortPlanId">): string {
	const securityData: Record<string, unknown> = { ...data };
	delete securityData.createdAt;
	const canonical = stableStringify(securityData);
	if (canonical === undefined) throw new Error("Cannot create the restore plan ID.");
	return hash("sha256", canonical, "hex");
}

function freezeRestorePlan(data: Omit<RestorePlan, "planId" | "shortPlanId">): Readonly<RestorePlan> {
	const planId = createRestorePlanId(data);
	return Object.freeze({ ...data, planId, shortPlanId: planId.slice(0, 12) });
}

function backupFilesRoot(agentDirectory: string, metadata: Readonly<BackupMetadata>): string {
	return resolve(dirname(getBackupMetadataPath(agentDirectory, metadata.backupId)), "files");
}

export async function buildRestorePlan(options: {
	agentDirectory: string;
	machineRoot: string;
	backupId: string;
	createdAt: string;
	signal?: AbortSignal;
}): Promise<Readonly<RestorePlan>> {
	options.signal?.throwIfAborted();
	const metadata = await verifyBackup({ agentDirectory: options.agentDirectory, backupId: options.backupId });
	const paths = metadata.entries.map((entry) => entry.path);
	const existingBackupPaths = metadata.entries.filter((entry) => entry.existed).map((entry) => entry.path);
	const current = await discoverFileInventory(options.machineRoot, "machine", {
		managedPatterns: paths,
		signal: options.signal,
	});
	const backup = await discoverFileInventory(backupFilesRoot(options.agentDirectory, metadata), "machine", {
		managedPatterns: existingBackupPaths,
		signal: options.signal,
	});
	const actions: RestoreAction[] = [];
	for (const entry of metadata.entries) {
		const currentFile = current.files[entry.path];
		const finalFile = entry.existed ? backup.files[entry.path] : undefined;
		if (sameExactFile(currentFile, finalFile)) continue;
		if (finalFile) {
			actions.push({
				action: "WRITE ON THIS MACHINE",
				currentSha256: currentFile?.sha256 ?? null,
				executable: finalFile.executable,
				path: entry.path,
				resultSha256: finalFile.sha256,
			});
		} else if (currentFile) {
			actions.push({
				action: "DELETE FROM THIS MACHINE",
				currentSha256: currentFile.sha256,
				executable: null,
				path: entry.path,
				resultSha256: null,
			});
		}
	}
	return freezeRestorePlan({
		actions: Object.freeze(
			actions.sort((left, right) => left.path.localeCompare(right.path)).map((action) => Object.freeze(action)),
		),
		backupId: metadata.backupId,
		createdAt: options.createdAt,
		currentTree: fingerprintTree(current.files),
		finalTree: fingerprintTree(backup.files),
		schemaVersion: 1,
		sourcePlanId: metadata.planId,
	});
}

function restoreActionText(action: Readonly<RestoreAction>): string {
	const result = action.resultSha256
		? `${action.path} on THIS MACHINE will match the verified backup.`
		: `${action.path} will not exist on THIS MACHINE.`;
	return `${action.action}: ${action.path} | Destination: THIS MACHINE | Result: ${result}`;
}

export function formatRestorePlanText(plan: Readonly<RestorePlan>, view: "restore-plan" | "receipt"): string {
	const actionRows = plan.actions.map((action) => ({
		actionKey: `${action.action}:${action.path}`,
		section: "FINAL RESULT" as const,
		text: restoreActionText(action),
	}));
	const deletionRows = plan.actions
		.filter((action) => action.action === "DELETE FROM THIS MACHINE")
		.map((action) => ({
			actionKey: `${action.action}:${action.path}`,
			section: "DELETIONS" as const,
			text: restoreActionText(action),
		}));
	const rows: FormattedPlanRow[] = [
		{
			section: "FINAL RESULT",
			text: `${view === "restore-plan" ? "Final immutable restore plan" : "Completion receipt"} ${plan.planId} (${plan.shortPlanId})`,
		},
		{ section: "FINAL RESULT", text: `Verified backup: ${plan.backupId}` },
		...actionRows,
		...deletionRows,
		{ section: "WILL NOT HAPPEN", text: "SHARED REPOSITORY will not change. | Destination: SHARED REPOSITORY" },
		{ section: "WILL NOT HAPPEN", text: "No path outside the restore plan will change. | Destination: NONE" },
	];
	return formatFixedSections(rows);
}

export function authorizeRestorePlan(
	plan: Readonly<RestorePlan>,
	suppliedPlanId: string,
): Readonly<RestoreAuthorization> {
	if (suppliedPlanId !== plan.planId) throw new Error("Exact restore plan ID does not match the immutable plan.");
	return Object.freeze({ planId: plan.planId });
}

export async function reviewRestorePlan(options: {
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">;
	plan: Readonly<RestorePlan>;
}): Promise<RestoreReviewResult> {
	const text = formatRestorePlanText(options.plan, "restore-plan");
	if (!options.ctx.hasUI) return { status: "plan_only", plan: options.plan, text };
	const selected = await options.ctx.ui.select(text, ["Enter exact restore plan ID", "Cancel without changes"]);
	if (selected !== "Enter exact restore plan ID") return { status: "cancelled", plan: options.plan };
	const suppliedPlanId = await options.ctx.ui.input("Enter exact restore plan ID", options.plan.planId);
	if (suppliedPlanId !== options.plan.planId) return { status: "id_mismatch", plan: options.plan };
	return {
		status: "confirmed",
		plan: options.plan,
		authorization: authorizeRestorePlan(options.plan, suppliedPlanId),
	};
}

function assertRestorePlanIntegrity(plan: Readonly<RestorePlan>): void {
	const data: Record<string, unknown> = { ...plan };
	delete data.planId;
	delete data.shortPlanId;
	const planId = createRestorePlanId(data as Omit<RestorePlan, "planId" | "shortPlanId">);
	if (plan.planId !== planId || plan.shortPlanId !== planId.slice(0, 12)) throw new RestorePlanExpiredError();
}

export async function executeRestorePlan(options: {
	agentDirectory: string;
	machineRoot: string;
	plan: Readonly<RestorePlan>;
	authorization: Readonly<RestoreAuthorization>;
	signal?: AbortSignal;
}): Promise<{ status: "success"; planId: string; restoredPaths: readonly string[]; receipt: string }> {
	if (options.authorization.planId !== options.plan.planId) throw new RestorePlanExpiredError();
	assertRestorePlanIntegrity(options.plan);
	const paths = await ensureConfigSyncDirectories(options.agentDirectory);
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lock(paths.root, { realpath: false, retries: 0 });
	} catch (error) {
		throw new TransactionLockedError({ cause: error });
	}
	try {
		const current = await buildRestorePlan({
			agentDirectory: options.agentDirectory,
			machineRoot: options.machineRoot,
			backupId: options.plan.backupId,
			createdAt: options.plan.createdAt,
			signal: options.signal,
		});
		if (stableStringify(current) !== stableStringify(options.plan)) throw new RestorePlanExpiredError();
		const result = await restoreVerifiedMachineBackup({
			agentDirectory: options.agentDirectory,
			machineRoot: options.machineRoot,
			backupId: options.plan.backupId,
			expectedPlanId: options.plan.sourcePlanId,
		});
		return {
			status: "success",
			planId: options.plan.planId,
			restoredPaths: result.restoredPaths,
			receipt: formatRestorePlanText(options.plan, "receipt"),
		};
	} finally {
		await release?.();
	}
}
