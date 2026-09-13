import { createHash } from "node:crypto";
import stableStringify from "json-stable-stringify";
import type { FileInventory, InventoryFile } from "./files.ts";
import { CONFIG_SYNC_SCHEMA_VERSION, type FileFingerprint, type PlanArtifact } from "./types.ts";

export type SyncMode = "publish" | "apply" | "reconcile";

export type FileActionName =
	| "WRITE ON THIS MACHINE"
	| "DELETE FROM THIS MACHINE"
	| "WRITE IN SHARED REPOSITORY"
	| "DELETE FROM SHARED REPOSITORY"
	| "UPDATE BASELINE ONLY"
	| "CONFLICT — NO ACTION SELECTED";

export type PlanRisk = "policy" | "package" | "conflict" | "deletion" | "write" | "baseline";
export type PlanDirection = "machine-to-shared" | "shared-to-machine" | "baseline-only" | "none";

export interface PlanActionSortItem {
	risk: PlanRisk;
	path: string;
}

export interface FilePlanAction extends PlanActionSortItem {
	action: FileActionName;
	direction: PlanDirection;
	reason: string;
	finalResult: string;
}

export interface SyncPlan {
	mode: SyncMode;
	actions: readonly Readonly<FilePlanAction>[];
	blocked: boolean;
	blockers: readonly string[];
	finalMachineTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	finalSharedTree: Readonly<Record<string, Readonly<InventoryFile>>>;
}

const RISK_ORDER: Readonly<Record<PlanRisk, number>> = Object.freeze({
	policy: 0,
	package: 1,
	conflict: 2,
	deletion: 3,
	write: 4,
	baseline: 5,
});

function equivalent(left: Readonly<InventoryFile> | undefined, right: Readonly<InventoryFile> | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.comparisonSha256 === right.comparisonSha256 && left.executable === right.executable;
}

function createAction(
	path: string,
	action: FileActionName,
	risk: PlanRisk,
	direction: PlanDirection,
	reason: string,
	finalResult: string,
): Readonly<FilePlanAction> {
	return Object.freeze({ action, direction, finalResult, path, reason, risk });
}

function writeInShared(path: string, reason: string): Readonly<FilePlanAction> {
	return createAction(
		path,
		"WRITE IN SHARED REPOSITORY",
		"write",
		"machine-to-shared",
		reason,
		`${path} in SHARED REPOSITORY will match THIS MACHINE.`,
	);
}

function writeOnMachine(path: string, reason: string): Readonly<FilePlanAction> {
	return createAction(
		path,
		"WRITE ON THIS MACHINE",
		"write",
		"shared-to-machine",
		reason,
		`${path} on THIS MACHINE will match SHARED REPOSITORY.`,
	);
}

function deleteFromShared(path: string): Readonly<FilePlanAction> {
	return createAction(
		path,
		"DELETE FROM SHARED REPOSITORY",
		"deletion",
		"machine-to-shared",
		"THIS MACHINE deleted the tracked file while SHARED REPOSITORY kept the baseline value.",
		`${path} will not exist in SHARED REPOSITORY.`,
	);
}

function deleteFromMachine(path: string): Readonly<FilePlanAction> {
	return createAction(
		path,
		"DELETE FROM THIS MACHINE",
		"deletion",
		"shared-to-machine",
		"SHARED REPOSITORY deleted the tracked file while THIS MACHINE kept the baseline value.",
		`${path} will not exist on THIS MACHINE.`,
	);
}

function updateBaseline(path: string, reason: string): Readonly<FilePlanAction> {
	return createAction(
		path,
		"UPDATE BASELINE ONLY",
		"baseline",
		"baseline-only",
		reason,
		`The baseline will record the common result for ${path}.`,
	);
}

function conflict(path: string, reason: string): Readonly<FilePlanAction> {
	return createAction(
		path,
		"CONFLICT — NO ACTION SELECTED",
		"conflict",
		"none",
		reason,
		`THIS MACHINE and SHARED REPOSITORY will keep their current values for ${path}.`,
	);
}

export function classifyFile(
	path: string,
	baseline: Readonly<InventoryFile> | undefined,
	machine: Readonly<InventoryFile> | undefined,
	shared: Readonly<InventoryFile> | undefined,
): Readonly<FilePlanAction> | undefined {
	if (baseline === undefined) {
		if (machine === undefined && shared === undefined) return undefined;
		if (machine !== undefined && shared === undefined) {
			return writeInShared(path, "THIS MACHINE has an untracked file and SHARED REPOSITORY has no file at this path.");
		}
		if (machine === undefined && shared !== undefined) {
			return writeOnMachine(path, "SHARED REPOSITORY has an untracked file and THIS MACHINE has no file at this path.");
		}
		if (equivalent(machine, shared)) {
			return updateBaseline(path, "THIS MACHINE and SHARED REPOSITORY have the same untracked value.");
		}
		return conflict(path, "THIS MACHINE and SHARED REPOSITORY have different untracked values.");
	}

	if (equivalent(machine, shared)) {
		if (equivalent(machine, baseline)) return undefined;
		return updateBaseline(path, "THIS MACHINE and SHARED REPOSITORY already have the same result.");
	}

	const machineUnchanged = equivalent(machine, baseline);
	const sharedUnchanged = equivalent(shared, baseline);
	if (machineUnchanged) {
		return shared === undefined
			? deleteFromMachine(path)
			: writeOnMachine(path, "SHARED REPOSITORY changed the tracked file while THIS MACHINE kept the baseline value.");
	}
	if (sharedUnchanged) {
		return machine === undefined
			? deleteFromShared(path)
			: writeInShared(path, "THIS MACHINE changed the tracked file while SHARED REPOSITORY kept the baseline value.");
	}
	return conflict(path, "THIS MACHINE and SHARED REPOSITORY changed the tracked file to different results.");
}

export function sortPlanActions<T extends PlanActionSortItem>(actions: readonly T[]): T[] {
	return [...actions].sort(
		(left, right) => RISK_ORDER[left.risk] - RISK_ORDER[right.risk] || left.path.localeCompare(right.path),
	);
}

function cloneTree(files: Readonly<Record<string, Readonly<InventoryFile>>>): Record<string, Readonly<InventoryFile>> {
	return Object.fromEntries(Object.entries(files).map(([path, file]) => [path, Object.freeze({ ...file })] as const));
}

function publishAction(action: Readonly<FilePlanAction>): boolean {
	return action.direction === "machine-to-shared";
}

function applyAction(action: Readonly<FilePlanAction>): boolean {
	return action.direction === "shared-to-machine";
}

function blockersFor(mode: SyncMode, actions: readonly Readonly<FilePlanAction>[]): string[] {
	const blockers: string[] = [];
	for (const action of actions) {
		if (action.risk === "conflict") {
			blockers.push(`${action.path} is a conflict between THIS MACHINE and SHARED REPOSITORY.`);
		} else if (mode === "publish" && applyAction(action)) {
			blockers.push(`${action.path} requires APPLY from SHARED REPOSITORY to THIS MACHINE.`);
		} else if (mode === "apply" && publishAction(action)) {
			blockers.push(`${action.path} requires PUBLISH from THIS MACHINE to SHARED REPOSITORY.`);
		}
	}
	return blockers;
}

function applyActionsToTrees(
	actions: readonly Readonly<FilePlanAction>[],
	machineInput: Readonly<Record<string, Readonly<InventoryFile>>>,
	sharedInput: Readonly<Record<string, Readonly<InventoryFile>>>,
): {
	machine: Readonly<Record<string, Readonly<InventoryFile>>>;
	shared: Readonly<Record<string, Readonly<InventoryFile>>>;
} {
	const machine = cloneTree(machineInput);
	const shared = cloneTree(sharedInput);
	for (const action of actions) {
		switch (action.action) {
			case "WRITE ON THIS MACHINE":
				machine[action.path] = shared[action.path];
				break;
			case "DELETE FROM THIS MACHINE":
				delete machine[action.path];
				break;
			case "WRITE IN SHARED REPOSITORY":
				shared[action.path] = machine[action.path];
				break;
			case "DELETE FROM SHARED REPOSITORY":
				delete shared[action.path];
				break;
			case "UPDATE BASELINE ONLY":
			case "CONFLICT — NO ACTION SELECTED":
				break;
		}
	}
	return { machine: Object.freeze(machine), shared: Object.freeze(shared) };
}

export function createSyncPlan(input: {
	mode: SyncMode;
	machine: Pick<FileInventory, "files">;
	shared: Pick<FileInventory, "files">;
	baseline: Pick<FileInventory, "files">;
}): Readonly<SyncPlan> {
	const paths = [
		...new Set([
			...Object.keys(input.machine.files),
			...Object.keys(input.shared.files),
			...Object.keys(input.baseline.files),
		]),
	].sort();
	const actions = sortPlanActions(
		paths
			.map((path) =>
				classifyFile(path, input.baseline.files[path], input.machine.files[path], input.shared.files[path]),
			)
			.filter((action): action is Readonly<FilePlanAction> => action !== undefined),
	);
	const blockers = blockersFor(input.mode, actions);
	const finalTrees =
		blockers.length === 0
			? applyActionsToTrees(actions, input.machine.files, input.shared.files)
			: {
					machine: Object.freeze(cloneTree(input.machine.files)),
					shared: Object.freeze(cloneTree(input.shared.files)),
				};
	return Object.freeze({
		mode: input.mode,
		actions: Object.freeze(actions),
		blocked: blockers.length > 0,
		blockers: Object.freeze(blockers),
		finalMachineTree: finalTrees.machine,
		finalSharedTree: finalTrees.shared,
	});
}

export type PlanArtifactAction = PlanArtifact["actions"][number];
export type PlanDecision = PlanArtifact["decisions"][number];
export type PlanEffect = PlanArtifact["prohibitedEffects"][number];

export interface BuildPlanArtifactOptions {
	createdAt: string;
	remoteCheckedAt: string;
	mode: SyncMode;
	baselineCommit: string | null;
	sharedCommit: string | null;
	machineFingerprint: string;
	sharedFingerprint: string;
	policyFingerprint: string;
	packageFingerprint: string;
	effectivePaths: readonly string[];
	scopeExpansion: readonly string[] | null;
	actions: readonly PlanArtifactAction[];
	decisions: readonly PlanDecision[];
	finalMachineTree: Readonly<Record<string, Readonly<InventoryFile | FileFingerprint>>>;
	finalSharedTree: Readonly<Record<string, Readonly<InventoryFile | FileFingerprint>>>;
	prohibitedEffects: readonly PlanEffect[];
	noOpEffects: readonly PlanEffect[];
}

function artifactTree(
	files: Readonly<Record<string, Readonly<InventoryFile | FileFingerprint>>>,
): Readonly<Record<string, Readonly<FileFingerprint>>> {
	const entries = Object.entries(files)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([path, file]) => [
			path,
			Object.freeze({
				comparisonSha256: file.comparisonSha256,
				executable: file.executable,
				sha256: file.sha256,
			}),
		]);
	return Object.freeze(Object.fromEntries(entries));
}

function expectedDestination(direction: PlanDirection): PlanArtifactAction["destination"] {
	switch (direction) {
		case "machine-to-shared":
			return "SHARED REPOSITORY";
		case "shared-to-machine":
			return "THIS MACHINE";
		case "baseline-only":
			return "BASELINE";
		case "none":
			return "NONE";
	}
}

function artifactAction(action: PlanArtifactAction): Readonly<PlanArtifactAction> {
	if (action.destination !== expectedDestination(action.direction)) {
		throw new Error(`Plan action has the wrong destination: ${action.path}`);
	}
	const namedDestination =
		action.action === "WRITE ON THIS MACHINE" ||
		action.action === "DELETE FROM THIS MACHINE" ||
		action.action === "INSTALL PACKAGE ON THIS MACHINE" ||
		action.action === "REMOVE PACKAGE FROM THIS MACHINE"
			? "THIS MACHINE"
			: action.action === "WRITE IN SHARED REPOSITORY" || action.action === "DELETE FROM SHARED REPOSITORY"
				? "SHARED REPOSITORY"
				: action.action === "UPDATE BASELINE ONLY"
					? "BASELINE"
					: action.action === "CONFLICT — NO ACTION SELECTED"
						? "NONE"
						: undefined;
	if (namedDestination && action.destination !== namedDestination) {
		throw new Error(`Plan action name has the wrong destination: ${action.path}`);
	}
	if ((action.risk === "write" || action.risk === "deletion") && action.destination === "NONE") {
		throw new Error(`Write or deletion has no destination: ${action.path}`);
	}
	return Object.freeze({ ...action });
}

function artifactDecision(decision: PlanDecision): Readonly<PlanDecision> {
	return Object.freeze({ ...decision });
}

function artifactEffect(effect: PlanEffect): Readonly<PlanEffect> {
	return Object.freeze({ ...effect });
}

function securityAction(action: Readonly<PlanArtifactAction>): Record<string, unknown> {
	return {
		action: action.action,
		bestEffort: action.bestEffort ?? false,
		codeExecution: action.codeExecution,
		destination: action.destination,
		direction: action.direction,
		exactPackageSource: action.exactPackageSource ?? null,
		normalizedPackageSource: action.normalizedPackageSource ?? null,
		packageOperation: action.packageOperation ?? null,
		path: action.path,
		previousExactPackageSource: action.previousExactPackageSource ?? null,
		previousNormalizedPackageSource: action.previousNormalizedPackageSource ?? null,
		resultSha256: action.resultSha256,
		risk: action.risk,
		sourceSha256: action.sourceSha256,
	};
}

function securityEffect(effect: Readonly<PlanEffect>): Record<string, unknown> {
	return {
		code: effect.code,
		count: effect.count ?? null,
		destination: effect.destination,
		path: effect.path ?? null,
	};
}

export function buildPlanArtifact(options: BuildPlanArtifactOptions): Readonly<PlanArtifact> {
	const actions = sortPlanActions(options.actions).map(artifactAction);
	const decisions = [...options.decisions]
		.sort((left, right) => left.category.localeCompare(right.category) || left.id.localeCompare(right.id))
		.map(artifactDecision);
	const prohibitedEffects = [...options.prohibitedEffects]
		.sort((left, right) => left.code.localeCompare(right.code) || (left.path ?? "").localeCompare(right.path ?? ""))
		.map(artifactEffect);
	const noOpEffects = [...options.noOpEffects]
		.sort((left, right) => left.code.localeCompare(right.code) || (left.path ?? "").localeCompare(right.path ?? ""))
		.map(artifactEffect);
	Object.freeze(actions);
	Object.freeze(decisions);
	Object.freeze(prohibitedEffects);
	Object.freeze(noOpEffects);
	const finalMachineTree = artifactTree(options.finalMachineTree);
	const finalSharedTree = artifactTree(options.finalSharedTree);
	const securityData = {
		schemaVersion: CONFIG_SYNC_SCHEMA_VERSION,
		createdAt: options.createdAt,
		remoteCheckedAt: options.remoteCheckedAt,
		mode: options.mode,
		baselineCommit: options.baselineCommit,
		sharedCommit: options.sharedCommit,
		machineFingerprint: options.machineFingerprint,
		sharedFingerprint: options.sharedFingerprint,
		policyFingerprint: options.policyFingerprint,
		packageFingerprint: options.packageFingerprint,
		effectivePaths: [...options.effectivePaths].sort(),
		scopeExpansion: options.scopeExpansion ? [...options.scopeExpansion].sort() : null,
		actions: actions.map(securityAction),
		decisions,
		finalMachineTree,
		finalSharedTree,
		prohibitedEffects: prohibitedEffects.map(securityEffect),
		noOpEffects: noOpEffects.map(securityEffect),
	};
	const canonical = stableStringify(securityData);
	if (canonical === undefined) throw new Error("Cannot create canonical plan data.");
	const planId = createHash("sha256").update(canonical).digest("hex");
	return Object.freeze({
		...securityData,
		actions,
		decisions,
		prohibitedEffects,
		noOpEffects,
		planId,
		shortPlanId: planId.slice(0, 12),
	});
}
