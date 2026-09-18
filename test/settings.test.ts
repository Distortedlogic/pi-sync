import { describe, it } from "node:test";
import { expect } from "expect";
import { createDefaultLocalPolicy } from "../src/config.ts";
import {
	applyPackageDecisions,
	PackagePlanError,
	parsePackageDeclarations,
	planPackageChanges,
} from "../src/packages.ts";
import { createApplySettingsPlan, parseSettings, SettingsPlanError } from "../src/settings.ts";
import type { LocalPolicy } from "../src/types.ts";

function policy(overrides: Partial<LocalPolicy> = {}): LocalPolicy {
	return { ...createDefaultLocalPolicy(), ...overrides };
}

describe("settings parsing", () => {
	it("requires strict JSON objects and package declarations", () => {
		expect(() => parseSettings("[]", { source: "machine", policy: policy() })).toThrow("one JSON object");
		expect(() => parseSettings('{"theme":"dark","theme":"light"}', { source: "machine", policy: policy() })).toThrow(
			new SettingsPlanError("Duplicate JSON property at /theme."),
		);
		expect(() =>
			parseSettings('{"packages":["npm:example@1.0.0",{"source":"npm:example@2.0.0"}]}', {
				source: "machine",
				policy: policy(),
			}),
		).toThrow("Duplicate package declaration");
		expect(() => parseSettings('{"packages":[{"source":2}]}', { source: "machine", policy: policy() })).toThrow(
			"Invalid package declaration",
		);
	});

	it("requires approved shared schemes and pinned package sources", () => {
		expect(() => parseSettings('{"packages":["file:../private"]}', { source: "shared", policy: policy() })).toThrow(
			"scheme is not approved",
		);
		expect(() => parseSettings('{"packages":["npm:example@latest"]}', { source: "shared", policy: policy() })).toThrow(
			"not pinned",
		);
		expect(() =>
			parseSettings('{"packages":["git:github.com/example/tool"]}', { source: "shared", policy: policy() }),
		).toThrow("not pinned");
		expect(() =>
			parseSettings('{"packages":["git:github.com/example/tool@v1.2.3"]}', { source: "shared", policy: policy() }),
		).not.toThrow();
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
		expect(() => applyPackageDecisions(plan, [first])).toThrow("Missing exact package decision");
		expect(() => applyPackageDecisions(plan, [first, first])).toThrow("Duplicate package decision");
		expect(() =>
			applyPackageDecisions(plan, [first, { ...second, exactSource: "npm:second@2.0.0" }]),
		).toThrow(PackagePlanError);
		expect(() =>
			applyPackageDecisions(plan, [
				first,
				second,
				{ operation: "install", exactSource: "npm:extra@1.0.0", approved: true },
			]),
		).toThrow("do not match");

		const decided = applyPackageDecisions(plan, [first, second]);
		expect(decided.actions.map(({ exactSource, normalizedSource, decision }) => ({
			exactSource,
			normalizedSource,
			decision,
		}))).toEqual([
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
		]);
		expect(Object.isFrozen(decided.actions)).toBe(true);
	});
});

describe("APPLY settings plan", () => {
	it("preserves machine-only settings and implicit and explicit machine-only packages", () => {
		const machineTool = "npm:machine-tool@1.0.0";
		const selectedPolicy = policy({
			machineOnlySettings: ["/environment/token"],
			machineOnlyPackageSources: [machineTool],
		});
		const plan = createApplySettingsPlan({
			machineText: JSON.stringify({
				theme: "dark",
				environment: { token: "machine-value" },
				packages: ["file:../private", machineTool, "npm:example@1.0.0"],
			}),
			sharedText: JSON.stringify({
				theme: "light",
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
		expect(finalSettings).toMatchObject({ theme: "light", environment: { token: "machine-value" } });
		expect(finalSettings.packages).toEqual([
			"file:../private",
			"npm:example@2.0.0",
			machineTool,
			"npm:new@1.0.0",
		]);
		expect(plan.preservedMachineSettings.map(({ pointer }) => pointer)).toEqual(["/environment/token"]);
		expect(plan.settingChanges.map(({ pointer }) => pointer)).toEqual(["/theme"]);
		expect(plan.preservedMachinePackageSources).toEqual([
			{ exactSource: "file:../private", normalizedSource: "file:../private" },
			{ exactSource: machineTool, normalizedSource: machineTool },
		]);
		expect(plan.packageExecutionApproved).toBe(true);
	});
});
