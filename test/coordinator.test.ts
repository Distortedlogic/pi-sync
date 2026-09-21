import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
	executeConfirmedTransaction,
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
const STALE_PLAN_CHANGES: Array<{ name: string; override: Partial<BuildPlanArtifactOptions> }> = [
	{ name: "THIS MACHINE changed", override: { machineFingerprint: "9".repeat(64) } },
	{ name: "SHARED REPOSITORY changed", override: { sharedFingerprint: "9".repeat(64) } },
	{ name: "managed scope changed", override: { effectivePaths: ["changed-scope.json"] } },
	{ name: "policy changed", override: { policyFingerprint: "9".repeat(64) } },
	{ name: "package source changed", override: { packageFingerprint: "9".repeat(64) } },
];

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
		restoreSecrets: async () => {
			events.push("secrets_restored");
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
			assert.deepEqual(events, [
				"fetch_and_revalidate",
				"candidate_validated",
				"shared_published",
				"backup_verified",
				"packages_applied",
				"machine_files_applied",
				"final_verified",
				"secrets_restored",
			]);
			assert.equal(result.status, "success");
			assert.equal(result.journal.stage, "complete");
			assert.equal(result.receipt.completedActionIds.length, plan.actions.length);
			for (const path of plan.actions.map((entry) => entry.path)) assert.ok(result.receipt.text.includes(path));
			const state = await loadState(temporary.path);
			assert.deepEqual(state?.baseline, { commit: CANDIDATE, files: plan.finalSharedTree });
			assert.equal(state?.pendingOperation, null);
			assert.equal((await loadJournal(temporary.path))?.stage, "complete");
		} finally {
			await temporary.cleanup();
		}
	});

	it("completes a no-op reconciliation without publish, backup, package, or file effects", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const plan = createPlan({ actions: [], decisions: [], finalMachineTree: {}, finalSharedTree: {} });
		const events: string[] = [];
		try {
			await prepare(temporary.path, plan);
			const result = await execute({
				agentDirectory: temporary.path,
				plan,
				steps: createSteps(plan, events),
			});
			assert.deepEqual(events, ["fetch_and_revalidate", "final_verified", "secrets_restored"]);
			assert.deepEqual(result.receipt.completedActionIds, []);
			assert.equal(result.publishedCommit, COMMIT);
			assert.equal((await loadJournal(temporary.path))?.stage, "complete");
		} finally {
			await temporary.cleanup();
		}
	});

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
		const secondFetch = mock.fn(async () => plan);
		try {
			await prepare(temporary.path, plan);
			const first = execute({ agentDirectory: temporary.path, plan, steps: firstSteps });
			await fetchStarted;
			await assert.rejects(
				execute({
					agentDirectory: temporary.path,
					plan,
					steps: createSteps(plan, [], { fetchAndRebuildPlan: secondFetch }),
				}),
				TransactionLockedError,
			);
			assert.equal(secondFetch.mock.callCount(), 0);
			releaseFetch?.();
			await first;
		} finally {
			releaseFetch?.();
			await temporary.cleanup();
		}
	});

	it("rejects stale immutable plan inputs before starting a transaction", async () => {
		for (const { name, override } of STALE_PLAN_CHANGES) {
			const temporary = await createTemporaryAgentDirectory();
			const plan = createPlan();
			const events: string[] = [];
			try {
				await prepare(temporary.path, plan);
				await assert.rejects(
					execute({
						agentDirectory: temporary.path,
						plan,
						steps: createSteps(plan, events, { fetchAndRebuildPlan: async () => createPlan(override) }),
					}),
					TransactionPlanExpiredError,
					name,
				);
				assert.deepEqual(events, [], name);
				assert.equal(await loadJournal(temporary.path), undefined, name);
				assert.equal((await loadState(temporary.path))?.pendingOperation, null, name);
			} finally {
				await temporary.cleanup();
			}
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
				assert.fail("Expected recovery failure");
			} catch (error) {
				failure = error as TransactionRecoveryRequiredError;
			}
			assert.ok(failure instanceof TransactionRecoveryRequiredError);
			assert.equal(failure.restored, true);
			assert.equal(events.at(-1), "machine_restored");
			assert.equal((await loadJournal(temporary.path))?.stage, "packages_applied");
			assert.deepEqual((await loadState(temporary.path))?.pendingOperation, {
				kind: "pending_apply",
				planId: plan.planId,
				publishedCommit: CANDIDATE,
			});

			const resumeEvents: string[] = [];
			const resumed = await execute({
				agentDirectory: temporary.path,
				plan,
				steps: createSteps(plan, resumeEvents),
			});
			assert.equal(resumed.status, "success");
			assert.deepEqual(resumeEvents, ["machine_files_applied", "final_verified", "secrets_restored"]);
			assert.equal((await loadJournal(temporary.path))?.stage, "complete");
		} finally {
			await temporary.cleanup();
		}
	});

	it("retains secret restoration journal state when baseline state writing fails", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const plan = createPlan();
		const events: string[] = [];
		const writeState = mock.fn(async () => {
			throw new Error("injected state write failure");
		});
		try {
			await prepare(temporary.path, plan);
			await assert.rejects(
				execute({ agentDirectory: temporary.path, plan, steps: createSteps(plan, events), writeState }),
				TransactionRecoveryRequiredError,
			);
			assert.equal((await loadJournal(temporary.path))?.stage, "secrets_restored");
			assert.ok(!events.includes("machine_restored"));
			assert.equal((await loadState(temporary.path))?.baseline, null);
		} finally {
			await temporary.cleanup();
		}
	});
});
