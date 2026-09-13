import type { FileInventory, InventoryFile } from "./files.ts";

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
