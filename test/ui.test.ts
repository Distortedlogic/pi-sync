import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type BuildPlanArtifactOptions,
	buildPlanArtifact,
	type PlanArtifactAction,
	type PlanDecision,
} from "../src/plan.ts";
import type { PlanArtifact } from "../src/types.ts";
import {
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
		finalResult: "agent/settings.json in SHARED REPOSITORY will match THIS MACHINE.",
		path: "agent/settings.json",
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
			finalResult: "agent/old.json will not exist on THIS MACHINE.",
			path: "agent/old.json",
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
			finalResult: "THIS MACHINE and SHARED REPOSITORY keep their current values for agent/conflict.json.",
			path: "agent/conflict.json",
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
		effectivePaths: ["agent/conflict.json", "agent/old.json", "agent/settings.json"],
		scopeExpansion: null,
		actions,
		decisions: [],
		finalMachineTree: {
			"agent/settings.json": { comparisonSha256: HASHES[4], executable: false, sha256: HASHES[4] },
		},
		finalSharedTree: {
			"agent/settings.json": { comparisonSha256: HASHES[4], executable: false, sha256: HASHES[4] },
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
		assert.deepEqual(receipt, planned);
	});
});

describe("plan review", () => {
	const requirements: DecisionRequirement[] = [
		{
			category: "deletion",
			id: "deletion-decision",
			message: "Review deletion",
			choices: [
				{ id: "approve", label: "Approve" },
				{ id: "reject", label: "Reject" },
			],
		},
		{
			category: "package",
			id: "package-decision",
			message: "Review package",
			choices: [
				{ id: "approve", label: "Approve" },
				{ id: "reject", label: "Reject" },
			],
		},
	];

	it("collects representative decisions, rebuilds, and requires the exact full ID", async () => {
		let rebuilt: Readonly<PlanArtifact> | undefined;
		const select = mock.fn(async (_title: string, choices: string[]) => choices[0]);
		const input = mock.fn(async (_title: string, _placeholder?: string) => rebuilt?.planId);
		const rebuild = mock.fn<(decisions: readonly Readonly<CollectedDecision>[]) => Readonly<PlanArtifact>>(
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
		assert.equal(result.status, "confirmed");
		assert.equal(rebuild.mock.callCount(), 1);
		assert.deepEqual(
			rebuild.mock.calls[0]?.arguments[0].map(({ category }) => category),
			["deletion", "package"],
		);
		assert.equal(select.mock.callCount(), 3);
		assert.deepEqual(input.mock.calls[0]?.arguments, ["Enter exact plan ID", rebuilt?.planId]);
	});

	it("returns the immutable plan without UI or decision prompts", async () => {
		const rebuild = mock.fn<(decisions: readonly Readonly<CollectedDecision>[]) => Readonly<PlanArtifact>>();
		const previewPlan = plan();
		const result = await reviewSyncPlan({
			ctx: context(),
			previewPlan,
			decisionRequirements: requirements,
			rebuild,
		});
		assert.deepEqual(result, {
			status: "plan_only",
			plan: previewPlan,
			text: formatPlanText(previewPlan, "final-plan"),
		});
		assert.equal(rebuild.mock.callCount(), 0);
	});
});
