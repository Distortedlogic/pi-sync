import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileInventory, InventoryFile } from "../src/files.ts";
import {
	type BuildPlanArtifactOptions,
	buildPlanArtifact,
	classifyFile,
	createSyncPlan,
	type FileActionName,
	type PlanArtifactAction,
} from "../src/plan.ts";

const PATH = "settings.json";

function file(value: number): Readonly<InventoryFile> {
	const character = value.toString(16);
	return Object.freeze({
		path: PATH,
		size: 1,
		sha256: character.repeat(64),
		comparisonSha256: character.repeat(64),
		executable: false,
		exactBytesBase64: Buffer.from(String(value)).toString("base64"),
	});
}

function inventory(
	source: FileInventory["source"],
	values: readonly (number | undefined)[],
): Pick<FileInventory, "files" | "source"> {
	const files: Record<string, Readonly<InventoryFile>> = {};
	for (const [index, value] of values.entries()) {
		if (value === undefined) continue;
		const path = `path-${index}.txt`;
		files[path] = { ...file(value), path };
	}
	return { files, source };
}

interface TruthCase {
	name: string;
	baseline?: Readonly<InventoryFile>;
	machine?: Readonly<InventoryFile>;
	shared?: Readonly<InventoryFile>;
	expected?: FileActionName;
}

const BASELINE = file(1);
const MACHINE_CHANGE = file(2);
const SHARED_CHANGE = file(3);
const ARTIFACT_HASHES = ["a", "b", "c", "d", "e"].map((value) => value.repeat(64));

function artifactAction(overrides: Partial<PlanArtifactAction> = {}): PlanArtifactAction {
	return {
		action: "WRITE IN SHARED REPOSITORY",
		codeExecution: false,
		destination: "SHARED REPOSITORY",
		direction: "machine-to-shared",
		finalResult: "settings.json in SHARED REPOSITORY will match THIS MACHINE.",
		path: "settings.json",
		reason: "THIS MACHINE changed the tracked file.",
		resultSha256: ARTIFACT_HASHES[1],
		risk: "write",
		sourceSha256: ARTIFACT_HASHES[0],
		...overrides,
	};
}

function artifactOptions(overrides: Partial<BuildPlanArtifactOptions> = {}): BuildPlanArtifactOptions {
	return {
		actions: [artifactAction()],
		baselineCommit: "1".repeat(40),
		createdAt: "2026-01-01T00:00:00.000Z",
		decisions: [],
		effectivePaths: ["settings.json"],
		finalMachineTree: {},
		finalSharedTree: {},
		machineFingerprint: ARTIFACT_HASHES[0],
		mode: "reconcile",
		noOpEffects: [],
		packageFingerprint: ARTIFACT_HASHES[2],
		policyFingerprint: ARTIFACT_HASHES[3],
		prohibitedEffects: [],
		remoteCheckedAt: "2026-01-01T00:00:01.000Z",
		sharedCommit: "2".repeat(40),
		sharedFingerprint: ARTIFACT_HASHES[4],
		scopeExpansion: null,
		...overrides,
	};
}

const TRUTH_TABLE: TruthCase[] = [
	{
		name: "first sync from THIS MACHINE",
		machine: MACHINE_CHANGE,
		expected: "WRITE IN SHARED REPOSITORY",
	},
	{
		name: "first sync from SHARED REPOSITORY",
		shared: SHARED_CHANGE,
		expected: "WRITE ON THIS MACHINE",
	},
	{
		name: "different first-sync values",
		machine: MACHINE_CHANGE,
		shared: SHARED_CHANGE,
		expected: "CONFLICT — NO ACTION SELECTED",
	},
	{ name: "unchanged tracked value", baseline: BASELINE, machine: BASELINE, shared: BASELINE },
	{
		name: "THIS MACHINE changed",
		baseline: BASELINE,
		machine: MACHINE_CHANGE,
		shared: BASELINE,
		expected: "WRITE IN SHARED REPOSITORY",
	},
	{
		name: "SHARED REPOSITORY changed",
		baseline: BASELINE,
		machine: BASELINE,
		shared: SHARED_CHANGE,
		expected: "WRITE ON THIS MACHINE",
	},
	{
		name: "both sides reached the same value",
		baseline: BASELINE,
		machine: MACHINE_CHANGE,
		shared: MACHINE_CHANGE,
		expected: "UPDATE BASELINE ONLY",
	},
	{
		name: "both sides diverged",
		baseline: BASELINE,
		machine: MACHINE_CHANGE,
		shared: SHARED_CHANGE,
		expected: "CONFLICT — NO ACTION SELECTED",
	},
	{
		name: "THIS MACHINE deleted the tracked value",
		baseline: BASELINE,
		shared: BASELINE,
		expected: "DELETE FROM SHARED REPOSITORY",
	},
	{
		name: "SHARED REPOSITORY deleted the tracked value",
		baseline: BASELINE,
		machine: BASELINE,
		expected: "DELETE FROM THIS MACHINE",
	},
];

describe("three-way classifier", () => {
	for (const { name, baseline, machine, shared, expected } of TRUTH_TABLE) {
		it(`classifies ${name}`, () => {
			const action = classifyFile(PATH, baseline, machine, shared);
			assert.equal(action?.action, expected);
			if (action) {
				assert.ok(action.reason.length > 0);
				assert.ok(action.finalResult.length > 0);
			}
		});
	}
});

describe("canonical plan artifact", () => {
	it("changes its full ID when an immutable security field changes", () => {
		const first = buildPlanArtifact(artifactOptions());
		const changed = buildPlanArtifact(artifactOptions({ actions: [artifactAction({ resultSha256: "f".repeat(64) })] }));

		assert.match(first.planId, /^[a-f0-9]{64}$/);
		assert.equal(first.shortPlanId, first.planId.slice(0, 12));
		assert.notEqual(changed.planId, first.planId);
	});

	it("rejects a write with a destination that does not match its direction or name", () => {
		assert.throws(
			() => buildPlanArtifact(artifactOptions({ actions: [artifactAction({ destination: "THIS MACHINE" })] })),
			/wrong destination/,
		);
		assert.throws(
			() =>
				buildPlanArtifact(
					artifactOptions({
						actions: [
							artifactAction({
								destination: "BASELINE",
								direction: "baseline-only",
								risk: "baseline",
							}),
						],
					}),
				),
			/name has the wrong destination/,
		);
	});
});

describe("mode plans", () => {
	it("blocks a one-way mode when the opposite direction is required", () => {
		const cases = [
			{ mode: "publish" as const, machine: 1, shared: 2, blocker: "requires APPLY" },
			{ mode: "apply" as const, machine: 2, shared: 1, blocker: "requires PUBLISH" },
		];
		for (const selected of cases) {
			const plan = createSyncPlan({
				mode: selected.mode,
				machine: inventory("machine", [selected.machine]),
				shared: inventory("shared", [selected.shared]),
				baseline: inventory("baseline", [1]),
			});
			assert.equal(plan.blocked, true);
			assert.ok(plan.blockers[0]?.includes(selected.blocker));
		}
	});

	it("reconciles independent changes in both directions", () => {
		const plan = createSyncPlan({
			mode: "reconcile",
			machine: inventory("machine", [2, 1]),
			shared: inventory("shared", [1, 3]),
			baseline: inventory("baseline", [1, 1]),
		});
		assert.equal(plan.blocked, false);
		assert.deepEqual(
			plan.actions.map((action) => action.action),
			["WRITE IN SHARED REPOSITORY", "WRITE ON THIS MACHINE"],
		);
		assert.equal(plan.finalSharedTree["path-0.txt"]?.comparisonSha256, file(2).comparisonSha256);
		assert.equal(plan.finalMachineTree["path-1.txt"]?.comparisonSha256, file(3).comparisonSha256);
	});

	it("makes no tree change when a conflict blocks the plan", () => {
		const machine = inventory("machine", [2]);
		const shared = inventory("shared", [3]);
		const plan = createSyncPlan({ mode: "reconcile", machine, shared, baseline: inventory("baseline", [1]) });
		assert.equal(plan.blocked, true);
		assert.deepEqual(plan.finalMachineTree, machine.files);
		assert.deepEqual(plan.finalSharedTree, shared.files);
	});
});
