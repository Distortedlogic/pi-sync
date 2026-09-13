import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
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
	it("shows summaries for THIS MACHINE and SHARED REPOSITORY and offers only four fixed choices", async () => {
		const machine = file("settings.json", "machine");
		const shared = file("settings.json", "shared");
		const summaries = buildConflictSummaries({
			plan: conflictPlan(),
			machineTree: { "settings.json": machine },
			sharedTree: { "settings.json": shared },
		});
		expect(summaries).toEqual([
			{
				path: "settings.json",
				machine: `THIS MACHINE: 7 bytes, SHA-256 ${machine.sha256}, executable no.`,
				shared: `SHARED REPOSITORY: 6 bytes, SHA-256 ${shared.sha256}, executable no.`,
			},
		]);
		const select = vi.fn(async () => CONFLICT_CHOICES[0].label);
		const decisions = await collectConflictDecisions({
			ctx: { hasUI: true, ui: { select } as unknown as ExtensionCommandContext["ui"] },
			conflicts: summaries,
		});
		expect(select).toHaveBeenCalledWith(
			expect.stringContaining(summaries[0].machine),
			CONFLICT_CHOICES.map((choice) => choice.label),
		);
		expect(decisions).toEqual([decision("use_machine_both")]);
	});

	it.each(CONFLICT_CHOICES)("creates a new final plan for $label", ({ choice }) => {
		const originalPlan = conflictPlan();
		const selectedDecision = decision(choice);
		const resolution = rebuildConflictPlan({
			originalPlan,
			decisions: [selectedDecision],
			rebuild: (decisions) => conflictPlan(decisions as PlanDecision[]),
		});
		expect(resolution.plan.planId).not.toBe(originalPlan.planId);
		expect(resolution.plan.decisions).toContainEqual(selectedDecision);
		expect(resolution.requiresNewPlan).toBe(true);
		expect(resolution.stopped).toBe(choice === "keep_both_stop" || choice === "merge_workspace");
	});

	it("rejects a rebuilt plan that does not contain each exact conflict choice", () => {
		const originalPlan = conflictPlan();
		expect(() =>
			rebuildConflictPlan({
				originalPlan,
				decisions: [decision("use_shared_both")],
				rebuild: () => conflictPlan(),
			}),
		).toThrow("new final plan");
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
			expect(result.requiresNewPlan).toBe(true);
			expect(await readFile(join(result.path, "THIS_MACHINE", "settings.json"), "utf8")).toBe("machine");
			expect(await readFile(join(result.path, "SHARED_REPOSITORY", "settings.json"), "utf8")).toBe("shared");
			expect(await readFile(join(machineRoot, "settings.json"), "utf8")).toBe("machine");
			expect(await readFile(join(sharedRoot, "settings.json"), "utf8")).toBe("shared");
			await expect(
				createConflictMergeWorkspace({
					agentDirectory,
					plan: conflictPlan(),
					decisions: [decision("merge_workspace")],
					machineTree: { "settings.json": machine },
					sharedTree: { "settings.json": shared },
				}),
			).rejects.toThrow("not replaced");
		} finally {
			await temporary.cleanup();
		}
	});
});
