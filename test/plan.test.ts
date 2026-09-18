import { describe, it } from "node:test";
import { expect } from "expect";
import type { FileInventory, InventoryFile } from "../src/files.ts";
import { classifyFile, createSyncPlan, type FileActionName, sortPlanActions } from "../src/plan.ts";

const PATH = "settings.json";

function file(value: number, exactValue = value): Readonly<InventoryFile> {
	const character = value.toString(16);
	const exactCharacter = exactValue.toString(16);
	return Object.freeze({
		path: PATH,
		size: 1,
		sha256: exactCharacter.repeat(64),
		comparisonSha256: character.repeat(64),
		executable: false,
		exactBytesBase64: Buffer.from(String(exactValue)).toString("base64"),
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

const TRUTH_TABLE: TruthCase[] = [
	{ name: "first sync with both absent" },
	{
		name: "first sync with only THIS MACHINE present",
		machine: MACHINE_CHANGE,
		expected: "WRITE IN SHARED REPOSITORY",
	},
	{ name: "first sync with only SHARED REPOSITORY present", shared: SHARED_CHANGE, expected: "WRITE ON THIS MACHINE" },
	{
		name: "first sync with equal values",
		machine: MACHINE_CHANGE,
		shared: MACHINE_CHANGE,
		expected: "UPDATE BASELINE ONLY",
	},
	{
		name: "first sync with different values",
		machine: MACHINE_CHANGE,
		shared: SHARED_CHANGE,
		expected: "CONFLICT — NO ACTION SELECTED",
	},
	{ name: "tracked file absent on both sides", baseline: BASELINE, expected: "UPDATE BASELINE ONLY" },
	{ name: "tracked file unchanged on both sides", baseline: BASELINE, machine: BASELINE, shared: BASELINE },
	{
		name: "THIS MACHINE changed and SHARED REPOSITORY is unchanged",
		baseline: BASELINE,
		machine: MACHINE_CHANGE,
		shared: BASELINE,
		expected: "WRITE IN SHARED REPOSITORY",
	},
	{
		name: "SHARED REPOSITORY changed and THIS MACHINE is unchanged",
		baseline: BASELINE,
		machine: BASELINE,
		shared: SHARED_CHANGE,
		expected: "WRITE ON THIS MACHINE",
	},
	{
		name: "both sides changed to the same value",
		baseline: BASELINE,
		machine: MACHINE_CHANGE,
		shared: MACHINE_CHANGE,
		expected: "UPDATE BASELINE ONLY",
	},
	{
		name: "both sides changed to different values",
		baseline: BASELINE,
		machine: MACHINE_CHANGE,
		shared: SHARED_CHANGE,
		expected: "CONFLICT — NO ACTION SELECTED",
	},
	{
		name: "THIS MACHINE deleted and SHARED REPOSITORY is unchanged",
		baseline: BASELINE,
		shared: BASELINE,
		expected: "DELETE FROM SHARED REPOSITORY",
	},
	{
		name: "SHARED REPOSITORY deleted and THIS MACHINE is unchanged",
		baseline: BASELINE,
		machine: BASELINE,
		expected: "DELETE FROM THIS MACHINE",
	},
	{
		name: "THIS MACHINE deleted and SHARED REPOSITORY changed",
		baseline: BASELINE,
		shared: SHARED_CHANGE,
		expected: "CONFLICT — NO ACTION SELECTED",
	},
	{
		name: "SHARED REPOSITORY deleted and THIS MACHINE changed",
		baseline: BASELINE,
		machine: MACHINE_CHANGE,
		expected: "CONFLICT — NO ACTION SELECTED",
	},
];

describe("three-way classifier", () => {
	for (const { name, baseline, machine, shared, expected } of TRUTH_TABLE) {
		it(`classifies ${name}`, () => {
			const action = classifyFile(PATH, baseline, machine, shared);
			expect(action?.action).toBe(expected);
			if (action) {
				expect(action.reason.length).toBeGreaterThan(0);
				expect(action.finalResult.length).toBeGreaterThan(0);
			}
		});
	}

	it("uses canonical settings content for equality while preserving exact hashes", () => {
		const machine = file(4, 5);
		const shared = file(4, 6);
		const action = classifyFile(PATH, undefined, machine, shared);
		expect(machine.sha256).not.toBe(shared.sha256);
		expect(action?.action).toBe("UPDATE BASELINE ONLY");
	});

	it("sorts actions by risk and then path", () => {
		const sorted = sortPlanActions([
			{ path: "z", risk: "baseline" as const },
			{ path: "b", risk: "write" as const },
			{ path: "a", risk: "write" as const },
			{ path: "z", risk: "deletion" as const },
			{ path: "z", risk: "conflict" as const },
			{ path: "z", risk: "package" as const },
			{ path: "z", risk: "policy" as const },
		]);
		expect(sorted.map(({ risk, path }) => `${risk}:${path}`)).toEqual([
			"policy:z",
			"package:z",
			"conflict:z",
			"deletion:z",
			"write:a",
			"write:b",
			"baseline:z",
		]);
	});
});

describe("mode plans", () => {
	it("blocks PUBLISH when APPLY is required", () => {
		const plan = createSyncPlan({
			mode: "publish",
			machine: inventory("machine", [1]),
			shared: inventory("shared", [2]),
			baseline: inventory("baseline", [1]),
		});
		expect(plan.blocked).toBe(true);
		expect(plan.blockers[0]).toContain("requires APPLY");
	});

	it("blocks APPLY when PUBLISH is required", () => {
		const plan = createSyncPlan({
			mode: "apply",
			machine: inventory("machine", [2]),
			shared: inventory("shared", [1]),
			baseline: inventory("baseline", [1]),
		});
		expect(plan.blocked).toBe(true);
		expect(plan.blockers[0]).toContain("requires PUBLISH");
	});

	it("reconciles independent changes in both directions", () => {
		const plan = createSyncPlan({
			mode: "reconcile",
			machine: inventory("machine", [2, 1]),
			shared: inventory("shared", [1, 3]),
			baseline: inventory("baseline", [1, 1]),
		});
		expect(plan.blocked).toBe(false);
		expect(plan.actions.map((action) => action.action)).toEqual([
			"WRITE IN SHARED REPOSITORY",
			"WRITE ON THIS MACHINE",
		]);
		expect(plan.finalSharedTree["path-0.txt"]?.comparisonSha256).toBe(file(2).comparisonSha256);
		expect(plan.finalMachineTree["path-1.txt"]?.comparisonSha256).toBe(file(3).comparisonSha256);
	});

	it("makes no tree change when a conflict blocks the plan", () => {
		const machine = inventory("machine", [2]);
		const shared = inventory("shared", [3]);
		const plan = createSyncPlan({ mode: "reconcile", machine, shared, baseline: inventory("baseline", [1]) });
		expect(plan.blocked).toBe(true);
		expect(plan.finalMachineTree).toEqual(machine.files);
		expect(plan.finalSharedTree).toEqual(shared.files);
	});
});
