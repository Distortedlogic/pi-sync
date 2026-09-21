import stableStringify from "json-stable-stringify";
import { lock } from "proper-lockfile";
import { ensureConfigSyncDirectories } from "./config.ts";
import { assertPlanArtifactIntegrity, planActionId } from "./plan.ts";
import { loadJournal, loadPlanArtifact, loadState, saveJournal, saveState } from "./state.ts";
import type { JournalStage, OperationJournal, PlanArtifact, StateDocument } from "./types.ts";
import { formatPlanText, type PlanExecutionAuthorization } from "./ui.ts";

export const TRANSACTION_JOURNAL_STAGES: readonly JournalStage[] = Object.freeze([
	"prepared",
	"candidate_created",
	"shared_published",
	"backup_verified",
	"packages_applied",
	"machine_files_applied",
	"final_verified",
	"secrets_restored",
	"state_committed",
	"complete",
]);

export type TransactionRecoveryStep =
	| "create_candidate"
	| "publish_or_bind_shared_commit"
	| "create_verified_backup"
	| "apply_machine_files"
	| "apply_packages"
	| "verify_final_machine"
	| "restore_secrets"
	| "commit_state"
	| "complete_journal"
	| "none";

export interface TransactionCandidate {
	candidateCommit: string;
}

export type TransactionPublishResult =
	| { status: "published"; publishedCommit: string }
	| { status: "plan_expired"; currentSharedCommit: string };

export interface MachineRestoreResult {
	restored: boolean;
	manualRecoveryPaths?: readonly string[];
}

export interface TransactionSteps {
	fetchAndRebuildPlan(options: {
		confirmedPlan: Readonly<PlanArtifact>;
		signal?: AbortSignal;
	}): Promise<Readonly<PlanArtifact>>;
	createAndValidateCandidate?(options: {
		plan: Readonly<PlanArtifact>;
		reviewedSharedCommit: string | null;
		signal?: AbortSignal;
	}): Promise<Readonly<TransactionCandidate>>;
	publishCandidate?(options: {
		plan: Readonly<PlanArtifact>;
		candidate: Readonly<TransactionCandidate>;
		signal?: AbortSignal;
	}): Promise<TransactionPublishResult>;
	createAndVerifyBackup?(options: {
		plan: Readonly<PlanArtifact>;
		signal?: AbortSignal;
	}): Promise<{ backupId: string }>;
	applyMachineFiles?(options: {
		plan: Readonly<PlanArtifact>;
		sharedCommit: string;
		backupId: string;
		signal?: AbortSignal;
	}): Promise<void>;
	applyPackages?(options: {
		plan: Readonly<PlanArtifact>;
		sharedCommit: string;
		backupId: string;
		signal?: AbortSignal;
	}): Promise<void>;
	verifyFinalMachine(options: {
		plan: Readonly<PlanArtifact>;
		sharedCommit: string;
		signal?: AbortSignal;
	}): Promise<void>;
	restoreSecrets(options: { plan: Readonly<PlanArtifact>; sharedCommit: string; signal?: AbortSignal }): Promise<void>;
	restoreMachine?(options: {
		plan: Readonly<PlanArtifact>;
		sharedCommit: string;
		backupId: string;
	}): Promise<Readonly<MachineRestoreResult>>;
}

export interface CompletionReceipt {
	planId: string;
	publishedCommit: string;
	completedActionIds: readonly string[];
	text: string;
}

export interface TransactionSuccess {
	status: "success";
	planId: string;
	publishedCommit: string;
	journal: Readonly<OperationJournal>;
	state: Readonly<StateDocument>;
	receipt: Readonly<CompletionReceipt>;
}

export class TransactionLockedError extends Error {
	constructor(options?: ErrorOptions) {
		super("Another configuration execution is active for THIS MACHINE.", options);
		this.name = "TransactionLockedError";
	}
}

export class TransactionPlanExpiredError extends Error {
	constructor() {
		super("PLAN EXPIRED: The confirmed plan no longer matches THIS MACHINE or SHARED REPOSITORY.");
		this.name = "TransactionPlanExpiredError";
	}
}

export class TransactionRecoveryRequiredError extends Error {
	readonly publishedCommit?: string;
	readonly backupId?: string;
	readonly restored: boolean;
	readonly manualRecoveryPaths: readonly string[];

	constructor(
		message: string,
		options: {
			publishedCommit?: string;
			backupId?: string;
			restored?: boolean;
			manualRecoveryPaths?: readonly string[];
			cause?: unknown;
		} = {},
	) {
		super(`RECOVERY REQUIRED: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "TransactionRecoveryRequiredError";
		this.publishedCommit = options.publishedCommit;
		this.backupId = options.backupId;
		this.restored = options.restored ?? false;
		this.manualRecoveryPaths = Object.freeze([...(options.manualRecoveryPaths ?? [])]);
	}
}

const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type ActionPhase = "shared" | "machine" | "packages" | "state";

function actionPhase(action: Readonly<PlanArtifact["actions"][number]>, plan: Readonly<PlanArtifact>): ActionPhase {
	if (action.risk === "conflict" || action.direction === "none") {
		throw new TransactionPlanExpiredError();
	}
	if (action.risk === "policy" || action.direction === "baseline-only") return "state";
	if (
		action.risk === "package" ||
		(action.path === "agent/settings.json" && plan.actions.some((entry) => entry.risk === "package"))
	) {
		return "packages";
	}
	if (action.direction === "machine-to-shared") return "shared";
	if (action.direction === "shared-to-machine" && action.destination === "THIS MACHINE") return "machine";
	throw new TransactionPlanExpiredError();
}

function actionIdsForPhase(plan: Readonly<PlanArtifact>, phase: ActionPhase): string[] {
	return plan.actions.filter((action) => actionPhase(action, plan) === phase).map(planActionId);
}

function allActionIds(plan: Readonly<PlanArtifact>): string[] {
	const ids = plan.actions.map((action) => {
		actionPhase(action, plan);
		return planActionId(action);
	});
	if (new Set(ids).size !== ids.length) throw new TransactionPlanExpiredError();
	return ids;
}

function mergeActionIds(current: readonly string[] | undefined, added: readonly string[]): string[] {
	return [...new Set([...(current ?? []), ...added])];
}

function semanticPlan(plan: Readonly<PlanArtifact>): string {
	const data: Record<string, unknown> = { ...plan };
	delete data.createdAt;
	delete data.remoteCheckedAt;
	delete data.planId;
	delete data.shortPlanId;
	return stableStringify(data) ?? "";
}

function validateCommit(commit: string, label: string): void {
	if (!COMMIT_PATTERN.test(commit)) throw new Error(`${label} is not a valid commit ID.`);
}

function validateBackupId(backupId: string): void {
	if (!BACKUP_ID_PATTERN.test(backupId)) throw new Error("Backup ID is invalid.");
}

function assertNextStage(current: JournalStage, next: JournalStage): void {
	const currentIndex = TRANSACTION_JOURNAL_STAGES.indexOf(current);
	if (TRANSACTION_JOURNAL_STAGES[currentIndex + 1] !== next) {
		throw new TransactionRecoveryRequiredError(`Invalid journal transition from ${current} to ${next}.`);
	}
}

export function nextTransactionRecoveryStep(stage: JournalStage): TransactionRecoveryStep {
	switch (stage) {
		case "prepared":
			return "create_candidate";
		case "candidate_created":
			return "publish_or_bind_shared_commit";
		case "shared_published":
			return "create_verified_backup";
		case "backup_verified":
			return "apply_packages";
		case "packages_applied":
			return "apply_machine_files";
		case "machine_files_applied":
			return "verify_final_machine";
		case "final_verified":
			return "restore_secrets";
		case "secrets_restored":
			return "commit_state";
		case "state_committed":
			return "complete_journal";
		case "complete":
			return "none";
	}
}

async function advanceJournal(options: {
	agentDirectory: string;
	journal: Readonly<OperationJournal>;
	next: JournalStage;
	plan: Readonly<PlanArtifact>;
	completedPhase?: ActionPhase;
	patch?: Partial<OperationJournal>;
	now(): string;
}): Promise<OperationJournal> {
	assertNextStage(options.journal.stage, options.next);
	const journal: OperationJournal = {
		...options.journal,
		...options.patch,
		completedActionIds: mergeActionIds(
			options.journal.completedActionIds,
			options.completedPhase ? actionIdsForPhase(options.plan, options.completedPhase) : [],
		),
		stage: options.next,
		updatedAt: options.now(),
	};
	await saveJournal(options.agentDirectory, journal);
	return journal;
}

async function requireCurrentJournal(
	agentDirectory: string,
	planId: string,
	stage: JournalStage,
): Promise<OperationJournal> {
	const journal = await loadJournal(agentDirectory);
	if (!journal || journal.planId !== planId || journal.stage !== stage) {
		throw new TransactionRecoveryRequiredError("The durable journal does not match the active transaction.");
	}
	return journal;
}

function buildNextState(
	current: Readonly<StateDocument>,
	plan: Readonly<PlanArtifact>,
	publishedCommit: string,
	backupId: string | undefined,
	now: string,
): StateDocument {
	return {
		...current,
		baseline: {
			commit: publishedCommit,
			files: Object.fromEntries(Object.entries(plan.finalSharedTree).map(([path, file]) => [path, { ...file }])),
		},
		lastBackupId: backupId ?? current.lastBackupId,
		lastSuccessTime: now,
		pendingOperation: null,
	};
}

function buildRecoveryState(options: {
	current: Readonly<StateDocument>;
	planId: string;
	journal: Readonly<OperationJournal>;
	publishedCommit: string;
	backupId?: string;
	publicationCompleted: boolean;
}): StateDocument {
	return {
		...options.current,
		lastBackupId: options.backupId ?? options.current.lastBackupId,
		pendingOperation: options.publicationCompleted
			? { kind: "pending_apply", planId: options.planId, publishedCommit: options.publishedCommit }
			: { kind: "recovery", planId: options.planId, stage: options.journal.stage },
	};
}

function createCompletionReceipt(
	plan: Readonly<PlanArtifact>,
	journal: Readonly<OperationJournal>,
): Readonly<CompletionReceipt> {
	if (journal.stage !== "complete" || !journal.publishedCommit) {
		throw new TransactionRecoveryRequiredError("The completion receipt has no completed journal.");
	}
	const completed = new Set(journal.completedActionIds ?? []);
	const expected = allActionIds(plan);
	if (completed.size !== expected.length || expected.some((id) => !completed.has(id))) {
		throw new TransactionRecoveryRequiredError("The completion receipt does not match completed journal actions.");
	}
	return Object.freeze({
		planId: plan.planId,
		publishedCommit: journal.publishedCommit,
		completedActionIds: Object.freeze(expected),
		text: formatPlanText(plan, "receipt", completed),
	});
}

interface TransactionExecutionOptions {
	agentDirectory: string;
	plan: Readonly<PlanArtifact>;
	authorization: Readonly<PlanExecutionAuthorization>;
	steps: TransactionSteps;
	signal?: AbortSignal;
	now(): string;
	onJournalStage?(journal: Readonly<OperationJournal>): Promise<void> | void;
	writeState(state: StateDocument): Promise<void>;
}

interface ApplyStageState {
	journal: OperationJournal;
	publishedCommit: string;
	backupId?: string;
	publicationCompleted: boolean;
}

async function runApplyStages(
	options: TransactionExecutionOptions,
	currentState: Readonly<StateDocument>,
	state: ApplyStageState,
): Promise<TransactionSuccess> {
	const plan = options.plan;
	const hasMachineFiles = actionIdsForPhase(plan, "machine").length > 0;
	const hasPackages = actionIdsForPhase(plan, "packages").length > 0;
	const hasMachineEffects = hasMachineFiles || hasPackages;
	let journal = { ...state.journal };
	let backupId = state.backupId;
	let nextState: StateDocument = { ...currentState };

	const recoverApply = async (error: unknown, machineEffectsStarted: boolean): Promise<never> => {
		let restored = !machineEffectsStarted;
		let manualRecoveryPaths: readonly string[] = [];
		if (machineEffectsStarted && backupId && options.steps.restoreMachine) {
			try {
				const result = await options.steps.restoreMachine({
					plan,
					sharedCommit: state.publishedCommit,
					backupId,
				});
				restored = result.restored;
				manualRecoveryPaths = result.manualRecoveryPaths ?? [];
			} catch {
				restored = false;
			}
		}
		const recoveryState = buildRecoveryState({
			current: currentState,
			planId: plan.planId,
			journal,
			publishedCommit: state.publishedCommit,
			backupId,
			publicationCompleted: state.publicationCompleted,
		});
		try {
			await options.writeState(recoveryState);
		} catch (stateError) {
			throw new TransactionRecoveryRequiredError(
				"APPLY failed and recovery state could not be recorded. The durable journal was retained.",
				{ publishedCommit: state.publishedCommit, backupId, restored, manualRecoveryPaths, cause: stateError },
			);
		}
		throw new TransactionRecoveryRequiredError(
			restored
				? "APPLY failed. THIS MACHINE was restored and the exact shared commit is pending."
				: "APPLY failed and THIS MACHINE needs manual recovery.",
			{ publishedCommit: state.publishedCommit, backupId, restored, manualRecoveryPaths, cause: error },
		);
	};

	while (journal.stage !== "complete") {
		switch (journal.stage) {
			case "shared_published": {
				try {
					if (hasMachineEffects) {
						const backup = await options.steps.createAndVerifyBackup?.({ plan, signal: options.signal });
						if (!backup) throw new Error("Verified backup was not created.");
						validateBackupId(backup.backupId);
						backupId = backup.backupId;
					}
					journal = await advanceJournal({
						agentDirectory: options.agentDirectory,
						journal,
						next: "backup_verified",
						plan,
						patch: backupId ? { backupId } : undefined,
						now: options.now,
					});
				} catch (error) {
					return recoverApply(error, false);
				}
				break;
			}
			case "backup_verified": {
				let machineEffectsStarted = false;
				try {
					if (hasPackages) {
						machineEffectsStarted = true;
						await options.steps.applyPackages?.({
							plan,
							sharedCommit: state.publishedCommit,
							backupId: backupId as string,
							signal: options.signal,
						});
						journal = await requireCurrentJournal(options.agentDirectory, plan.planId, "backup_verified");
					}
					journal = await advanceJournal({
						agentDirectory: options.agentDirectory,
						journal,
						next: "packages_applied",
						plan,
						completedPhase: "packages",
						now: options.now,
					});
				} catch (error) {
					return recoverApply(error, machineEffectsStarted);
				}
				break;
			}
			case "packages_applied": {
				let machineEffectsStarted = false;
				try {
					if (hasMachineFiles) {
						machineEffectsStarted = true;
						await options.steps.applyMachineFiles?.({
							plan,
							sharedCommit: state.publishedCommit,
							backupId: backupId as string,
							signal: options.signal,
						});
					}
					journal = await advanceJournal({
						agentDirectory: options.agentDirectory,
						journal,
						next: "machine_files_applied",
						plan,
						completedPhase: "machine",
						now: options.now,
					});
				} catch (error) {
					return recoverApply(error, machineEffectsStarted);
				}
				break;
			}
			case "machine_files_applied": {
				try {
					await options.steps.verifyFinalMachine({
						plan,
						sharedCommit: state.publishedCommit,
						signal: options.signal,
					});
					journal = await advanceJournal({
						agentDirectory: options.agentDirectory,
						journal,
						next: "final_verified",
						plan,
						now: options.now,
					});
				} catch (error) {
					return recoverApply(error, false);
				}
				break;
			}
			case "final_verified": {
				try {
					await options.steps.restoreSecrets({
						plan,
						sharedCommit: state.publishedCommit,
						signal: options.signal,
					});
					journal = await advanceJournal({
						agentDirectory: options.agentDirectory,
						journal,
						next: "secrets_restored",
						plan,
						now: options.now,
					});
				} catch (error) {
					throw new TransactionRecoveryRequiredError("Agent secret restore failed after managed file verification.", {
						publishedCommit: state.publishedCommit,
						backupId,
						cause: error,
					});
				}
				break;
			}
			case "secrets_restored": {
				nextState = buildNextState(currentState, plan, state.publishedCommit, backupId, options.now());
				try {
					await options.writeState(nextState);
					journal = await advanceJournal({
						agentDirectory: options.agentDirectory,
						journal,
						next: "state_committed",
						plan,
						completedPhase: "state",
						now: options.now,
					});
				} catch (error) {
					throw new TransactionRecoveryRequiredError(
						"APPLY verified, but baseline state or its journal could not be recorded. The durable journal was retained.",
						{ publishedCommit: state.publishedCommit, backupId, cause: error },
					);
				}
				break;
			}
			case "state_committed": {
				try {
					journal = await advanceJournal({
						agentDirectory: options.agentDirectory,
						journal,
						next: "complete",
						plan,
						now: options.now,
					});
				} catch (error) {
					throw new TransactionRecoveryRequiredError(
						"Baseline state is durable, but journal completion failed. The durable journal was retained.",
						{ publishedCommit: state.publishedCommit, backupId, cause: error },
					);
				}
				break;
			}
			default:
				throw new TransactionRecoveryRequiredError(`Journal stage ${journal.stage} cannot continue APPLY.`);
		}
		await options.onJournalStage?.(journal);
	}

	const receipt = createCompletionReceipt(plan, journal);
	return {
		status: "success",
		planId: plan.planId,
		publishedCommit: state.publishedCommit,
		journal: Object.freeze({ ...journal }),
		state: Object.freeze({ ...nextState }),
		receipt,
	};
}

async function resumeWithLock(
	options: TransactionExecutionOptions,
	currentState: Readonly<StateDocument>,
	initialJournal: Readonly<OperationJournal>,
): Promise<TransactionSuccess> {
	if (
		initialJournal.planId !== options.plan.planId ||
		![
			"backup_verified",
			"packages_applied",
			"machine_files_applied",
			"final_verified",
			"secrets_restored",
			"state_committed",
		].includes(initialJournal.stage)
	) {
		throw new TransactionRecoveryRequiredError(
			`Plan ${initialJournal.planId} stopped at ${initialJournal.stage}. This stage cannot resume file application.`,
		);
	}
	if (!initialJournal.publishedCommit) {
		throw new TransactionRecoveryRequiredError("The interrupted transaction has no recorded shared commit.");
	}
	validateCommit(initialJournal.publishedCommit, "Recorded SHARED REPOSITORY");
	const publishedCommit = initialJournal.publishedCommit;
	const hasMachineFiles = actionIdsForPhase(options.plan, "machine").length > 0;
	const hasPackages = actionIdsForPhase(options.plan, "packages").length > 0;
	const hasMachineEffects = hasMachineFiles || hasPackages;
	const backupId = initialJournal.backupId;
	if (hasMachineEffects && !backupId) {
		throw new TransactionRecoveryRequiredError("The interrupted transaction has no recorded verified backup.");
	}
	if (backupId) validateBackupId(backupId);
	if (initialJournal.stage === "backup_verified" && hasPackages && !options.steps.applyPackages) {
		throw new Error("Package APPLY step is missing.");
	}
	if (
		(initialJournal.stage === "backup_verified" || initialJournal.stage === "packages_applied") &&
		hasMachineFiles &&
		!options.steps.applyMachineFiles
	) {
		throw new Error("Machine file APPLY step is missing.");
	}

	return runApplyStages(options, currentState, {
		journal: initialJournal,
		publishedCommit,
		backupId,
		publicationCompleted: actionIdsForPhase(options.plan, "shared").length > 0,
	});
}

async function executeWithLock(options: TransactionExecutionOptions): Promise<TransactionSuccess> {
	options.signal?.throwIfAborted();
	if (options.authorization.planId !== options.plan.planId) throw new TransactionPlanExpiredError();
	assertPlanArtifactIntegrity(options.plan);
	allActionIds(options.plan);

	const storedPlan = await loadPlanArtifact(options.agentDirectory, options.plan.planId);
	if (!storedPlan || stableStringify(storedPlan) !== stableStringify(options.plan)) {
		throw new TransactionPlanExpiredError();
	}
	const currentState = await loadState(options.agentDirectory);
	if (!currentState) throw new TransactionRecoveryRequiredError("State is missing. No configuration was changed.");
	const existingJournal = await loadJournal(options.agentDirectory);
	if (existingJournal && existingJournal.stage !== "complete") {
		return resumeWithLock(options, currentState, existingJournal);
	}

	const requiresPublication = actionIdsForPhase(options.plan, "shared").length > 0;
	const hasMachineFiles = actionIdsForPhase(options.plan, "machine").length > 0;
	const hasPackages = actionIdsForPhase(options.plan, "packages").length > 0;
	const hasMachineEffects = hasMachineFiles || hasPackages;
	if (requiresPublication && (!options.steps.createAndValidateCandidate || !options.steps.publishCandidate)) {
		throw new Error("PUBLISH steps are missing.");
	}
	if (hasMachineEffects && (!options.steps.createAndVerifyBackup || !options.steps.restoreMachine)) {
		throw new Error("APPLY backup or restore step is missing.");
	}
	if (hasMachineFiles && !options.steps.applyMachineFiles) throw new Error("Machine file APPLY step is missing.");
	if (hasPackages && !options.steps.applyPackages) throw new Error("Package APPLY step is missing.");

	const rebuiltPlan = await options.steps.fetchAndRebuildPlan({
		confirmedPlan: options.plan,
		signal: options.signal,
	});
	assertPlanArtifactIntegrity(rebuiltPlan);
	if (semanticPlan(rebuiltPlan) !== semanticPlan(options.plan)) throw new TransactionPlanExpiredError();
	options.signal?.throwIfAborted();

	let journal: OperationJournal = {
		completedActionIds: [],
		planId: options.plan.planId,
		reviewedSharedCommit: options.plan.sharedCommit,
		schemaVersion: 1,
		stage: "prepared",
		updatedAt: options.now(),
	};
	await saveJournal(options.agentDirectory, journal);
	await options.onJournalStage?.(journal);

	let candidate: Readonly<TransactionCandidate> | undefined;
	if (requiresPublication) {
		candidate = await options.steps.createAndValidateCandidate?.({
			plan: options.plan,
			reviewedSharedCommit: options.plan.sharedCommit,
			signal: options.signal,
		});
		if (!candidate) throw new Error("Candidate validation did not return a commit.");
		validateCommit(candidate.candidateCommit, "Candidate");
	}
	journal = await advanceJournal({
		agentDirectory: options.agentDirectory,
		journal,
		next: "candidate_created",
		plan: options.plan,
		patch: candidate ? { candidateCommit: candidate.candidateCommit } : undefined,
		now: options.now,
	});
	await options.onJournalStage?.(journal);

	let publishedCommit: string;
	let publicationCompleted = false;
	if (requiresPublication) {
		const result = await options.steps.publishCandidate?.({
			plan: options.plan,
			candidate: candidate as Readonly<TransactionCandidate>,
			signal: options.signal,
		});
		if (!result) throw new Error("PUBLISH did not return a result.");
		if (result.status === "plan_expired") throw new TransactionPlanExpiredError();
		validateCommit(result.publishedCommit, "Published SHARED REPOSITORY");
		if (result.publishedCommit !== candidate?.candidateCommit) {
			throw new TransactionRecoveryRequiredError("SHARED REPOSITORY does not contain the exact candidate commit.", {
				publishedCommit: result.publishedCommit,
			});
		}
		publishedCommit = result.publishedCommit;
		publicationCompleted = true;
	} else {
		if (!options.plan.sharedCommit) throw new TransactionPlanExpiredError();
		validateCommit(options.plan.sharedCommit, "Reviewed SHARED REPOSITORY");
		publishedCommit = options.plan.sharedCommit;
	}

	try {
		journal = await advanceJournal({
			agentDirectory: options.agentDirectory,
			journal,
			next: "shared_published",
			plan: options.plan,
			completedPhase: "shared",
			patch: { publishedCommit },
			now: options.now,
		});
	} catch (error) {
		if (publicationCompleted) {
			const recoveryState = buildRecoveryState({
				current: currentState,
				planId: options.plan.planId,
				journal,
				publishedCommit,
				publicationCompleted,
			});
			await options.writeState(recoveryState);
			throw new TransactionRecoveryRequiredError("PUBLISH completed, but its journal update failed.", {
				publishedCommit,
				cause: error,
			});
		}
		throw error;
	}
	await options.onJournalStage?.(journal);

	return runApplyStages(options, currentState, { journal, publishedCommit, publicationCompleted });
}

export async function executeConfirmedTransaction(options: {
	agentDirectory: string;
	plan: Readonly<PlanArtifact>;
	authorization: Readonly<PlanExecutionAuthorization>;
	steps: TransactionSteps;
	signal?: AbortSignal;
	now?: () => string;
	onJournalStage?(journal: Readonly<OperationJournal>): Promise<void> | void;
	writeState?(state: StateDocument): Promise<void>;
}): Promise<TransactionSuccess> {
	const paths = await ensureConfigSyncDirectories(options.agentDirectory);
	options.signal?.throwIfAborted();
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lock(paths.root, { realpath: false, retries: 0 });
	} catch (error) {
		throw new TransactionLockedError({ cause: error });
	}
	try {
		return await executeWithLock({
			...options,
			now: options.now ?? (() => new Date().toISOString()),
			writeState: options.writeState ?? ((state) => saveState(options.agentDirectory, state)),
		});
	} finally {
		await release?.();
	}
}
