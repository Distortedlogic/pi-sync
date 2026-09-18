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
	it("requires an object and rejects duplicate JSON properties", () => {
		expect(() => parseSettings("[]", { source: "machine", policy: policy() })).toThrow("one JSON object");
		expect(() => parseSettings('{"theme":"dark","theme":"light"}', { source: "machine", policy: policy() })).toThrow(
			new SettingsPlanError("Duplicate JSON property at /theme."),
		);
	});

	it("rejects duplicate and invalid package declarations", () => {
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

	it("uses stable JSON for comparison", () => {
		const first = parseSettings('{"theme":"dark","nested":{"b":2,"a":1}}', { source: "machine", policy: policy() });
		const second = parseSettings('{\n"nested":{"a":1,"b":2},"theme":"dark"\n}', {
			source: "machine",
			policy: policy(),
		});
		expect(first.canonicalText).toBe(second.canonicalText);
		expect(first.fingerprint).toBe(second.fingerprint);
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
	it("classifies package operations separately and labels each as code execution", () => {
		const selectedPolicy = policy();
		const machine = parsePackageDeclarations(["npm:old@1.0.0", "npm:update@1.0.0"], {
			source: "machine",
			policy: selectedPolicy,
		});
		const shared = parsePackageDeclarations(["npm:new@1.0.0", "npm:update@2.0.0"], {
			source: "shared",
			policy: selectedPolicy,
		});
		const plan = planPackageChanges(machine, shared);
		expect(plan.actions.map(({ operation }) => operation).sort()).toEqual(["install", "remove", "update"]);
		expect(plan.actions.every((action) => action.codeExecution)).toBe(true);
		expect(plan.actions.find((action) => action.operation === "remove")?.action).toBe(
			"REMOVE PACKAGE FROM THIS MACHINE",
		);
		expect(plan.actions.some((action) => action.action === ("DELETE FROM SHARED REPOSITORY" as string))).toBe(false);
	});

	it("rejects partial, duplicate, extra, and changed-source decisions", () => {
		const selectedPolicy = policy();
		const machine = parsePackageDeclarations([], { source: "machine", policy: selectedPolicy });
		const shared = parsePackageDeclarations(["npm:first@1.0.0", "npm:second@1.0.0"], {
			source: "shared",
			policy: selectedPolicy,
		});
		const plan = planPackageChanges(machine, shared);
		const first = { operation: "install" as const, exactSource: "npm:first@1.0.0", approved: true };
		expect(() => applyPackageDecisions(plan, [first])).toThrow("Missing exact package decision");
		expect(() => applyPackageDecisions(plan, [first, first])).toThrow("Duplicate package decision");
		expect(() =>
			applyPackageDecisions(plan, [first, { operation: "install", exactSource: "npm:second@2.0.0", approved: true }]),
		).toThrow(PackagePlanError);
		expect(() =>
			applyPackageDecisions(plan, [
				first,
				{ operation: "install", exactSource: "npm:second@1.0.0", approved: true },
				{ operation: "install", exactSource: "npm:extra@1.0.0", approved: true },
			]),
		).toThrow("do not match");
	});

	it("includes immutable exact and normalized package sources", () => {
		const selectedPolicy = policy();
		const plan = planPackageChanges(
			parsePackageDeclarations([], { source: "machine", policy: selectedPolicy }),
			parsePackageDeclarations(["npm:example@1.0.0"], { source: "shared", policy: selectedPolicy }),
		);
		const decided = applyPackageDecisions(plan, [
			{ operation: "install", exactSource: "npm:example@1.0.0", approved: true },
		]);
		expect(decided.actions[0]).toMatchObject({
			exactSource: "npm:example@1.0.0",
			normalizedSource: "npm:example@1.0.0",
			decision: "approved",
		});
		expect(Object.isFrozen(decided)).toBe(true);
		expect(Object.isFrozen(decided.actions)).toBe(true);
		expect(Object.isFrozen(decided.actions[0])).toBe(true);
	});
});

describe("APPLY settings plan", () => {
	it("preserves machine-only settings and package declarations and shows each preserved path", () => {
		const selectedPolicy = policy({ machineOnlySettings: ["/environment/token"] });
		const machineText = JSON.stringify({
			theme: "dark",
			environment: { token: "machine-value" },
			packages: ["file:../private", "npm:example@1.0.0"],
		});
		const sharedText = JSON.stringify({
			theme: "light",
			environment: { token: "shared-value" },
			packages: ["npm:example@2.0.0", "npm:new@1.0.0"],
		});
		const plan = createApplySettingsPlan({
			machineText,
			sharedText,
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
		expect(finalSettings.packages).toEqual(["file:../private", "npm:example@2.0.0", "npm:new@1.0.0"]);
		expect(plan.preservedMachineSettings.map(({ pointer }) => pointer)).toEqual(["/environment/token"]);
		expect(plan.settingChanges.map(({ pointer }) => pointer)).toEqual(["/theme"]);
		expect(plan.preservedMachinePackageSources).toEqual([
			{ exactSource: "file:../private", normalizedSource: "file:../private" },
		]);
		expect(plan.packageExecutionApproved).toBe(true);
	});

	it("preserves an explicitly approved machine-only package declaration", () => {
		const exactSource = "npm:machine-tool@1.0.0";
		const selectedPolicy = policy({ machineOnlyPackageSources: [exactSource] });
		const plan = createApplySettingsPlan({
			machineText: JSON.stringify({ packages: [exactSource] }),
			sharedText: "{}",
			policy: selectedPolicy,
			packageDecisions: [],
		});
		expect((JSON.parse(plan.finalSettingsText) as { packages: string[] }).packages).toEqual([exactSource]);
		expect(plan.packageActions).toEqual([]);
	});

	it("changes the stable plan ID when an exact source changes", () => {
		const selectedPolicy = policy();
		const first = createApplySettingsPlan({
			machineText: "{}",
			sharedText: '{"packages":["npm:example@1.0.0"]}',
			policy: selectedPolicy,
			packageDecisions: [{ operation: "install", exactSource: "npm:example@1.0.0", approved: false }],
		});
		const second = createApplySettingsPlan({
			machineText: "{}",
			sharedText: '{"packages":["npm:example@2.0.0"]}',
			policy: selectedPolicy,
			packageDecisions: [{ operation: "install", exactSource: "npm:example@2.0.0", approved: false }],
		});
		expect(first.planId).not.toBe(second.planId);
		expect(first.packageExecutionApproved).toBe(false);
	});
});
