import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { expect } from "expect";
import * as vi from "jest-mock";
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
	timeout?: number;
	signal?: AbortSignal;
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
		effectivePaths: ["settings.json"],
		scopeExpansion: null,
		actions,
		decisions,
		finalMachineTree: {
			"settings.json": {
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
	return async (command, args, options): Promise<ExecResult> => {
		calls.push({ command, args: [...args], timeout: options?.timeout, signal: options?.signal });
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
		stage: "machine_files_applied",
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
		const events: string[] = [];
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
		const exec = async (...args: Parameters<PackageExec>): Promise<ExecResult> => {
			events.push(`command:${args[1].join(":")}`);
			return createExec(calls)(...args);
		};
		const rememberApprovals = vi.fn(async (sources: readonly string[]) => {
			events.push(`remember:${sources.join(",")}`);
		});
		try {
			await prepareExecution(agentDirectory, fixture);
			const result = await execute({ agentDirectory, fixture, exec, rememberApprovals });
			expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
				["pi", "remove", "npm:remove@1.0.0"],
				["pi", "install", "npm:update@2.0.0"],
				["pi", "install", "npm:install@1.0.0"],
			]);
			expect(calls.every((call) => call.timeout === 5_000)).toBe(true);
			expect(result.status).toBe("success");
			expect(await readFile(join(agentDirectory, "settings.json"), "utf8")).toBe(fixture.plannedSettingsText);
			const finalSettings = parseSettings(fixture.plannedSettingsText, { source: "machine", policy: fixture.policy });
			expect(packageSetFingerprint(finalSettings.packages)).toBe(fixture.plan.packageFingerprint);
			expect(rememberApprovals).toHaveBeenCalledWith(["npm:install@1.0.0"]);
			expect(events.at(-1)).toBe("remember:npm:install@1.0.0");
			const journal = await loadJournal(agentDirectory);
			expect(journal?.stage).toBe("machine_files_applied");
			expect(journal?.packageEvents?.map(({ operation, status }) => `${operation}:${status}`)).toEqual([
				"remove:started",
				"remove:completed",
				"update:started",
				"update:completed",
				"install:started",
				"install:completed",
			]);
		} finally {
			await temporary.cleanup();
		}
	});

	it("blocks invalid package approvals before any command", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const calls: PiCall[] = [];
		const spec = { operation: "install" as const, identity: "npm:one", exactSource: "npm:one@1.0.0" };
		const missing = packageFixture([], [spec.exactSource], [spec], { decisions: [] });
		const valid = packageFixture([], [spec.exactSource], [spec]);
		const changedApproval = packageFixture([], [spec.exactSource], [spec], {
			decisions: [
				{
					...valid.plan.decisions[0],
					exactSource: "npm:one@2.0.0",
				} as PlanDecision,
			],
		});
		const cases: Array<{
			name: string;
			fixture: PackageFixture;
			expected: string;
			authorizationPlanId?: string;
			currentSettingsText?: string;
		}> = [
			{ name: "missing approval", fixture: missing, expected: "incomplete" },
			{
				name: "mismatched authorization",
				fixture: valid,
				expected: "authorization",
				authorizationPlanId: "f".repeat(64),
			},
			{
				name: "changed approval source",
				fixture: changedApproval,
				expected: "does not match the exact planned source",
			},
			{
				name: "changed installed source",
				fixture: valid,
				expected: "install source changed",
				currentSettingsText: settings(["npm:one@0.9.0"]),
			},
		];

		try {
			for (const [index, selected] of cases.entries()) {
				const agentDirectory = join(temporary.path, `agent-${index}`);
				await prepareExecution(agentDirectory, selected.fixture);
				if (selected.currentSettingsText) {
					await writeFile(join(agentDirectory, "settings.json"), selected.currentSettingsText, "utf8");
				}
				let failure: Error | undefined;
				try {
					await executeConfirmedPackagePlan({
						exec: createExec(calls),
						cwd: temporary.path,
						agentDirectory,
						plan: selected.fixture.plan,
						authorization: {
							planId: selected.authorizationPlanId ?? selected.fixture.plan.planId,
						},
						plannedSettingsText: selected.fixture.plannedSettingsText,
						policy: selected.fixture.policy,
					});
				} catch (error) {
					if (error instanceof Error) failure = error;
				}
				assert.ok(failure, `Expected ${selected.name} to fail.`);
				expect(failure.message).toContain(selected.expected);
			}
			expect(calls).toEqual([]);
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
			await expect(
				execute({ agentDirectory: requiredAgent, fixture: requiredFixture, exec: createExec([], () => true) }),
			).rejects.toThrow("pi remove failed");
			expect(await readFile(join(requiredAgent, "settings.json"), "utf8")).toBe(requiredFixture.currentSettingsText);

			const bestEffortAgent = join(bestEffortRoot.path, "agent");
			await prepareExecution(bestEffortAgent, bestEffortFixture);
			const result = await execute({
				agentDirectory: bestEffortAgent,
				fixture: bestEffortFixture,
				exec: createExec([], () => true),
			});
			expect(result.status).toBe("success");
			expect(result.bestEffortFailureIds).toHaveLength(1);
			expect(await readFile(join(bestEffortAgent, "settings.json"), "utf8")).toBe(
				bestEffortFixture.plannedSettingsText,
			);
			expect((await loadJournal(bestEffortAgent))?.packageEvents?.at(-1)?.status).toBe("best_effort_failed");
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
			expect(options?.signal).toBe(controller.signal);
			controller.abort();
			return { stdout: "", stderr: "", code: 1, killed: true };
		};
		try {
			await prepareExecution(agentDirectory, fixture);
			await expect(execute({ agentDirectory, fixture, exec, signal: controller.signal })).rejects.toThrow("cancelled");
			expect(await readFile(join(agentDirectory, "settings.json"), "utf8")).toBe(fixture.currentSettingsText);
			expect((await loadJournal(agentDirectory))?.packageEvents?.[0]?.status).toBe("started");
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
			const rememberApprovals = vi.fn(async () => {});
			try {
				await prepareExecution(agentDirectory, fixture);
				await expect(
					execute({
						agentDirectory,
						fixture,
						exec: createExec(calls, (args) => args[1] === "npm:z@1.0.0"),
						rememberApprovals,
					}),
				).rejects.toBeInstanceOf(PackageExecutionError);
				expect(calls.map(({ args }) => args.join(":"))).toEqual(expected);
				expect(await readFile(join(agentDirectory, "settings.json"), "utf8")).toBe(fixture.currentSettingsText);
				expect(rememberApprovals).not.toHaveBeenCalled();
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
				expect(error).toBeInstanceOf(PackageExecutionError);
				const failure = error as PackageExecutionError;
				expect(failure.originalError).toBe("pi install failed.");
				expect(failure.rollbackErrors).toEqual([
					{
						actionId: packageActionDecisionId(fixture.plan.actions[0] as PlanArtifactAction),
						message: "Package rollback command failed.",
					},
				]);
			}
			expect(await readFile(join(agentDirectory, "settings.json"), "utf8")).toBe(fixture.currentSettingsText);
		} finally {
			await temporary.cleanup();
		}
	});
});
