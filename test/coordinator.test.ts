import { describe, expect, it, vi } from "vitest";
import {
	executeConfirmedTransaction,
	nextTransactionRecoveryStep,
	TRANSACTION_JOURNAL_STAGES,
	TransactionLockedError,
	TransactionPlanExpiredError,
	TransactionRecoveryRequiredError,
	type TransactionSteps,
} from "../src/coordinator.ts";
import { type BuildPlanArtifactOptions, buildPlanArtifact, type PlanArtifactAction } from "../src/plan.ts";
import { loadJournal, loadState, savePlanArtifact, saveState } from "../src/state.ts";
import type { JournalStage, PlanArtifact, StateDocument } from "../src/types.ts";
import { authorizePlanExecution } from "../src/ui.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const COMMIT = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const HASHES = ["a", "b", "c", "d", "e", "f"].map((value) => value.repeat(64));

function action(overrides: Partial<PlanArtifactAction>): PlanArtifactAction {
	return {
		action: "WRITE IN SHARED REPOSITORY",
		codeExecution: false,
		destination: "SHARED REPOSITORY",
		direction: "machine-to-shared",
		finalResult: "shared.txt in SHARED REPOSITORY will match THIS MACHINE.",
		path: "shared.txt",
		reason: "THIS MACHINE has the reviewed result.",
		resultSha256: HASHES[1],
		risk: "write",
		sourceSha256: HASHES[0],
		...overrides,
	};
}

function planOptions(overrides: Partial<BuildPlanArtifactOptions> = {}): BuildPlanArtifactOptions {
	return {
		actions: [
			action({}),
			action({
				action: "WRITE ON THIS MACHINE",
				destination: "THIS MACHINE",
				direction: "shared-to-machine",
				finalResult: "machine.txt on THIS MACHINE will match SHARED REPOSITORY.",
				path: "machine.txt",
				reason: "SHARED REPOSITORY has the reviewed result.",
				resultSha256: HASHES[2],
			}),
			action({
				action: "INSTALL PACKAGE ON THIS MACHINE",
				codeExecution: true,
				destination: "THIS MACHINE",
				direction: "shared-to-machine",
				exactPackageSource: "npm:example@1.0.0",
				finalResult: "THIS MACHINE will use the exact approved package source.",
				normalizedPackageSource: "npm:example@1.0.0",
				packageOperation: "install",
				path: "npm:example",
				reason: "SHARED REPOSITORY requires this exact package on THIS MACHINE.",
				resultSha256: null,
				risk: "package",
				sourceSha256: null,
			}),
			action({
				action: "UPDATE BASELINE ONLY",
				destination: "BASELINE",
				direction: "baseline-only",
				finalResult: "The baseline will record common.json.",
				path: "common.json",
				reason: "THIS MACHINE and SHARED REPOSITORY have the same reviewed result.",
				resultSha256: HASHES[3],
				risk: "baseline",
				sourceSha256: HASHES[3],
			}),
		],
		baselineCommit: "1".repeat(40),
		createdAt: "2026-01-01T00:00:00.000Z",
		decisions: [
			{
				category: "package",
				choice: "approve",
				exactSource: "npm:example@1.0.0",
				id: "package-example",
				normalizedSource: "npm:example@1.0.0",
			},
		],
		effectivePaths: ["common.json", "machine.txt", "settings.json", "shared.txt"],
		finalMachineTree: {
			"common.json": { comparisonSha256: HASHES[3], executable: false, sha256: HASHES[3] },
			"machine.txt": { comparisonSha256: HASHES[2], executable: false, sha256: HASHES[2] },
		},
		finalSharedTree: {
			"common.json": { comparisonSha256: HASHES[3], executable: false, sha256: HASHES[3] },
			"shared.txt": { comparisonSha256: HASHES[1], executable: false, sha256: HASHES[1] },
		},
		machineFingerprint: HASHES[0],
		mode: "reconcile",
		noOpEffects: [],
		packageFingerprint: HASHES[4],
		policyFingerprint: HASHES[5],
		prohibitedEffects: [],
		remoteCheckedAt: "2026-01-01T00:00:01.000Z",
		sharedCommit: COMMIT,
		sharedFingerprint: HASHES[1],
		scopeExpansion: null,
		...overrides,
	};
}

function createPlan(overrides: Partial<BuildPlanArtifactOptions> = {}): Readonly<PlanArtifact> {
	return buildPlanArtifact(planOptions(overrides));
}

function initialState(): StateDocument {
	return {
		baseline: null,
		deviceId: "test-device",
		lastBackupId: null,
		lastSuccessTime: null,
		pendingOperation: null,
		schemaVersion: 1,
	};
}

async function prepare(agentDirectory: string, plan: Readonly<PlanArtifact>): Promise<void> {
	await savePlanArtifact(agentDirectory, plan);
	await saveState(agentDirectory, initialState());
}

function createSteps(
	plan: Readonly<PlanArtifact>,
	events: string[],
	overrides: Partial<TransactionSteps> = {},
): TransactionSteps {
	return {
		fetchAndRebuildPlan: async () => {
			events.push("fetch_and_revalidate");
			return plan;
		},
		createAndValidateCandidate: async () => {
			events.push("candidate_validated");
			return { candidateCommit: CANDIDATE };
		},
		publishCandidate: async () => {
			events.push("shared_published");
			return { status: "published", publishedCommit: CANDIDATE };
		},
		createAndVerifyBackup: async () => {
			events.push("backup_verified");
			return { backupId: "backup-11" };
		},
		applyMachineFiles: async () => {
			events.push("machine_files_applied");
		},
		applyPackages: async () => {
			events.push("packages_applied");
		},
		verifyFinalMachine: async () => {
			events.push("final_verified");
		},
		restoreMachine: async () => {
			events.push("machine_restored");
			return { restored: true };
		},
		...overrides,
	};
}

async function execute(options: {
	agentDirectory: string;
	plan: Readonly<PlanArtifact>;
	steps: TransactionSteps;
	onJournalStage?: (stage: Readonly<{ stage: JournalStage }>) => Promise<void> | void;
	writeState?: (state: StateDocument) => Promise<void>;
}) {
	return executeConfirmedTransaction({
		agentDirectory: options.agentDirectory,
		plan: options.plan,
		authorization: authorizePlanExecution(options.plan, options.plan.planId),
		steps: options.steps,
		now: () => "2026-01-01T00:00:02.000Z",
		onJournalStage: options.onJournalStage,
		writeState: options.writeState,
	});
}

const RECOVERY_STEPS = {
	prepared: "create_candidate",
	candidate_created: "publish_or_bind_shared_commit",
	shared_published: "create_verified_backup",
	backup_verified: "apply_machine_files",
	machine_files_applied: "apply_packages",
	packages_applied: "verify_final_machine",
	final_verified: "commit_state",
	state_committed: "complete_journal",
	complete: "none",
} as const;

describe("transaction coordinator", () => {
	it("executes the confirmed order and derives the receipt from completed journal actions", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const plan = createPlan();
		const events: string[] = [];
		try {
			await prepare(temporary.path, plan);
			const result = await execute({
				agentDirectory: temporary.path,
				plan,
				steps: createSteps(plan, events),
			});
			expect(events).toEqual([
				"fetch_and_revalidate",
				"candidate_validated",
				"shared_published",
				"backup_verified",
				"machine_files_applied",
				"packages_applied",
				"final_verified",
			]);
			expect(result.status).toBe("success");
			expect(result.journal.stage).toBe("complete");
			expect(result.receipt.completedActionIds).toHaveLength(plan.actions.length);
			for (const path of plan.actions.map((entry) => entry.path)) expect(result.receipt.text).toContain(path);
			const state = await loadState(temporary.path);
			expect(state?.baseline).toEqual({ commit: CANDIDATE, files: plan.finalSharedTree });
			expect(state?.pendingOperation).toBeNull();
			expect((await loadJournal(temporary.path))?.stage).toBe("complete");
		} finally {
			await temporary.cleanup();
		}
	});

	it("binds APPLY to the reviewed SHARED REPOSITORY commit when PUBLISH is not needed", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const options = planOptions();
		const plan = createPlan({
			actions: options.actions.filter((entry) => entry.direction !== "machine-to-shared"),
		});
		const events: string[] = [];
		try {
			await prepare(temporary.path, plan);
			const result = await execute({
				agentDirectory: temporary.path,
				plan,
				steps: createSteps(plan, events),
			});
			expect(result.publishedCommit).toBe(COMMIT);
			expect(events).toEqual([
				"fetch_and_revalidate",
				"backup_verified",
				"machine_files_applied",
				"packages_applied",
				"final_verified",
			]);
		} finally {
			await temporary.cleanup();
		}
	});

	it.each(TRANSACTION_JOURNAL_STAGES)(
		"leaves a deterministic recovery step after an interruption at %s",
		async (targetStage) => {
			const temporary = await createTemporaryAgentDirectory();
			const plan = createPlan();
			try {
				await prepare(temporary.path, plan);
				await expect(
					execute({
						agentDirectory: temporary.path,
						plan,
						steps: createSteps(plan, []),
						onJournalStage: ({ stage }) => {
							if (stage === targetStage) throw new Error(`interrupted at ${stage}`);
						},
					}),
				).rejects.toThrow(`interrupted at ${targetStage}`);
				const journal = await loadJournal(temporary.path);
				expect(journal?.stage).toBe(targetStage);
				expect(nextTransactionRecoveryStep(targetStage)).toBe(RECOVERY_STEPS[targetStage]);
			} finally {
				await temporary.cleanup();
			}
		},
	);

	it("allows only one execution for an agent directory", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const plan = createPlan();
		let releaseFetch: (() => void) | undefined;
		let reportFetchStarted: (() => void) | undefined;
		const fetchStarted = new Promise<void>((resolve) => {
			reportFetchStarted = resolve;
		});
		const fetchReleased = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		const firstSteps = createSteps(plan, [], {
			fetchAndRebuildPlan: async () => {
				reportFetchStarted?.();
				await fetchReleased;
				return plan;
			},
		});
		const secondFetch = vi.fn(async () => plan);
		try {
			await prepare(temporary.path, plan);
			const first = execute({ agentDirectory: temporary.path, plan, steps: firstSteps });
			await fetchStarted;
			await expect(
				execute({
					agentDirectory: temporary.path,
					plan,
					steps: createSteps(plan, [], { fetchAndRebuildPlan: secondFetch }),
				}),
			).rejects.toBeInstanceOf(TransactionLockedError);
			expect(secondFetch).not.toHaveBeenCalled();
			releaseFetch?.();
			await first;
		} finally {
			releaseFetch?.();
			await temporary.cleanup();
		}
	});

	it.each([
		{ name: "THIS MACHINE changed", override: { machineFingerprint: "9".repeat(64) } },
		{ name: "SHARED REPOSITORY changed", override: { sharedFingerprint: "9".repeat(64) } },
		{ name: "managed scope changed", override: { effectivePaths: ["changed-scope.json"] } },
		{ name: "policy changed", override: { policyFingerprint: "9".repeat(64) } },
		{ name: "package source changed", override: { packageFingerprint: "9".repeat(64) } },
	])("rejects a stale full plan when $name", async ({ override }) => {
		const temporary = await createTemporaryAgentDirectory();
		const plan = createPlan();
		const stale = createPlan(override);
		const events: string[] = [];
		try {
			await prepare(temporary.path, plan);
			await expect(
				execute({
					agentDirectory: temporary.path,
					plan,
					steps: createSteps(plan, events, { fetchAndRebuildPlan: async () => stale }),
				}),
			).rejects.toBeInstanceOf(TransactionPlanExpiredError);
			expect(events).toEqual([]);
			expect(await loadJournal(temporary.path)).toBeUndefined();
			expect((await loadState(temporary.path))?.pendingOperation).toBeNull();
		} finally {
			await temporary.cleanup();
		}
	});

	it("makes no machine change when PUBLISH fails", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const plan = createPlan();
		const events: string[] = [];
		try {
			await prepare(temporary.path, plan);
			await expect(
				execute({
					agentDirectory: temporary.path,
					plan,
					steps: createSteps(plan, events, {
						publishCandidate: async () => {
							throw new Error("PUBLISH failed");
						},
					}),
				}),
			).rejects.toThrow("PUBLISH failed");
			expect(events).toEqual(["fetch_and_revalidate", "candidate_validated"]);
			expect((await loadJournal(temporary.path))?.stage).toBe("candidate_created");
			expect((await loadState(temporary.path))?.pendingOperation).toBeNull();
		} finally {
			await temporary.cleanup();
		}
	});

	it("restores THIS MACHINE and records pending apply after a post-PUBLISH failure", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const plan = createPlan();
		const events: string[] = [];
		try {
			await prepare(temporary.path, plan);
			let failure: TransactionRecoveryRequiredError | undefined;
			try {
				await execute({
					agentDirectory: temporary.path,
					plan,
					steps: createSteps(plan, events, {
						applyMachineFiles: async () => {
							events.push("machine_apply_failed");
							throw new Error("injected APPLY failure");
						},
					}),
				});
				expect.fail("Expected recovery failure");
			} catch (error) {
				failure = error as TransactionRecoveryRequiredError;
			}
			expect(failure).toBeInstanceOf(TransactionRecoveryRequiredError);
			expect(failure?.restored).toBe(true);
			expect(events.at(-1)).toBe("machine_restored");
			expect((await loadJournal(temporary.path))?.stage).toBe("backup_verified");
			expect((await loadState(temporary.path))?.pendingOperation).toEqual({
				kind: "pending_apply",
				planId: plan.planId,
				publishedCommit: CANDIDATE,
			});
		} finally {
			await temporary.cleanup();
		}
	});

	it("retains final verification journal state when baseline state writing fails", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const plan = createPlan();
		const events: string[] = [];
		const writeState = vi.fn(async () => {
			throw new Error("injected state write failure");
		});
		try {
			await prepare(temporary.path, plan);
			await expect(
				execute({ agentDirectory: temporary.path, plan, steps: createSteps(plan, events), writeState }),
			).rejects.toBeInstanceOf(TransactionRecoveryRequiredError);
			expect((await loadJournal(temporary.path))?.stage).toBe("final_verified");
			expect(events).not.toContain("machine_restored");
			expect((await loadState(temporary.path))?.baseline).toBeNull();
		} finally {
			await temporary.cleanup();
		}
	});
});
