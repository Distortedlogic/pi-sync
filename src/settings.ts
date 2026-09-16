import { createHash } from "node:crypto";
import jsonPatch, { type Operation } from "fast-json-patch";
import stableStringify from "json-stable-stringify";
import { getNodeValue, type Node as JsonNode, parseTree } from "jsonc-parser";
import {
	applyPackageDecisions,
	type DecidedPackageAction,
	type PackageDecision,
	type PackageDeclaration,
	parsePackageDeclarations,
	planPackageChanges,
} from "./packages.ts";
import type { LocalPolicy } from "./types.ts";

const { applyOperation, compare, getValueByPointer } = jsonPatch;

export interface ParsedSettings {
	canonicalText: string;
	fingerprint: string;
	packages: ReturnType<typeof parsePackageDeclarations>;
	value: Record<string, unknown>;
}

export interface SettingChange {
	operation: "add" | "remove" | "replace";
	pointer: string;
	reason: string;
	finalResult: string;
}

export interface PreservedMachineSetting {
	pointer: string;
	reason: string;
	finalResult: string;
}

export interface ApplySettingsPlan {
	planId: string;
	machineFingerprint: string;
	sharedFingerprint: string;
	finalSettingsFingerprint: string;
	finalSettingsText: string;
	settingChanges: readonly Readonly<SettingChange>[];
	preservedMachineSettings: readonly Readonly<PreservedMachineSetting>[];
	preservedMachinePackageSources: readonly Readonly<{ exactSource: string; normalizedSource: string }>[];
	packageActions: readonly Readonly<DecidedPackageAction>[];
	packageExecutionApproved: boolean;
}

export class SettingsPlanError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SettingsPlanError";
	}
}

function pointerSegment(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function assertNoDuplicateKeys(node: JsonNode, pointer = ""): void {
	if (node.type === "object") {
		const keys = new Set<string>();
		for (const property of node.children ?? []) {
			const keyNode = property.children?.[0];
			const valueNode = property.children?.[1];
			const key = String(keyNode?.value);
			const childPointer = `${pointer}/${pointerSegment(key)}`;
			if (keys.has(key)) throw new SettingsPlanError(`Duplicate JSON property at ${childPointer}.`);
			keys.add(key);
			if (valueNode) assertNoDuplicateKeys(valueNode, childPointer);
		}
	} else if (node.type === "array") {
		for (const [index, child] of (node.children ?? []).entries()) assertNoDuplicateKeys(child, `${pointer}/${index}`);
	}
}

function stableJson(value: unknown): string {
	const text = stableStringify(value, { space: 2 });
	if (text === undefined) throw new SettingsPlanError("Cannot serialize settings.");
	return `${text}\n`;
}

function fingerprint(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function parseSettings(
	text: string,
	options: { source: "machine" | "shared"; policy: LocalPolicy },
): Readonly<ParsedSettings> {
	const errors: Array<{ error: number; offset: number; length: number }> = [];
	const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
	if (!tree || errors.length > 0) throw new SettingsPlanError("settings.json is invalid JSON.");
	assertNoDuplicateKeys(tree);
	const value: unknown = getNodeValue(tree);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SettingsPlanError("settings.json must contain one JSON object.");
	}
	const settings = value as Record<string, unknown>;
	const canonicalText = stableJson(settings);
	const packages = parsePackageDeclarations(settings.packages, options);
	return Object.freeze({ canonicalText, fingerprint: fingerprint(canonicalText), packages, value: settings });
}

function validatePolicyPointer(pointer: string): void {
	if (!/^(?:\/(?:[^~/]|~[01])*)+$/.test(pointer) || pointer === "/packages" || pointer.startsWith("/packages/")) {
		throw new SettingsPlanError(`Invalid machine-only settings pointer: ${pointer}`);
	}
}

function applyJsonOperation(document: Record<string, unknown>, operation: Operation): Record<string, unknown> {
	try {
		return applyOperation(document, operation, true, true, true).newDocument as Record<string, unknown>;
	} catch (error) {
		throw new SettingsPlanError(`Cannot preserve machine-only setting at ${operation.path}.`, { cause: error });
	}
}

function preserveMachinePointer(
	machine: Record<string, unknown>,
	finalSettings: Record<string, unknown>,
	pointer: string,
): Record<string, unknown> {
	validatePolicyPointer(pointer);
	const machineValue = getValueByPointer(machine, pointer);
	const finalValue = getValueByPointer(finalSettings, pointer);
	if (machineValue === undefined) {
		return finalValue === undefined
			? finalSettings
			: applyJsonOperation(finalSettings, { op: "remove", path: pointer });
	}
	if (finalValue !== undefined) {
		return applyJsonOperation(finalSettings, { op: "replace", path: pointer, value: structuredClone(machineValue) });
	}

	const segments = pointer.slice(1).split("/");
	for (let index = 1; index < segments.length; index++) {
		const parentPointer = `/${segments.slice(0, index).join("/")}`;
		if (getValueByPointer(finalSettings, parentPointer) !== undefined) continue;
		const machineParent = getValueByPointer(machine, parentPointer);
		if (machineParent === undefined || machineParent === null || typeof machineParent !== "object") {
			throw new SettingsPlanError(`Cannot preserve machine-only setting at ${pointer}.`);
		}
		finalSettings = applyJsonOperation(finalSettings, {
			op: "add",
			path: parentPointer,
			value: Array.isArray(machineParent) ? [] : {},
		});
	}
	return applyJsonOperation(finalSettings, { op: "add", path: pointer, value: structuredClone(machineValue) });
}

function settingChanges(
	machine: Record<string, unknown>,
	finalSettings: Record<string, unknown>,
): readonly Readonly<SettingChange>[] {
	const changes = compare(machine, finalSettings)
		.filter((operation) => operation.path !== "/packages" && !operation.path.startsWith("/packages/"))
		.map((operation) => {
			if (operation.op !== "add" && operation.op !== "remove" && operation.op !== "replace") {
				throw new SettingsPlanError(`Unsupported settings operation at ${operation.path}.`);
			}
			return Object.freeze({
				operation: operation.op,
				pointer: operation.path,
				reason: "SHARED REPOSITORY requires a different setting on THIS MACHINE.",
				finalResult: `${operation.path} on THIS MACHINE will match the reviewed settings result.`,
			});
		})
		.sort((left, right) => left.pointer.localeCompare(right.pointer) || left.operation.localeCompare(right.operation));
	return Object.freeze(changes);
}

function preservationRows(pointers: readonly string[]): readonly Readonly<PreservedMachineSetting>[] {
	return Object.freeze(
		[...new Set(pointers)].sort().map((pointer) => {
			validatePolicyPointer(pointer);
			return Object.freeze({
				pointer,
				reason: "Machine-only policy protects this setting from APPLY.",
				finalResult: `${pointer} will keep the THIS MACHINE value.`,
			});
		}),
	);
}

function withPackages(
	settings: Record<string, unknown>,
	declarations: readonly PackageDeclaration[],
): Record<string, unknown> {
	const result = structuredClone(settings);
	if (declarations.length === 0) delete result.packages;
	else result.packages = structuredClone(declarations);
	return result;
}

export function validateMachineOnlyPreservation(options: {
	currentMachineText: string;
	finalMachineText: string;
	policy: LocalPolicy;
}): void {
	const current = parseSettings(options.currentMachineText, { source: "machine", policy: options.policy });
	const final = parseSettings(options.finalMachineText, { source: "machine", policy: options.policy });
	for (const pointer of options.policy.machineOnlySettings) {
		validatePolicyPointer(pointer);
		if (
			stableStringify(getValueByPointer(current.value, pointer)) !==
			stableStringify(getValueByPointer(final.value, pointer))
		) {
			throw new SettingsPlanError(`Machine-only setting was not preserved at ${pointer}.`);
		}
	}
	const finalPackages = new Map(final.packages.map((entry) => [entry.identity, entry]));
	for (const entry of current.packages) {
		if (!entry.machineOnly) continue;
		const finalEntry = finalPackages.get(entry.identity);
		if (
			!finalEntry ||
			finalEntry.exactSource !== entry.exactSource ||
			stableStringify(finalEntry.declaration) !== stableStringify(entry.declaration)
		) {
			throw new SettingsPlanError(`Machine-only package declaration was not preserved: ${entry.normalizedSource}`);
		}
	}
}

export function createApplySettingsPlan(options: {
	machineText: string;
	sharedText: string;
	policy: LocalPolicy;
	packageDecisions: readonly Readonly<PackageDecision>[];
}): Readonly<ApplySettingsPlan> {
	const machine = parseSettings(options.machineText, { source: "machine", policy: options.policy });
	const shared = parseSettings(options.sharedText, { source: "shared", policy: options.policy });
	const packagePlan = planPackageChanges(machine.packages, shared.packages);
	const decidedPackages = applyPackageDecisions(packagePlan, options.packageDecisions);
	let finalSettings = structuredClone(shared.value);
	for (const pointer of options.policy.machineOnlySettings) {
		finalSettings = preserveMachinePointer(machine.value, finalSettings, pointer);
	}
	finalSettings = withPackages(finalSettings, decidedPackages.finalDeclarations);
	const finalSettingsText = stableJson(finalSettings);
	const changes = settingChanges(machine.value, finalSettings);
	const preservedMachineSettings = preservationRows(options.policy.machineOnlySettings);
	const planData = stableStringify({
		machineFingerprint: machine.fingerprint,
		sharedFingerprint: shared.fingerprint,
		finalSettingsFingerprint: fingerprint(finalSettingsText),
		settingChanges: changes,
		preservedMachineSettings,
		preservedMachinePackageSources: decidedPackages.preservedMachineSources,
		packageActions: decidedPackages.actions,
		decisionFingerprint: decidedPackages.decisionFingerprint,
	});
	if (planData === undefined) throw new SettingsPlanError("Cannot fingerprint settings plan.");
	return Object.freeze({
		planId: fingerprint(planData),
		machineFingerprint: machine.fingerprint,
		sharedFingerprint: shared.fingerprint,
		finalSettingsFingerprint: fingerprint(finalSettingsText),
		finalSettingsText,
		settingChanges: changes,
		preservedMachineSettings,
		preservedMachinePackageSources: decidedPackages.preservedMachineSources,
		packageActions: decidedPackages.actions,
		packageExecutionApproved: decidedPackages.executionApproved,
	});
}
