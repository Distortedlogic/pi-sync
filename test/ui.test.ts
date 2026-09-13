import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	type BuildPlanArtifactOptions,
	buildPlanArtifact,
	type PlanArtifactAction,
	type PlanDecision,
} from "../src/plan.ts";
import type { PlanArtifact } from "../src/types.ts";
import {
	authorizePlanExecution,
	type CollectedDecision,
	type DecisionRequirement,
	formatPlanRows,
	formatPlanText,
	reviewSyncPlan,
} from "../src/ui.ts";

const HASHES = ["a", "b", "c", "d", "e", "f"].map((value) => value.repeat(64));
const COMMIT = "1".repeat(40);

function action(overrides: Partial<PlanArtifactAction> = {}): PlanArtifactAction {
	return {
		action: "WRITE IN SHARED REPOSITORY",
		codeExecution: false,
		destination: "SHARED REPOSITORY",
		direction: "machine-to-shared",
		finalResult: "settings.json in SHARED REPOSITORY will match THIS MACHINE.",
		path: "settings.json",
		reason: "THIS MACHINE changed the tracked file.",
		resultSha256: HASHES[1],
		risk: "write",
		sourceSha256: HASHES[0],
		...overrides,
	};
}

function planOptions(overrides: Partial<BuildPlanArtifactOptions> = {}): BuildPlanArtifactOptions {
	const actions: PlanArtifactAction[] = [
		action(),
		action({
			action: "DELETE FROM THIS MACHINE",
			destination: "THIS MACHINE",
			direction: "shared-to-machine",
			finalResult: "old.json will not exist on THIS MACHINE.",
			path: "old.json",
			reason: "SHARED REPOSITORY deleted the tracked file.",
			resultSha256: null,
			risk: "deletion",
		}),
		action({
			action: "INSTALL PACKAGE ON THIS MACHINE",
			codeExecution: true,
			destination: "THIS MACHINE",
			direction: "shared-to-machine",
			exactPackageSource: "npm:example@1.0.0",
			normalizedPackageSource: "npm:example@1.0.0",
			finalResult: "THIS MACHINE will use the exact approved package source.",
			path: "npm:example",
			reason: "SHARED REPOSITORY requires this package on THIS MACHINE.",
			risk: "package",
		}),
		action({
			action: "CONFLICT — NO ACTION SELECTED",
			destination: "NONE",
			direction: "none",
			finalResult: "THIS MACHINE and SHARED REPOSITORY keep their current values for conflict.json.",
			path: "conflict.json",
			reason: "THIS MACHINE and SHARED REPOSITORY have different values.",
			resultSha256: null,
			risk: "conflict",
		}),
	];
	return {
		createdAt: "2026-01-01T00:00:00.000Z",
		remoteCheckedAt: "2026-01-01T00:00:01.000Z",
		mode: "reconcile",
		baselineCommit: COMMIT,
		sharedCommit: COMMIT,
		machineFingerprint: HASHES[0],
		sharedFingerprint: HASHES[1],
		policyFingerprint: HASHES[2],
		packageFingerprint: HASHES[3],
		effectivePaths: ["conflict.json", "old.json", "settings.json"],
		scopeExpansion: null,
		actions,
		decisions: [],
		finalMachineTree: {
			"settings.json": { comparisonSha256: HASHES[4], executable: false, sha256: HASHES[4] },
		},
		finalSharedTree: {
			"settings.json": { comparisonSha256: HASHES[4], executable: false, sha256: HASHES[4] },
		},
		prohibitedEffects: [
			{
				code: "NO_UNREVIEWED_PATHS",
				description: "No path outside the reviewed plan will change.",
				destination: "NONE",
			},
		],
		noOpEffects: [
			{
				code: "UNCHANGED_PATHS",
				count: 7,
				description: "Seven unchanged paths remain unchanged.",
				destination: "NONE",
			},
		],
		...overrides,
	};
}

function plan(overrides: Partial<BuildPlanArtifactOptions> = {}): Readonly<PlanArtifact> {
	return buildPlanArtifact(planOptions(overrides));
}

function context(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	return {
		hasUI: false,
		mode: "print",
		ui: {} as ExtensionCommandContext["ui"],
		...overrides,
	} as ExtensionCommandContext;
}

describe("canonical plan artifact", () => {
	it("creates full and short IDs without hashing display text", () => {
		const first = plan();
		const changedDisplay = plan({
			actions: planOptions().actions.map((entry) => ({
				...entry,
				reason: `Different reason for ${entry.path}`,
				finalResult: `Different display result for ${entry.path}`,
			})),
			prohibitedEffects: planOptions().prohibitedEffects.map((effect) => ({
				...effect,
				description: "Different display text.",
			})),
		});
		expect(first.planId).toMatch(/^[a-f0-9]{64}$/);
		expect(first.shortPlanId).toBe(first.planId.slice(0, 12));
		expect(changedDisplay.planId).toBe(first.planId);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.actions)).toBe(true);
	});

	it("rejects a write or deletion with the wrong destination", () => {
		expect(() => plan({ actions: [action({ destination: "THIS MACHINE" })] })).toThrow("wrong destination");
		expect(() =>
			plan({
				actions: [
					action({
						action: "WRITE IN SHARED REPOSITORY",
						destination: "BASELINE",
						direction: "baseline-only",
						risk: "baseline",
					}),
				],
			}),
		).toThrow("name has the wrong destination");
	});
});

describe("plan and receipt formatting", () => {
	it("uses fixed sections and unambiguous destination text", () => {
		const text = formatPlanText(plan(), "final-plan");
		expect(text).toMatchInlineSnapshot(`
"## FINAL RESULT
- Final immutable plan 55f162ec8dee71fd6809440678f21288163bd08186c83fa55c44ee4fd4f6799d (55f162ec8dee)
- Mode: RECONCILE
- SHARED REPOSITORY checked at: 2026-01-01T00:00:01.000Z

## THIS MACHINE → SHARED REPOSITORY
- WRITE IN SHARED REPOSITORY: settings.json | Destination: SHARED REPOSITORY | Result: settings.json in SHARED REPOSITORY will match THIS MACHINE.

## SHARED REPOSITORY → THIS MACHINE
- DELETE FROM THIS MACHINE: old.json | Destination: THIS MACHINE | Result: old.json will not exist on THIS MACHINE.

## CODE EXECUTION
- INSTALL PACKAGE ON THIS MACHINE: npm:example | Destination: THIS MACHINE | Result: THIS MACHINE will use the exact approved package source.

## DELETIONS
- DELETE FROM THIS MACHINE: old.json | Destination: THIS MACHINE | Result: old.json will not exist on THIS MACHINE.

## CONFLICTS
- CONFLICT — NO ACTION SELECTED: conflict.json | Destination: NONE | Result: THIS MACHINE and SHARED REPOSITORY keep their current values for conflict.json.

## WILL NOT HAPPEN
- No path outside the reviewed plan will change. | Destination: NONE
- Seven unchanged paths remain unchanged. | Destination: NONE | Count: 7"
`);
		expect(text).not.toMatch(/\b(local|remote|added|removed|pull|push)\b/i);
		for (const path of ["settings.json", "old.json", "npm:example", "conflict.json"]) expect(text).toContain(path);
	});

	it("shows baseline-only changed paths", () => {
		const artifact = plan({
			actions: [
				action({
					action: "UPDATE BASELINE ONLY",
					destination: "BASELINE",
					direction: "baseline-only",
					finalResult: "The baseline will record the common result for equal.json.",
					path: "equal.json",
					reason: "THIS MACHINE and SHARED REPOSITORY already have the same result.",
					risk: "baseline",
				}),
			],
		});
		expect(formatPlanText(artifact, "final-plan")).toContain(
			"UPDATE BASELINE ONLY: equal.json | Destination: BASELINE",
		);
	});

	it("uses identical action rows in the plan and completion receipt", () => {
		const artifact = plan();
		const planned = formatPlanRows(artifact, "final-plan").filter((row) => row.actionKey);
		const receipt = formatPlanRows(artifact, "receipt").filter((row) => row.actionKey);
		expect(receipt).toEqual(planned);
	});
});

describe("plan review", () => {
	const requirements: DecisionRequirement[] = ["policy", "conflict", "deletion", "extension", "package"].map(
		(category) => ({
			category: category as DecisionRequirement["category"],
			id: `${category}-decision`,
			message: `Review ${category}`,
			choices: [
				{ id: "approve", label: "Approve" },
				{ id: "reject", label: "Reject" },
			],
		}),
	);

	it("collects every decision, rebuilds, shows RPC text, and requires the exact full ID", async () => {
		let rebuilt: Readonly<PlanArtifact> | undefined;
		const select = vi.fn(async (_title: string, choices: string[]) => choices[0]);
		const input = vi.fn(async () => rebuilt?.planId);
		const rebuild = vi.fn((decisions: readonly Readonly<CollectedDecision>[]) => {
			rebuilt = plan({ decisions: decisions as PlanDecision[] });
			return rebuilt;
		});
		const ctx = context({
			hasUI: true,
			mode: "rpc",
			ui: { select, input } as unknown as ExtensionCommandContext["ui"],
		});
		const result = await reviewSyncPlan({ ctx, previewPlan: plan(), decisionRequirements: requirements, rebuild });
		expect(result.status).toBe("confirmed");
		expect(rebuild).toHaveBeenCalledOnce();
		expect(rebuild.mock.calls[0]?.[0].map(({ category }) => category)).toEqual([
			"policy",
			"conflict",
			"deletion",
			"extension",
			"package",
		]);
		expect(select).toHaveBeenCalledTimes(6);
		expect(input).toHaveBeenCalledWith("Enter exact plan ID", rebuilt?.planId);
	});

	it("returns the plan only in non-interactive modes", async () => {
		const rebuild = vi.fn();
		const previewPlan = plan();
		const result = await reviewSyncPlan({ ctx: context(), previewPlan, decisionRequirements: requirements, rebuild });
		expect(result).toEqual({ status: "plan_only", plan: previewPlan, text: formatPlanText(previewPlan, "final-plan") });
		expect(rebuild).not.toHaveBeenCalled();
	});

	it("cancels without rebuilding or authorizing changes", async () => {
		const rebuild = vi.fn();
		const select = vi.fn(async () => undefined);
		const ctx = context({
			hasUI: true,
			mode: "rpc",
			ui: { select } as unknown as ExtensionCommandContext["ui"],
		});
		const previewPlan = plan();
		const result = await reviewSyncPlan({ ctx, previewPlan, decisionRequirements: requirements, rebuild });
		expect(result).toEqual({ status: "cancelled", plan: previewPlan });
		expect(rebuild).not.toHaveBeenCalled();
	});

	it("uses the TUI review component and rejects a short ID", async () => {
		const rebuilt = plan();
		const select = vi.fn(async (_title: string, choices: string[]) => choices[0]);
		const custom = vi.fn(async () => "continue");
		const input = vi.fn(async () => rebuilt.shortPlanId);
		const ctx = context({
			hasUI: true,
			mode: "tui",
			ui: { select, custom, input } as unknown as ExtensionCommandContext["ui"],
		});
		const result = await reviewSyncPlan({
			ctx,
			previewPlan: plan(),
			decisionRequirements: [],
			rebuild: () => rebuilt,
		});
		expect(custom).toHaveBeenCalledOnce();
		expect(result.status).toBe("id_mismatch");
		expect(() => authorizePlanExecution(rebuilt, rebuilt.shortPlanId)).toThrow("Exact plan ID");
	});
});
