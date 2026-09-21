import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it, mock } from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { createDefaultLocalPolicy } from "../src/config.ts";
import {
	executeConfirmedPackagePlan,
	type PackageExec,
	PackageExecutionError,
	packageActionDecisionId,
} from "../src/package-execution.ts";
import { packageSetFingerprint } from "../src/packages.ts";
import { buildPlanArtifact, type PlanArtifactAction, type PlanDecision } from "../src/plan.ts";
import { parseSettings } from "../src/settings.ts";
import { loadJournal, saveJournal } from "../src/state.ts";
import type { LocalPolicy, PlanArtifact } from "../src/types.ts";
import { authorizePlanExecution } from "../src/ui.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

interface ActionSpec {
	operation: "install" | "update" | "remove";
	identity: string;
	exactSource: string;
	previousExactSource?: string;
	bestEffort?: boolean;
	choice?: "approve" | "approve_and_remember";
}

interface PackageFixture {
	policy: LocalPolicy;
	currentSettingsText: string;
	plannedSettingsText: string;
	plan: Readonly<PlanArtifact>;
}

interface PiCall {
	command: string;
	args: string[];
}

function settings(packages: readonly string[]): string {
	return `${JSON.stringify({ packages })}\n`;
}

function planAction(spec: ActionSpec): PlanArtifactAction {
	const removal = spec.operation === "remove";
	return {
		action: removal ? "REMOVE PACKAGE FROM THIS MACHINE" : "INSTALL PACKAGE ON THIS MACHINE",
		bestEffort: spec.bestEffort,
		codeExecution: true,
		destination: "THIS MACHINE",
		direction: "shared-to-machine",
		exactPackageSource: spec.exactSource,
		finalResult: removal
			? "The package declaration will not remain on THIS MACHINE."
			: "THIS MACHINE will use the exact approved package source.",
		normalizedPackageSource: spec.exactSource,
		packageOperation: spec.operation,
		path: spec.identity,
		previousExactPackageSource: spec.previousExactSource,
		previousNormalizedPackageSource: spec.previousExactSource,
		reason: "SHARED REPOSITORY requires this exact package action on THIS MACHINE.",
		resultSha256: null,
		risk: "package",
		sourceSha256: null,
	};
}

function packageFixture(
	currentPackages: readonly string[],
	plannedPackages: readonly string[],
	specs: readonly ActionSpec[],
	overrides: { decisions?: readonly PlanDecision[] } = {},
): PackageFixture {
	const policy = createDefaultLocalPolicy();
	const currentSettingsText = settings(currentPackages);
	const plannedSettingsText = settings(plannedPackages);
	const actions = specs.map(planAction);
	const decisions =
		overrides.decisions ??
		actions.map((action, index) => ({
			category: "package" as const,
			choice: specs[index]?.choice ?? "approve",
			exactSource: action.exactPackageSource,
			id: packageActionDecisionId(action),
			normalizedSource: action.normalizedPackageSource,
			previousExactSource: action.previousExactPackageSource,
			previousNormalizedSource: action.previousNormalizedPackageSource,
		}));
	const parsedPlanned = parseSettings(plannedSettingsText, { source: "machine", policy });
	const exactSettingsHash = createHash("sha256").update(plannedSettingsText).digest("hex");
	const plan = buildPlanArtifact({
		createdAt: "2026-01-01T00:00:00.000Z",
		remoteCheckedAt: "2026-01-01T00:00:01.000Z",
		mode: "apply",
		baselineCommit: "1".repeat(40),
		sharedCommit: "2".repeat(40),
		machineFingerprint: "a".repeat(64),
		sharedFingerprint: "b".repeat(64),
		policyFingerprint: "c".repeat(64),
		packageFingerprint: packageSetFingerprint(parsedPlanned.packages),
		effectivePaths: ["agent/settings.json"],
		scopeExpansion: null,
		actions,
		decisions,
		finalMachineTree: {
			"agent/settings.json": {
				comparisonSha256: parsedPlanned.fingerprint,
				executable: false,
				sha256: exactSettingsHash,
			},
		},
		finalSharedTree: {},
		prohibitedEffects: [],
		noOpEffects: [],
	});
	return { policy, currentSettingsText, plannedSettingsText, plan };
}

function createExec(calls: PiCall[], fail?: (args: readonly string[], callIndex: number) => boolean): PackageExec {
	return async (command, args): Promise<ExecResult> => {
		calls.push({ command, args: [...args] });
		return fail?.(args, calls.length - 1)
			? { stdout: "", stderr: "failure details", code: 1, killed: false }
			: { stdout: "", stderr: "", code: 0, killed: false };
	};
}

async function prepareExecution(agentDirectory: string, fixture: PackageFixture): Promise<void> {
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(join(agentDirectory, "settings.json"), fixture.currentSettingsText, "utf8");
	await saveJournal(agentDirectory, {
		planId: fixture.plan.planId,
		reviewedSharedCommit: fixture.plan.sharedCommit,
		schemaVersion: 1,
		stage: "backup_verified",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
}

async function execute(options: {
	agentDirectory: string;
	fixture: PackageFixture;
	exec: PackageExec;
	signal?: AbortSignal;
	rememberApprovals?: (sources: readonly string[]) => Promise<void>;
}) {
	return executeConfirmedPackagePlan({
		exec: options.exec,
		cwd: dirname(options.agentDirectory),
		agentDirectory: options.agentDirectory,
		machineRoot: dirname(options.agentDirectory),
		plan: options.fixture.plan,
		authorization: authorizePlanExecution(options.fixture.plan, options.fixture.plan.planId),
		plannedSettingsText: options.fixture.plannedSettingsText,
		policy: options.fixture.policy,
		signal: options.signal,
		timeoutMs: 5_000,
		now: () => "2026-01-01T00:00:02.000Z",
		rememberApprovals: options.rememberApprovals,
	});
}

describe("approved package execution", () => {
	it("runs deterministic exact commands, journals each action, and writes exact planned settings", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const calls: PiCall[] = [];
		const fixture = packageFixture(
			["npm:remove@1.0.0", "npm:update@1.0.0", "file:../machine-only"],
			["npm:update@2.0.0", "npm:install@1.0.0", "file:../machine-only"],
			[
				{
					operation: "install",
					identity: "npm:install",
					exactSource: "npm:install@1.0.0",
					choice: "approve_and_remember",
				},
				{
					operation: "update",
					identity: "npm:update",
					exactSource: "npm:update@2.0.0",
					previousExactSource: "npm:update@1.0.0",
				},
				{ operation: "remove", identity: "npm:remove", exactSource: "npm:remove@1.0.0" },
			],
		);
		const exec = createExec(calls);
		const rememberApprovals = mock.fn(async (_sources: readonly string[]) => {});
		try {
			await prepareExecution(agentDirectory, fixture);
			const result = await execute({ agentDirectory, fixture, exec, rememberApprovals });
			assert.deepEqual(
				calls.map(({ command, args }) => [command, ...args]),
				[
					["pi", "remove", "npm:remove@1.0.0"],
					["pi", "install", "npm:update@2.0.0"],
					["pi", "install", "npm:install@1.0.0"],
				],
			);
			assert.equal(result.status, "success");
			assert.equal(await readFile(join(agentDirectory, "settings.json"), "utf8"), fixture.plannedSettingsText);
			const finalSettings = parseSettings(fixture.plannedSettingsText, { source: "machine", policy: fixture.policy });
			assert.equal(packageSetFingerprint(finalSettings.packages), fixture.plan.packageFingerprint);
			assert.deepEqual(rememberApprovals.mock.calls[0]?.arguments, [["npm:install@1.0.0"]]);
		} finally {
			await temporary.cleanup();
		}
	});

	it("does not repeat a package action recorded as completed", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const calls: PiCall[] = [];
		const fixture = packageFixture(
			[],
			["npm:one@1.0.0"],
			[{ operation: "install", identity: "npm:one", exactSource: "npm:one@1.0.0" }],
		);
		try {
			await prepareExecution(agentDirectory, fixture);
			const journal = await loadJournal(agentDirectory);
			const action = fixture.plan.actions.find((candidate) => candidate.risk === "package");
			if (!journal || !action) throw new Error("Package resume fixture is invalid.");
			await saveJournal(agentDirectory, {
				...journal,
				packageEvents: [
					{
						actionId: packageActionDecisionId(action),
						operation: "install",
						status: "completed",
						timestamp: "2026-01-01T00:00:01.000Z",
					},
				],
			});

			const result = await execute({ agentDirectory, fixture, exec: createExec(calls) });

			assert.equal(result.status, "success");
			assert.deepEqual(calls, []);
			assert.equal(await readFile(join(agentDirectory, "settings.json"), "utf8"), fixture.plannedSettingsText);
		} finally {
			await temporary.cleanup();
		}
	});

	it("blocks a mismatched exact-source approval before execution", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const calls: PiCall[] = [];
		const spec = { operation: "install" as const, identity: "npm:one", exactSource: "npm:one@1.0.0" };
		const valid = packageFixture([], [spec.exactSource], [spec]);
		const fixture = packageFixture([], [spec.exactSource], [spec], {
			decisions: [
				{
					...valid.plan.decisions[0],
					exactSource: "npm:one@2.0.0",
				} as PlanDecision,
			],
		});
		try {
			await prepareExecution(agentDirectory, fixture);
			await assert.rejects(
				execute({ agentDirectory, fixture, exec: createExec(calls) }),
				/does not match the exact planned source/,
			);
			assert.deepEqual(calls, []);
		} finally {
			await temporary.cleanup();
		}
	});

	it("treats removal failure as failure unless the confirmed action is best effort", async () => {
		const requiredRoot = await createTemporaryAgentDirectory();
		const bestEffortRoot = await createTemporaryAgentDirectory();
		const requiredFixture = packageFixture(
			["npm:old@1.0.0"],
			[],
			[{ operation: "remove", identity: "npm:old", exactSource: "npm:old@1.0.0" }],
		);
		const bestEffortFixture = packageFixture(
			["npm:old@1.0.0"],
			[],
			[{ operation: "remove", identity: "npm:old", exactSource: "npm:old@1.0.0", bestEffort: true }],
		);
		try {
			const requiredAgent = join(requiredRoot.path, "agent");
			await prepareExecution(requiredAgent, requiredFixture);
			await assert.rejects(
				execute({ agentDirectory: requiredAgent, fixture: requiredFixture, exec: createExec([], () => true) }),
				/pi remove failed/,
			);
			assert.equal(await readFile(join(requiredAgent, "settings.json"), "utf8"), requiredFixture.currentSettingsText);

			const bestEffortAgent = join(bestEffortRoot.path, "agent");
			await prepareExecution(bestEffortAgent, bestEffortFixture);
			const result = await execute({
				agentDirectory: bestEffortAgent,
				fixture: bestEffortFixture,
				exec: createExec([], () => true),
			});
			assert.equal(result.status, "success");
			assert.equal(result.bestEffortFailureIds.length, 1);
			assert.equal(
				await readFile(join(bestEffortAgent, "settings.json"), "utf8"),
				bestEffortFixture.plannedSettingsText,
			);
			assert.equal((await loadJournal(bestEffortAgent))?.packageEvents?.at(-1)?.status, "best_effort_failed");
		} finally {
			await Promise.all([requiredRoot.cleanup(), bestEffortRoot.cleanup()]);
		}
	});

	it("passes cancellation to the active Pi process and restores settings before reporting", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const controller = new AbortController();
		const fixture = packageFixture(
			[],
			["npm:one@1.0.0"],
			[{ operation: "install", identity: "npm:one", exactSource: "npm:one@1.0.0" }],
		);
		const exec: PackageExec = async (_command, _args, options) => {
			assert.equal(options?.signal, controller.signal);
			controller.abort();
			return { stdout: "", stderr: "", code: 1, killed: true };
		};
		try {
			await prepareExecution(agentDirectory, fixture);
			await assert.rejects(execute({ agentDirectory, fixture, exec, signal: controller.signal }), /cancelled/);
			assert.equal(await readFile(join(agentDirectory, "settings.json"), "utf8"), fixture.currentSettingsText);
			assert.equal((await loadJournal(agentDirectory))?.packageEvents?.[0]?.status, "started");
		} finally {
			await temporary.cleanup();
		}
	});
});

describe("package rollback", () => {
	for (const { name, current, planned, specs, expected } of [
		{
			name: "mixed batch",
			current: ["npm:a@1.0.0", "npm:b@1.0.0"],
			planned: ["npm:b@2.0.0", "npm:c@1.0.0", "npm:z@1.0.0"],
			specs: [
				{ operation: "remove", identity: "npm:a", exactSource: "npm:a@1.0.0" },
				{ operation: "update", identity: "npm:b", exactSource: "npm:b@2.0.0", previousExactSource: "npm:b@1.0.0" },
				{ operation: "install", identity: "npm:c", exactSource: "npm:c@1.0.0" },
				{ operation: "install", identity: "npm:z", exactSource: "npm:z@1.0.0" },
			] as ActionSpec[],
			expected: [
				"remove:npm:a@1.0.0",
				"install:npm:b@2.0.0",
				"install:npm:c@1.0.0",
				"install:npm:z@1.0.0",
				"remove:npm:c@1.0.0",
				"install:npm:b@1.0.0",
				"install:npm:a@1.0.0",
			],
		},
	]) {
		it(`reverses a completed ${name} action in reverse order`, async () => {
			const temporary = await createTemporaryAgentDirectory();
			const agentDirectory = join(temporary.path, "agent");
			const fixture = packageFixture(current, planned, specs);
			const calls: PiCall[] = [];
			const rememberApprovals = mock.fn(async () => {});
			try {
				await prepareExecution(agentDirectory, fixture);
				await assert.rejects(
					execute({
						agentDirectory,
						fixture,
						exec: createExec(calls, (args) => args[1] === "npm:z@1.0.0"),
						rememberApprovals,
					}),
					PackageExecutionError,
				);
				assert.deepEqual(
					calls.map(({ args }) => args.join(":")),
					expected,
				);
				assert.equal(await readFile(join(agentDirectory, "settings.json"), "utf8"), fixture.currentSettingsText);
				assert.equal(rememberApprovals.mock.callCount(), 0);
			} finally {
				await temporary.cleanup();
			}
		});
	}

	it("reports rollback errors separately from the original failure", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const fixture = packageFixture(
			[],
			["npm:a@1.0.0", "npm:z@1.0.0"],
			[
				{ operation: "install", identity: "npm:a", exactSource: "npm:a@1.0.0" },
				{ operation: "install", identity: "npm:z", exactSource: "npm:z@1.0.0" },
			],
		);
		const calls: PiCall[] = [];
		try {
			await prepareExecution(agentDirectory, fixture);
			try {
				await execute({
					agentDirectory,
					fixture,
					exec: createExec(calls, (args) => args[1] === "npm:z@1.0.0" || args[0] === "remove"),
				});
				assert.fail("Expected package failure");
			} catch (error) {
				assert.ok(error instanceof PackageExecutionError);
				assert.equal(error.originalError, "pi install failed.");
				assert.deepEqual(error.rollbackErrors, [
					{
						actionId: packageActionDecisionId(fixture.plan.actions[0] as PlanArtifactAction),
						message: "Package rollback command failed.",
					},
				]);
			}
			assert.equal(await readFile(join(agentDirectory, "settings.json"), "utf8"), fixture.currentSettingsText);
		} finally {
			await temporary.cleanup();
		}
	});
});
