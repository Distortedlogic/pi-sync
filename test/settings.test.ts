import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultLocalPolicy } from "../src/config.ts";
import {
	applyPackageDecisions,
	PackagePlanError,
	parsePackageDeclarations,
	planPackageChanges,
} from "../src/packages.ts";
import { createApplySettingsPlan, parseSettings } from "../src/settings.ts";
import type { LocalPolicy } from "../src/types.ts";

function policy(overrides: Partial<LocalPolicy> = {}): LocalPolicy {
	return { ...createDefaultLocalPolicy(), ...overrides };
}

describe("settings parsing", () => {
	it("requires strict JSON objects and package declarations", () => {
		assert.throws(() => parseSettings("[]", { source: "machine", policy: policy() }), /one JSON object/);
		assert.throws(
			() => parseSettings('{"theme":"dark","theme":"light"}', { source: "machine", policy: policy() }),
			/Duplicate JSON property at \/theme/,
		);
		assert.throws(
			() =>
				parseSettings('{"packages":["npm:example@1.0.0",{"source":"npm:example@2.0.0"}]}', {
					source: "machine",
					policy: policy(),
				}),
			/Duplicate package declaration/,
		);
		assert.throws(
			() => parseSettings('{"packages":[{"source":2}]}', { source: "machine", policy: policy() }),
			/Invalid package declaration/,
		);
	});

	it("requires approved shared schemes and pinned package sources", () => {
		assert.throws(
			() => parseSettings('{"packages":["file:../private"]}', { source: "shared", policy: policy() }),
			/scheme is not approved/,
		);
		assert.throws(
			() => parseSettings('{"packages":["npm:example@latest"]}', { source: "shared", policy: policy() }),
			/not pinned/,
		);
		assert.throws(
			() => parseSettings('{"packages":["git:github.com/example/tool"]}', { source: "shared", policy: policy() }),
			/not pinned/,
		);
		assert.doesNotThrow(() =>
			parseSettings('{"packages":["git:github.com/example/tool@v1.2.3"]}', {
				source: "shared",
				policy: policy(),
			}),
		);
	});
});

describe("package planning", () => {
	it("requires one decision for each immutable exact source", () => {
		const selectedPolicy = policy();
		const plan = planPackageChanges(
			parsePackageDeclarations([], { source: "machine", policy: selectedPolicy }),
			parsePackageDeclarations(["npm:first@1.0.0", "npm:second@1.0.0"], {
				source: "shared",
				policy: selectedPolicy,
			}),
		);
		const first = { operation: "install" as const, exactSource: "npm:first@1.0.0", approved: true };
		const second = { operation: "install" as const, exactSource: "npm:second@1.0.0", approved: true };
		assert.throws(() => applyPackageDecisions(plan, [first]), /Missing exact package decision/);
		assert.throws(
			() => applyPackageDecisions(plan, [first, { ...second, exactSource: "npm:second@2.0.0" }]),
			PackagePlanError,
		);

		const decided = applyPackageDecisions(plan, [first, second]);
		assert.deepEqual(
			decided.actions.map(({ exactSource, normalizedSource, decision }) => ({
				exactSource,
				normalizedSource,
				decision,
			})),
			[
				{
					exactSource: "npm:first@1.0.0",
					normalizedSource: "npm:first@1.0.0",
					decision: "approved",
				},
				{
					exactSource: "npm:second@1.0.0",
					normalizedSource: "npm:second@1.0.0",
					decision: "approved",
				},
			],
		);
		assert.equal(Object.isFrozen(decided.actions), true);
	});
});

describe("APPLY settings plan", () => {
	it("preserves machine-only settings and implicit and explicit machine-only packages", () => {
		const machineTool = "npm:machine-tool@1.0.0";
		const selectedPolicy = policy({
			machineOnlySettings: ["/environment/token", "/lastChangelogVersion"],
			machineOnlyPackageSources: [machineTool],
		});
		const plan = createApplySettingsPlan({
			machineText: JSON.stringify({
				theme: "dark",
				lastChangelogVersion: "machine-version",
				environment: { token: "machine-value" },
				packages: ["file:../private", machineTool, "npm:example@1.0.0"],
			}),
			sharedText: JSON.stringify({
				theme: "light",
				lastChangelogVersion: "shared-version",
				environment: { token: "shared-value" },
				packages: ["npm:example@2.0.0", "npm:new@1.0.0"],
			}),
			policy: selectedPolicy,
			packageDecisions: [
				{
					operation: "update",
					exactSource: "npm:example@2.0.0",
					previousExactSource: "npm:example@1.0.0",
					approved: true,
				},
				{ operation: "install", exactSource: "npm:new@1.0.0", approved: true },
			],
		});
		const finalSettings = JSON.parse(plan.finalSettingsText) as Record<string, unknown>;
		assert.equal(finalSettings.theme, "light");
		assert.equal(finalSettings.lastChangelogVersion, "machine-version");
		assert.deepEqual(finalSettings.environment, { token: "machine-value" });
		assert.deepEqual(finalSettings.packages, ["file:../private", "npm:example@2.0.0", machineTool, "npm:new@1.0.0"]);
		assert.deepEqual(
			plan.preservedMachineSettings.map(({ pointer }) => pointer),
			["/environment/token", "/lastChangelogVersion"],
		);
		assert.deepEqual(
			plan.settingChanges.map(({ pointer }) => pointer),
			["/theme"],
		);
		assert.deepEqual(plan.preservedMachinePackageSources, [
			{ exactSource: "file:../private", normalizedSource: "file:../private" },
			{ exactSource: machineTool, normalizedSource: machineTool },
		]);
		assert.equal(plan.packageExecutionApproved, true);
	});
});
