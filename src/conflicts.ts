import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import writeFileAtomic from "write-file-atomic";
import { ensureConfigSyncDirectories, getConfigSyncPaths } from "./config.ts";
import { type InventoryFile, lstatOrUndefined, resolveManagedPath } from "./files.ts";
import type { PlanArtifact } from "./types.ts";

export type ConflictChoice = "use_machine_both" | "use_shared_both" | "keep_both_stop" | "merge_workspace";

export const CONFLICT_CHOICES = Object.freeze([
	{ choice: "use_machine_both" as const, label: "USE THIS MACHINE ON BOTH SIDES" },
	{ choice: "use_shared_both" as const, label: "USE SHARED REPOSITORY ON BOTH SIDES" },
	{ choice: "keep_both_stop" as const, label: "KEEP BOTH AND STOP" },
	{ choice: "merge_workspace" as const, label: "CREATE A SEPARATE MERGE WORKSPACE" },
]);

export interface ConflictSummary {
	path: string;
	machine: string;
	shared: string;
}

export interface ConflictDecision {
	category: "conflict";
	id: string;
	choice: ConflictChoice;
}

function sideSummary(side: "THIS MACHINE" | "SHARED REPOSITORY", file: Readonly<InventoryFile> | undefined): string {
	if (!file) return `${side}: no file at this path.`;
	return `${side}: ${file.size ?? "unknown"} bytes, SHA-256 ${file.sha256}, executable ${file.executable ? "yes" : "no"}.`;
}

export function buildConflictSummaries(options: {
	plan: Readonly<PlanArtifact>;
	machineTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	sharedTree: Readonly<Record<string, Readonly<InventoryFile>>>;
}): readonly Readonly<ConflictSummary>[] {
	return Object.freeze(
		options.plan.actions
			.filter((action) => action.risk === "conflict")
			.map((action) =>
				Object.freeze({
					path: action.path,
					machine: sideSummary("THIS MACHINE", options.machineTree[action.path]),
					shared: sideSummary("SHARED REPOSITORY", options.sharedTree[action.path]),
				}),
			),
	);
}

export async function collectConflictDecisions(options: {
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">;
	conflicts: readonly Readonly<ConflictSummary>[];
}): Promise<readonly Readonly<ConflictDecision>[] | undefined> {
	if (!options.ctx.hasUI) return undefined;
	const decisions: Readonly<ConflictDecision>[] = [];
	for (const conflict of options.conflicts) {
		const selected = await options.ctx.ui.select(
			`CONFLICT: ${conflict.path}\n${conflict.machine}\n${conflict.shared}`,
			CONFLICT_CHOICES.map((choice) => choice.label),
		);
		const choice = CONFLICT_CHOICES.find((candidate) => candidate.label === selected)?.choice;
		if (!choice) return undefined;
		decisions.push(Object.freeze({ category: "conflict", id: `conflict:${conflict.path}`, choice }));
	}
	return Object.freeze(decisions);
}

async function writeConflictCopy(root: string, path: string, file: Readonly<InventoryFile> | undefined): Promise<void> {
	if (!file) return;
	if (file.exactBytesBase64 === undefined) throw new Error(`Conflict content is unavailable: ${path}`);
	const destination = resolveManagedPath(root, path).absolutePath;
	await mkdir(dirname(destination), { recursive: true });
	await writeFileAtomic(destination, Buffer.from(file.exactBytesBase64, "base64"), {
		fsync: true,
		mode: file.executable ? 0o755 : 0o644,
	});
}

export async function createConflictMergeWorkspace(options: {
	agentDirectory: string;
	plan: Readonly<PlanArtifact>;
	decisions: readonly Readonly<ConflictDecision>[];
	machineTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	sharedTree: Readonly<Record<string, Readonly<InventoryFile>>>;
}): Promise<{ path: string; requiresNewPlan: true }> {
	const mergePaths = options.decisions
		.filter((decision) => decision.choice === "merge_workspace")
		.map((decision) => decision.id.replace(/^conflict:/, ""));
	if (mergePaths.length === 0) throw new Error("No separate merge workspace was selected.");
	await ensureConfigSyncDirectories(options.agentDirectory);
	const workspace = resolve(
		getConfigSyncPaths(options.agentDirectory).candidatesDirectory,
		`merge-${options.plan.planId}`,
	);
	if (await lstatOrUndefined(workspace))
		throw new Error("The separate merge workspace already exists and was not replaced.");
	const machineRoot = resolve(workspace, "THIS_MACHINE");
	const sharedRoot = resolve(workspace, "SHARED_REPOSITORY");
	await Promise.all([mkdir(machineRoot, { recursive: true }), mkdir(sharedRoot, { recursive: true })]);
	for (const path of mergePaths.sort()) {
		await writeConflictCopy(machineRoot, path, options.machineTree[path]);
		await writeConflictCopy(sharedRoot, path, options.sharedTree[path]);
	}
	return Object.freeze({ path: workspace, requiresNewPlan: true });
}
