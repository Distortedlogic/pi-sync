import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { expect } from "expect";
import stableStringify from "json-stable-stringify";
import { createDefaultLocalPolicy, getConfigSyncPaths } from "../src/config.ts";
import { buildInventorySet, type FileInventory, type InventoryFile, type InventorySet } from "../src/files.ts";
import {
	createCandidateCommit,
	fetchSharedSnapshot,
	type GitExec,
	publishCandidateCommit,
	SHARED_MANIFEST_PATH,
	type SharedSnapshot,
	withSharedSnapshotWorktree,
} from "../src/git.ts";
import {
	buildPlanArtifact,
	createSyncPlan,
	type FilePlanAction,
	type PlanArtifactAction,
	type SyncMode,
	type SyncPlan,
} from "../src/plan.ts";
import { applyMachinePlan, buildMachineApplySet } from "../src/transaction.ts";
import type { Baseline, PlanArtifact, RepositoryConfig } from "../src/types.ts";
import { authorizePlanExecution } from "../src/ui.ts";
import { createTemporaryAgentDirectory, createTemporaryBareGitRepository } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const MANAGED_PATTERNS = ["settings.json", "skills/**"];

function gitExec(): GitExec {
	return async (command, args, options): Promise<ExecResult> => {
		try {
			const result = await execFileAsync(command, args, {
				cwd: options?.cwd,
				signal: options?.signal,
				timeout: options?.timeout,
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
			});
			return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
		} catch (error) {
			const result = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: typeof result.code === "number" ? result.code : 1,
				killed: result.killed ?? false,
			};
		}
	};
}

async function seedSharedRepository(repositoryPath: string, root: string): Promise<string> {
	const checkout = join(root, "seed");
	await execFileAsync("git", ["clone", repositoryPath, checkout]);
	await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: checkout });
	await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
	await mkdir(join(checkout, "skills"));
	await Promise.all([
		writeFile(join(checkout, "settings.json"), "{}\n"),
		writeFile(join(checkout, "skills", "rule.md"), "machine-one\n"),
		writeFile(
			join(checkout, SHARED_MANIFEST_PATH),
			`${JSON.stringify({ managedScope: MANAGED_PATTERNS, schemaVersion: 1 })}\n`,
		),
	]);
	await execFileAsync("git", ["add", "--all"], { cwd: checkout });
	await execFileAsync("git", ["commit", "-m", "Initial shared configuration"], { cwd: checkout });
	await execFileAsync("git", ["push", "origin", "HEAD:main"], { cwd: checkout });
	return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
}

async function inventoryFor(
	exec: GitExec,
	machineRoot: string,
	snapshot: Readonly<SharedSnapshot>,
	baseline: Baseline | null,
): Promise<Readonly<InventorySet>> {
	return withSharedSnapshotWorktree({
		exec,
		snapshot,
		run: (sharedRoot) => buildInventorySet({ machineRoot, sharedRoot, baseline, managedPatterns: MANAGED_PATTERNS }),
	});
}

function treeFingerprint(files: Readonly<Record<string, Readonly<InventoryFile>>>): string {
	const canonical = stableStringify(
		Object.fromEntries(
			Object.entries(files)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([path, file]) => [path, { sha256: file.sha256, executable: file.executable }]),
		),
	);
	if (canonical === undefined) throw new Error("Cannot fingerprint test inventory.");
	return createHash("sha256").update(canonical).digest("hex");
}

function artifactAction(
	action: Readonly<FilePlanAction>,
	plan: Readonly<SyncPlan>,
	machine: Pick<FileInventory, "files">,
	shared: Pick<FileInventory, "files">,
): PlanArtifactAction {
	const destination =
		action.direction === "machine-to-shared"
			? "SHARED REPOSITORY"
			: action.direction === "shared-to-machine"
				? "THIS MACHINE"
				: "BASELINE";
	const source = action.direction === "machine-to-shared" ? shared.files[action.path] : machine.files[action.path];
	const result =
		action.direction === "machine-to-shared" ? plan.finalSharedTree[action.path] : plan.finalMachineTree[action.path];
	return {
		action: action.action,
		codeExecution: false,
		destination,
		direction: action.direction,
		finalResult: action.finalResult,
		path: action.path,
		reason: action.reason,
		resultSha256: result?.sha256 ?? null,
		risk: action.risk,
		sourceSha256: source?.sha256 ?? null,
	};
}

function createArtifact(options: {
	mode: SyncMode;
	commit: string;
	inventories: Readonly<InventorySet>;
	plan: Readonly<SyncPlan>;
}): Readonly<PlanArtifact> {
	return buildPlanArtifact({
		actions: options.plan.actions.map((action) =>
			artifactAction(action, options.plan, options.inventories.machine, options.inventories.shared),
		),
		baselineCommit: options.inventories.baseline.files["settings.json"] ? options.commit : null,
		createdAt: "2026-01-01T00:00:00.000Z",
		decisions: [],
		effectivePaths: [
			...new Set([...Object.keys(options.plan.finalMachineTree), ...Object.keys(options.plan.finalSharedTree)]),
		],
		finalMachineTree: options.plan.finalMachineTree,
		finalSharedTree: options.plan.finalSharedTree,
		machineFingerprint: treeFingerprint(options.inventories.machine.files),
		mode: options.mode,
		noOpEffects: [],
		packageFingerprint: createHash("sha256").update("[]").digest("hex"),
		policyFingerprint: createHash("sha256")
			.update(stableStringify(createDefaultLocalPolicy()) ?? "")
			.digest("hex"),
		prohibitedEffects: [],
		remoteCheckedAt: "2026-01-01T00:00:01.000Z",
		sharedCommit: options.commit,
		sharedFingerprint: treeFingerprint(options.inventories.shared.files),
		scopeExpansion: null,
	});
}

function baseline(commit: string, files: Readonly<Record<string, Readonly<InventoryFile>>>): Baseline {
	return {
		commit,
		files: Object.fromEntries(
			Object.entries(files).map(([path, file]) => [
				path,
				{ comparisonSha256: file.comparisonSha256, executable: file.executable, sha256: file.sha256 },
			]),
		),
	};
}

async function applyPlan(options: {
	agentDirectory: string;
	artifact: Readonly<PlanArtifact>;
	inventories: Readonly<InventorySet>;
	plan: Readonly<SyncPlan>;
	baseline: Baseline | null;
	backupId: string;
}): Promise<void> {
	const authorization = authorizePlanExecution(options.artifact, options.artifact.planId);
	const applySet = buildMachineApplySet({
		plan: options.artifact,
		authorization,
		currentMachineTree: options.inventories.machine.files,
		committedFinalMachineTree: options.plan.finalMachineTree,
		baseline: options.baseline,
	});
	await applyMachinePlan({
		agentDirectory: options.agentDirectory,
		machineRoot: options.agentDirectory,
		backupId: options.backupId,
		createdAt: "2026-01-01T00:00:02.000Z",
		applySet,
	});
}

describe("two-machine end-to-end synchronization", () => {
	it("sets up a second machine, publishes its change, and applies the exact commit on the first machine", {
		timeout: 15_000,
	}, async () => {
		const machineOne = await createTemporaryAgentDirectory();
		const machineTwo = await createTemporaryAgentDirectory();
		const seed = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const exec = gitExec();
		const repository: RepositoryConfig = { branch: "main", repositoryPath: shared.path };
		try {
			const initialCommit = await seedSharedRepository(shared.path, seed.path);
			await mkdir(join(machineOne.path, "skills"));
			await Promise.all([
				writeFile(join(machineOne.path, "settings.json"), "{}\n"),
				writeFile(join(machineOne.path, "skills", "rule.md"), "machine-one\n"),
			]);

			const secondSnapshotResult = await fetchSharedSnapshot({
				exec,
				agentDirectory: machineTwo.path,
				repository,
			});
			if (secondSnapshotResult.status !== "ready") throw new Error("Second-machine snapshot is unavailable.");
			const secondInitialInventory = await inventoryFor(exec, machineTwo.path, secondSnapshotResult.snapshot, null);
			const secondApplyPlan = createSyncPlan({
				mode: "apply",
				machine: secondInitialInventory.machine,
				shared: secondInitialInventory.shared,
				baseline: secondInitialInventory.baseline,
			});
			expect(secondApplyPlan.blocked).toBe(false);
			const secondApplyArtifact = createArtifact({
				mode: "apply",
				commit: initialCommit,
				inventories: secondInitialInventory,
				plan: secondApplyPlan,
			});
			await applyPlan({
				agentDirectory: machineTwo.path,
				artifact: secondApplyArtifact,
				inventories: secondInitialInventory,
				plan: secondApplyPlan,
				baseline: null,
				backupId: "machine-two-setup",
			});
			expect(await readFile(join(machineTwo.path, "skills", "rule.md"), "utf8")).toBe("machine-one\n");

			const initialBaseline = baseline(initialCommit, secondInitialInventory.shared.files);
			await writeFile(join(machineTwo.path, "skills", "rule.md"), "machine-two\n");
			const publishSnapshotResult = await fetchSharedSnapshot({ exec, agentDirectory: machineTwo.path, repository });
			if (publishSnapshotResult.status !== "ready") throw new Error("PUBLISH snapshot is unavailable.");
			const publishInventory = await inventoryFor(
				exec,
				machineTwo.path,
				publishSnapshotResult.snapshot,
				initialBaseline,
			);
			const publishPlan = createSyncPlan({
				mode: "publish",
				machine: publishInventory.machine,
				shared: publishInventory.shared,
				baseline: publishInventory.baseline,
			});
			expect(publishPlan.actions.map((action) => action.action)).toEqual(["WRITE IN SHARED REPOSITORY"]);
			const publishArtifact = createArtifact({
				mode: "publish",
				commit: initialCommit,
				inventories: publishInventory,
				plan: publishPlan,
			});
			const candidate = await createCandidateCommit({
				exec,
				snapshot: publishSnapshotResult.snapshot,
				planId: publishArtifact.planId,
				currentSharedTree: publishInventory.shared.files,
				finalSharedTree: publishPlan.finalSharedTree,
				validation: { managedPatterns: MANAGED_PATTERNS },
			});
			const published = await publishCandidateCommit({ exec, candidate });
			expect(published.status).toBe("published");
			if (published.status !== "published") return;

			const firstSnapshotResult = await fetchSharedSnapshot({ exec, agentDirectory: machineOne.path, repository });
			if (firstSnapshotResult.status !== "ready") throw new Error("First-machine snapshot is unavailable.");
			const firstInventory = await inventoryFor(exec, machineOne.path, firstSnapshotResult.snapshot, initialBaseline);
			const firstApplyPlan = createSyncPlan({
				mode: "apply",
				machine: firstInventory.machine,
				shared: firstInventory.shared,
				baseline: firstInventory.baseline,
			});
			expect(firstApplyPlan.actions.map((action) => action.action)).toEqual(["WRITE ON THIS MACHINE"]);
			const firstApplyArtifact = createArtifact({
				mode: "apply",
				commit: published.publishedCommit,
				inventories: firstInventory,
				plan: firstApplyPlan,
			});
			await applyPlan({
				agentDirectory: machineOne.path,
				artifact: firstApplyArtifact,
				inventories: firstInventory,
				plan: firstApplyPlan,
				baseline: initialBaseline,
				backupId: "machine-one-apply",
			});
			expect(await readFile(join(machineOne.path, "skills", "rule.md"), "utf8")).toBe("machine-two\n");
			expect(await readFile(join(machineTwo.path, "skills", "rule.md"), "utf8")).toBe("machine-two\n");
			expect(await readdir(getConfigSyncPaths(machineOne.path).candidatesDirectory)).toEqual([]);
			expect(await readdir(getConfigSyncPaths(machineTwo.path).candidatesDirectory)).toEqual([]);
		} finally {
			await Promise.all([machineOne.cleanup(), machineTwo.cleanup(), seed.cleanup(), shared.cleanup()]);
		}
	});
});
