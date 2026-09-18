import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect } from "expect";
import * as vi from "jest-mock";
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

describe("plan and receipt formatting", () => {
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
		const input = vi.fn(async (_title: string, _placeholder?: string) => rebuilt?.planId);
		const rebuild = vi.fn<(decisions: readonly Readonly<CollectedDecision>[]) => Readonly<PlanArtifact>>(
			(decisions) => {
				rebuilt = plan({ decisions: decisions as PlanDecision[] });
				return rebuilt;
			},
		);
		const ctx = context({
			hasUI: true,
			mode: "rpc",
			ui: { select, input } as unknown as ExtensionCommandContext["ui"],
		});
		const result = await reviewSyncPlan({ ctx, previewPlan: plan(), decisionRequirements: requirements, rebuild });
		expect(result.status).toBe("confirmed");
		expect(rebuild).toHaveBeenCalledTimes(1);
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

	it("returns the immutable plan without UI or decision prompts", async () => {
		for (const mode of ["print", "json"] as const) {
			const rebuild = vi.fn<(decisions: readonly Readonly<CollectedDecision>[]) => Readonly<PlanArtifact>>();
			const previewPlan = plan();
			const result = await reviewSyncPlan({
				ctx: context({ mode }),
				previewPlan,
				decisionRequirements: requirements,
				rebuild,
			});
			expect(result).toEqual({
				status: "plan_only",
				plan: previewPlan,
				text: formatPlanText(previewPlan, "final-plan"),
			});
			expect(rebuild).not.toHaveBeenCalled();
		}
	});

	it("requires the exact full plan ID for execution", () => {
		const artifact = plan();
		expect(() => authorizePlanExecution(artifact, artifact.shortPlanId)).toThrow("Exact plan ID");
		expect(authorizePlanExecution(artifact, artifact.planId)).toEqual({ planId: artifact.planId });
	});
});
