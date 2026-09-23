import { hash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import stableStringify from "json-stable-stringify";
import { packageSetFingerprint } from "./packages.ts";
import { parseSettings } from "./settings.ts";
import { loadJournal, saveJournal } from "./state.ts";
import { createMachineApplyOperations, type MachineApplyOperations } from "./transaction.ts";
import type { LocalPolicy, OperationJournal, PlanArtifact } from "./types.ts";
import type { PlanExecutionAuthorization } from "./ui.ts";

export type PackageExec = ExtensionAPI["exec"];
export type ConfirmedPackageAction = PlanArtifact["actions"][number];

export interface PackageRollbackError {
	actionId: string;
	message: string;
}

export interface PackageExecutionSuccess {
	status: "success";
	planId: string;
	actionIds: readonly string[];
}

export class PackageExecutionError extends Error {
	readonly originalError: string;
	readonly rollbackErrors: readonly Readonly<PackageRollbackError>[];

	constructor(originalError: string, rollbackErrors: readonly Readonly<PackageRollbackError>[] = []) {
		super(originalError);
		this.name = "PackageExecutionError";
		this.originalError = originalError;
		this.rollbackErrors = Object.freeze(rollbackErrors.map((error) => Object.freeze({ ...error })));
	}
}

const OPERATION_ORDER = Object.freeze({ remove: 0, update: 1, install: 2 });
const DEFAULT_PACKAGE_TIMEOUT_MS = 120_000;

export function packageActionDecisionId(action: Readonly<ConfirmedPackageAction>): string {
	const value = stableStringify({
		operation: action.packageOperation ?? null,
		identity: action.path,
		exactSource: action.exactPackageSource ?? null,
		normalizedSource: action.normalizedPackageSource ?? null,
		previousExactSource: action.previousExactPackageSource ?? null,
		previousNormalizedSource: action.previousNormalizedPackageSource ?? null,
	});
	if (value === undefined) throw new PackageExecutionError("Cannot identify package action.");
	return hash("sha256", value, "hex");
}

function validatePackageAction(action: Readonly<ConfirmedPackageAction>): void {
	if (
		!action.codeExecution ||
		action.destination !== "THIS MACHINE" ||
		action.direction !== "shared-to-machine" ||
		!action.packageOperation ||
		!action.exactPackageSource ||
		!action.normalizedPackageSource
	) {
		throw new PackageExecutionError(`Invalid confirmed package action: ${action.path}`);
	}
	if (action.packageOperation === "remove") {
		if (action.action !== "REMOVE PACKAGE FROM THIS MACHINE") {
			throw new PackageExecutionError(`Invalid confirmed package removal: ${action.path}`);
		}
	} else if (action.action !== "INSTALL PACKAGE ON THIS MACHINE") {
		throw new PackageExecutionError(`Invalid confirmed package installation: ${action.path}`);
	}
	if (
		action.packageOperation === "update" &&
		(!action.previousExactPackageSource || !action.previousNormalizedPackageSource)
	) {
		throw new PackageExecutionError(`Confirmed package update has no prior exact source: ${action.path}`);
	}
}

function confirmedPackageActions(plan: Readonly<PlanArtifact>): readonly Readonly<ConfirmedPackageAction>[] {
	const actions = plan.actions.filter((action) => action.risk === "package");
	for (const action of actions) validatePackageAction(action);
	return Object.freeze(
		[...actions].sort(
			(left, right) =>
				OPERATION_ORDER[left.packageOperation as keyof typeof OPERATION_ORDER] -
					OPERATION_ORDER[right.packageOperation as keyof typeof OPERATION_ORDER] ||
				left.normalizedPackageSource?.localeCompare(right.normalizedPackageSource ?? "") ||
				left.path.localeCompare(right.path),
		),
	);
}

function validateApprovals(
	plan: Readonly<PlanArtifact>,
	actions: readonly Readonly<ConfirmedPackageAction>[],
): readonly Readonly<PlanArtifact["decisions"][number]>[] {
	const decisions = plan.decisions.filter((decision) => decision.category === "package");
	if (decisions.length !== actions.length)
		throw new PackageExecutionError("Package approval set is incomplete or stale.");
	const byId = new Map<string, PlanArtifact["decisions"][number]>();
	for (const decision of decisions) {
		if (byId.has(decision.id)) throw new PackageExecutionError("Package approval set contains a duplicate decision.");
		byId.set(decision.id, decision);
	}
	const validated = actions.map((action) => {
		const id = packageActionDecisionId(action);
		const decision = byId.get(id);
		if (
			decision?.choice !== "approve" ||
			decision.exactSource !== action.exactPackageSource ||
			decision.normalizedSource !== action.normalizedPackageSource ||
			decision.previousExactSource !== action.previousExactPackageSource ||
			decision.previousNormalizedSource !== action.previousNormalizedPackageSource
		) {
			throw new PackageExecutionError(`Package approval does not match the exact planned source: ${action.path}`);
		}
		byId.delete(id);
		return decision;
	});
	if (byId.size > 0) throw new PackageExecutionError("Package approval set contains stale decisions.");
	return Object.freeze(validated);
}

function packageMap(settings: ReturnType<typeof parseSettings>): Map<string, (typeof settings.packages)[number]> {
	return new Map(settings.packages.map((entry) => [entry.identity, entry]));
}

function validateExactSources(options: {
	plan: Readonly<PlanArtifact>;
	actions: readonly Readonly<ConfirmedPackageAction>[];
	currentSettingsText: string;
	plannedSettingsText: string;
	policy: LocalPolicy;
	allowAlreadyPlanned?: boolean;
}): void {
	const current = parseSettings(options.currentSettingsText, { source: "machine", policy: options.policy });
	const planned = parseSettings(options.plannedSettingsText, { source: "machine", policy: options.policy });
	if (packageSetFingerprint(planned.packages) !== options.plan.packageFingerprint) {
		throw new PackageExecutionError("Planned package sources do not match the confirmed plan.");
	}
	const plannedSettings = options.plan.finalMachineTree["agent/settings.json"];
	if (!plannedSettings || plannedSettings.sha256 !== hash("sha256", options.plannedSettingsText, "hex")) {
		throw new PackageExecutionError("Exact planned settings do not match the confirmed plan.");
	}
	if (
		options.allowAlreadyPlanned &&
		hash("sha256", options.currentSettingsText, "hex") === hash("sha256", options.plannedSettingsText, "hex")
	)
		return;
	const currentByIdentity = packageMap(current);
	const plannedByIdentity = packageMap(planned);
	for (const action of options.actions) {
		const currentPackage = currentByIdentity.get(action.path);
		const plannedPackage = plannedByIdentity.get(action.path);
		switch (action.packageOperation) {
			case "install":
				if (currentPackage || plannedPackage?.exactSource !== action.exactPackageSource) {
					throw new PackageExecutionError(`Package install source changed after confirmation: ${action.path}`);
				}
				break;
			case "update":
				if (
					currentPackage?.exactSource !== action.previousExactPackageSource ||
					plannedPackage?.exactSource !== action.exactPackageSource
				) {
					throw new PackageExecutionError(`Package update source changed after confirmation: ${action.path}`);
				}
				break;
			case "remove":
				if (currentPackage?.exactSource !== action.exactPackageSource || plannedPackage) {
					throw new PackageExecutionError(`Package removal source changed after confirmation: ${action.path}`);
				}
				break;
		}
	}
}

async function requireJournal(agentDirectory: string, planId: string): Promise<OperationJournal> {
	const journal = await loadJournal(agentDirectory);
	if (!journal || journal.planId !== planId || journal.stage !== "backup_verified") {
		throw new PackageExecutionError("Operation journal is not ready for the confirmed package plan.");
	}
	return journal;
}

async function appendJournalEvent(options: {
	agentDirectory: string;
	journal: OperationJournal;
	action: Readonly<ConfirmedPackageAction>;
	status: NonNullable<OperationJournal["packageEvents"]>[number]["status"];
	now(): string;
}): Promise<OperationJournal> {
	const timestamp = options.now();
	const journal: OperationJournal = {
		...options.journal,
		packageEvents: [
			...(options.journal.packageEvents ?? []),
			{
				actionId: packageActionDecisionId(options.action),
				operation: options.action.packageOperation as "install" | "update" | "remove",
				status: options.status,
				timestamp,
			},
		],
		updatedAt: timestamp,
	};
	await saveJournal(options.agentDirectory, journal);
	return journal;
}

function forwardArguments(action: Readonly<ConfirmedPackageAction>): ["install" | "remove", string] {
	return action.packageOperation === "remove"
		? ["remove", action.exactPackageSource as string]
		: ["install", action.exactPackageSource as string];
}

function rollbackArguments(action: Readonly<ConfirmedPackageAction>): ["install" | "remove", string] {
	switch (action.packageOperation) {
		case "install":
			return ["remove", action.exactPackageSource as string];
		case "update":
			return ["install", action.previousExactPackageSource as string];
		case "remove":
			return ["install", action.exactPackageSource as string];
		default:
			throw new PackageExecutionError(`Unknown package rollback action: ${action.path}`);
	}
}

async function runPiPackageCommand(options: {
	exec: PackageExec;
	args: ["install" | "remove", string];
	cwd: string;
	timeout: number;
	signal?: AbortSignal;
}): Promise<void> {
	options.signal?.throwIfAborted();
	const result = await options.exec("pi", options.args, {
		cwd: options.cwd,
		signal: options.signal,
		timeout: options.timeout,
	});
	options.signal?.throwIfAborted();
	if (result.code !== 0 || result.killed) throw new PackageExecutionError(`pi ${options.args[0]} failed.`);
}

async function readOriginalSettings(
	operations: MachineApplyOperations,
	settingsPath: string,
): Promise<{ existed: boolean; content: Buffer; mode: number }> {
	try {
		const details = await operations.lstat(settingsPath);
		if (details.isSymbolicLink() || !details.isFile())
			throw new PackageExecutionError("settings.json is not a regular file.");
		return { existed: true, content: await operations.readFile(settingsPath), mode: details.mode & 0o777 };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { existed: false, content: Buffer.from("{}\n"), mode: 0o600 };
		}
		throw error;
	}
}

async function writeSettings(
	operations: MachineApplyOperations,
	settingsPath: string,
	content: Uint8Array,
	mode: number,
): Promise<void> {
	await operations.mkdir(dirname(settingsPath));
	await operations.writeAtomic(settingsPath, content, mode);
	if (process.platform !== "win32") await operations.chmod(settingsPath, mode);
	await operations.syncDirectory(dirname(settingsPath));
}

async function restoreSettings(options: {
	operations: MachineApplyOperations;
	settingsPath: string;
	original: { existed: boolean; content: Buffer; mode: number };
}): Promise<void> {
	if (options.original.existed) {
		await writeSettings(options.operations, options.settingsPath, options.original.content, options.original.mode);
		return;
	}
	try {
		await options.operations.unlink(options.settingsPath);
		await options.operations.syncDirectory(dirname(options.settingsPath));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof PackageExecutionError) return error.originalError;
	if (error instanceof Error && error.name === "AbortError") return "Package execution was cancelled.";
	return "Package execution failed.";
}

export async function executeConfirmedPackagePlan(options: {
	exec: PackageExec;
	cwd: string;
	agentDirectory: string;
	machineRoot: string;
	plan: Readonly<PlanArtifact>;
	authorization: Readonly<PlanExecutionAuthorization>;
	plannedSettingsText: string;
	policy: LocalPolicy;
	signal?: AbortSignal;
	timeoutMs?: number;
	operations?: MachineApplyOperations;
	now?: () => string;
}): Promise<PackageExecutionSuccess> {
	if (options.authorization.planId !== options.plan.planId) {
		throw new PackageExecutionError("Execution authorization does not match the confirmed package plan.");
	}
	const actions = confirmedPackageActions(options.plan);
	validateApprovals(options.plan, actions);
	const timeout = options.timeoutMs ?? DEFAULT_PACKAGE_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeout) || timeout < 1)
		throw new PackageExecutionError("Package command timeout is invalid.");
	const operations = options.operations ?? createMachineApplyOperations();
	const settingsPath = resolve(options.machineRoot, "agent/settings.json");
	const original = await readOriginalSettings(operations, settingsPath);
	const originalSettingsText = original.content.toString("utf8");
	let journal = await requireJournal(options.agentDirectory, options.plan.planId);
	const now = options.now ?? (() => new Date().toISOString());
	const latestStatus = new Map<string, NonNullable<OperationJournal["packageEvents"]>[number]["status"]>();
	for (const event of journal.packageEvents ?? []) latestStatus.set(event.actionId, event.status);
	for (const status of latestStatus.values()) {
		if (status === "started" || status === "rollback_started" || status === "rollback_failed") {
			throw new PackageExecutionError("A recorded package action has an unknown final state.");
		}
	}
	const allActionsRecorded = actions.every(
		(action) => latestStatus.get(packageActionDecisionId(action)) === "completed",
	);
	validateExactSources({
		plan: options.plan,
		actions,
		currentSettingsText: originalSettingsText,
		plannedSettingsText: options.plannedSettingsText,
		policy: options.policy,
		allowAlreadyPlanned: allActionsRecorded,
	});
	const completed: Readonly<ConfirmedPackageAction>[] = actions.filter(
		(action) => latestStatus.get(packageActionDecisionId(action)) === "completed",
	);
	try {
		for (const action of actions) {
			const previousStatus = latestStatus.get(packageActionDecisionId(action));
			if (previousStatus === "completed") continue;
			options.signal?.throwIfAborted();
			journal = await appendJournalEvent({
				agentDirectory: options.agentDirectory,
				journal,
				action,
				status: "started",
				now,
			});
			await runPiPackageCommand({
				exec: options.exec,
				args: forwardArguments(action),
				cwd: options.cwd,
				timeout,
				signal: options.signal,
			});
			completed.push(action);
			journal = await appendJournalEvent({
				agentDirectory: options.agentDirectory,
				journal,
				action,
				status: "completed",
				now,
			});
		}
		await writeSettings(operations, settingsPath, Buffer.from(options.plannedSettingsText), original.mode);
		const writtenSettings = await operations.readFile(settingsPath);
		if (!writtenSettings.equals(Buffer.from(options.plannedSettingsText))) {
			throw new PackageExecutionError("Exact planned settings verification failed.");
		}
		const parsedWrittenSettings = parseSettings(writtenSettings.toString("utf8"), {
			source: "machine",
			policy: options.policy,
		});
		if (packageSetFingerprint(parsedWrittenSettings.packages) !== options.plan.packageFingerprint) {
			throw new PackageExecutionError("Installed package declarations do not match settings.json.");
		}
	} catch (error) {
		const rollbackErrors: PackageRollbackError[] = [];
		for (const action of [...completed].reverse()) {
			const actionId = packageActionDecisionId(action);
			try {
				journal = await appendJournalEvent({
					agentDirectory: options.agentDirectory,
					journal,
					action,
					status: "rollback_started",
					now,
				});
				await runPiPackageCommand({
					exec: options.exec,
					args: rollbackArguments(action),
					cwd: options.cwd,
					timeout,
				});
				journal = await appendJournalEvent({
					agentDirectory: options.agentDirectory,
					journal,
					action,
					status: "rolled_back",
					now,
				});
			} catch {
				rollbackErrors.push({ actionId, message: "Package rollback command failed." });
				try {
					journal = await appendJournalEvent({
						agentDirectory: options.agentDirectory,
						journal,
						action,
						status: "rollback_failed",
						now,
					});
				} catch {
					rollbackErrors.push({ actionId, message: "Package rollback journal update failed." });
				}
			}
		}
		try {
			await restoreSettings({ operations, settingsPath, original });
		} catch {
			rollbackErrors.push({
				actionId: hash("sha256", "settings.json", "hex"),
				message: "settings.json restore failed.",
			});
		}
		throw new PackageExecutionError(safeErrorMessage(error), rollbackErrors);
	}
	return {
		status: "success",
		planId: options.plan.planId,
		actionIds: Object.freeze(actions.map(packageActionDecisionId)),
	};
}
