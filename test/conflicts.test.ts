import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildConflictSummaries,
	CONFLICT_CHOICES,
	type ConflictChoice,
	type ConflictDecision,
	collectConflictDecisions,
	createConflictMergeWorkspace,
	rebuildConflictPlan,
} from "../src/conflicts.ts";
import type { InventoryFile } from "../src/files.ts";
import { buildPlanArtifact, type PlanDecision } from "../src/plan.ts";
import type { PlanArtifact } from "../src/types.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const HASH = "a".repeat(64);

function file(path: string, content: string): Readonly<InventoryFile> {
	const bytes = Buffer.from(content);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	return Object.freeze({
		path,
		size: bytes.length,
		sha256,
		comparisonSha256: sha256,
		executable: false,
		exactBytesBase64: bytes.toString("base64"),
	});
}

function conflictPlan(decisions: readonly PlanDecision[] = []): Readonly<PlanArtifact> {
	return buildPlanArtifact({
		actions: [
			{
				action: "CONFLICT — NO ACTION SELECTED",
				codeExecution: false,
				destination: "NONE",
				direction: "none",
				finalResult: "THIS MACHINE and SHARED REPOSITORY keep their current values for settings.json.",
				path: "settings.json",
				reason: "THIS MACHINE and SHARED REPOSITORY have different untracked values.",
				resultSha256: null,
				risk: "conflict",
				sourceSha256: null,
			},
		],
		baselineCommit: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		decisions,
		effectivePaths: ["settings.json"],
		finalMachineTree: {},
		finalSharedTree: {},
		machineFingerprint: HASH,
		mode: "reconcile",
		noOpEffects: [],
		packageFingerprint: HASH,
		policyFingerprint: HASH,
		prohibitedEffects: [],
		remoteCheckedAt: "2026-01-01T00:00:01.000Z",
		sharedCommit: "1".repeat(40),
		sharedFingerprint: HASH,
		scopeExpansion: null,
	});
}

function decision(choice: ConflictChoice): ConflictDecision {
	return { category: "conflict", choice, id: "conflict:settings.json" };
}

describe("conflict review", () => {
	it("keeps the fixed choices and returns the selected exact decision", async () => {
		assert.deepEqual(
			CONFLICT_CHOICES.map(({ choice, label }) => ({ choice, label })),
			[
				{ choice: "use_machine_both", label: "USE THIS MACHINE ON BOTH SIDES" },
				{ choice: "use_shared_both", label: "USE SHARED REPOSITORY ON BOTH SIDES" },
				{ choice: "keep_both_stop", label: "KEEP BOTH AND STOP" },
				{ choice: "merge_workspace", label: "CREATE A SEPARATE MERGE WORKSPACE" },
			],
		);
		const machine = file("settings.json", "machine");
		const shared = file("settings.json", "shared");
		const summaries = buildConflictSummaries({
			plan: conflictPlan(),
			machineTree: { "settings.json": machine },
			sharedTree: { "settings.json": shared },
		});
		assert.deepEqual(summaries, [
			{
				path: "settings.json",
				machine: `THIS MACHINE: 7 bytes, SHA-256 ${machine.sha256}, executable no.`,
				shared: `SHARED REPOSITORY: 6 bytes, SHA-256 ${shared.sha256}, executable no.`,
			},
		]);
		const decisions = await collectConflictDecisions({
			ctx: {
				hasUI: true,
				ui: { select: async () => CONFLICT_CHOICES[0].label } as unknown as ExtensionCommandContext["ui"],
			},
			conflicts: summaries,
		});
		assert.deepEqual(decisions, [decision("use_machine_both")]);
	});

	it("creates a distinct final plan for each exact choice", () => {
		const originalPlan = conflictPlan();
		for (const { choice } of CONFLICT_CHOICES) {
			const selectedDecision = decision(choice);
			const resolution = rebuildConflictPlan({
				originalPlan,
				decisions: [selectedDecision],
				rebuild: (decisions) => conflictPlan(decisions as PlanDecision[]),
			});
			assert.notEqual(resolution.plan.planId, originalPlan.planId);
			assert.deepEqual(resolution.plan.decisions, [selectedDecision]);
			assert.equal(resolution.requiresNewPlan, true);
			assert.equal(resolution.stopped, choice === "keep_both_stop" || choice === "merge_workspace");
		}
	});
});

describe("separate merge workspace", () => {
	it("copies both conflict values without editing live configuration and requires a new plan", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const machineRoot = join(temporary.path, "machine");
		const sharedRoot = join(temporary.path, "shared");
		const agentDirectory = join(temporary.path, "agent");
		const machine = file("settings.json", "machine");
		const shared = file("settings.json", "shared");
		try {
			await Promise.all([mkdir(machineRoot), mkdir(sharedRoot)]);
			await Promise.all([
				writeFile(join(machineRoot, "settings.json"), "machine"),
				writeFile(join(sharedRoot, "settings.json"), "shared"),
			]);
			const result = await createConflictMergeWorkspace({
				agentDirectory,
				plan: conflictPlan(),
				decisions: [decision("merge_workspace")],
				machineTree: { "settings.json": machine },
				sharedTree: { "settings.json": shared },
			});
			assert.equal(result.requiresNewPlan, true);
			assert.equal(await readFile(join(result.path, "THIS_MACHINE", "settings.json"), "utf8"), "machine");
			assert.equal(await readFile(join(result.path, "SHARED_REPOSITORY", "settings.json"), "utf8"), "shared");
			assert.equal(await readFile(join(machineRoot, "settings.json"), "utf8"), "machine");
			assert.equal(await readFile(join(sharedRoot, "settings.json"), "utf8"), "shared");
			await assert.rejects(
				createConflictMergeWorkspace({
					agentDirectory,
					plan: conflictPlan(),
					decisions: [decision("merge_workspace")],
					machineTree: { "settings.json": machine },
					sharedTree: { "settings.json": shared },
				}),
				/not replaced/,
			);
		} finally {
			await temporary.cleanup();
		}
	});
});
