import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import type { InventoryFile } from "../src/files.ts";
import { buildPlanArtifact, type PlanArtifactAction } from "../src/plan.ts";
import { getBackupMetadataPath } from "../src/state.ts";
import {
	applyMachinePlan,
	buildMachineApplySet,
	createMachineApplyOperations,
	MachineApplyError,
	type MachineApplyOperations,
	verifyBackup,
} from "../src/transaction.ts";
import type { Baseline, PlanArtifact } from "../src/types.ts";
import { authorizePlanExecution } from "../src/ui.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const HASH = (value: string) => createHash("sha256").update(value).digest("hex");

function file(path: string, content: string): Readonly<InventoryFile> {
	const bytes = Buffer.from(content, "utf8");
	const sha256 = HASH(content);
	return Object.freeze({
		path,
		size: bytes.byteLength,
		sha256,
		comparisonSha256: sha256,
		executable: false,
		exactBytesBase64: bytes.toString("base64"),
	});
}

function baseline(tree: Readonly<Record<string, Readonly<InventoryFile>>>): Baseline {
	return {
		commit: "1".repeat(40),
		files: Object.fromEntries(
			Object.entries(tree).map(([path, entry]) => [
				path,
				{
					comparisonSha256: entry.comparisonSha256,
					executable: entry.executable,
					sha256: entry.sha256,
				},
			]),
		),
	};
}

function plan(
	current: Readonly<Record<string, Readonly<InventoryFile>>>,
	final: Readonly<Record<string, Readonly<InventoryFile>>>,
): Readonly<PlanArtifact> {
	const actions: PlanArtifactAction[] = [];
	const paths = [...new Set([...Object.keys(current), ...Object.keys(final)])].sort();
	for (const path of paths) {
		const currentFile = current[path];
		const finalFile = final[path];
		if (currentFile?.sha256 === finalFile?.sha256 && currentFile?.executable === finalFile?.executable) continue;
		if (finalFile) {
			actions.push({
				action: "WRITE ON THIS MACHINE",
				codeExecution: false,
				destination: "THIS MACHINE",
				direction: "shared-to-machine",
				finalResult: `${path} on THIS MACHINE will match SHARED REPOSITORY.`,
				path,
				reason: "SHARED REPOSITORY has the reviewed result.",
				resultSha256: finalFile.sha256,
				risk: "write",
				sourceSha256: currentFile?.sha256 ?? null,
			});
		} else {
			actions.push({
				action: "DELETE FROM THIS MACHINE",
				codeExecution: false,
				destination: "THIS MACHINE",
				direction: "shared-to-machine",
				finalResult: `${path} will not exist on THIS MACHINE.`,
				path,
				reason: "SHARED REPOSITORY deleted the tracked file.",
				resultSha256: null,
				risk: "deletion",
				sourceSha256: currentFile?.sha256 ?? null,
			});
		}
	}
	return buildPlanArtifact({
		createdAt: "2026-01-01T00:00:00.000Z",
		remoteCheckedAt: "2026-01-01T00:00:01.000Z",
		mode: "apply",
		baselineCommit: "1".repeat(40),
		sharedCommit: "2".repeat(40),
		machineFingerprint: "a".repeat(64),
		sharedFingerprint: "b".repeat(64),
		policyFingerprint: "c".repeat(64),
		packageFingerprint: "d".repeat(64),
		effectivePaths: paths,
		scopeExpansion: null,
		actions,
		decisions: [],
		finalMachineTree: final,
		finalSharedTree: final,
		prohibitedEffects: [],
		noOpEffects: [],
	});
}

async function writeTree(root: string, tree: Readonly<Record<string, Readonly<InventoryFile>>>): Promise<void> {
	await mkdir(root, { recursive: true });
	for (const [path, entry] of Object.entries(tree)) {
		await writeFile(join(root, path), Buffer.from(entry.exactBytesBase64 ?? "", "base64"));
	}
}

function applySet(
	current: Readonly<Record<string, Readonly<InventoryFile>>>,
	final: Readonly<Record<string, Readonly<InventoryFile>>>,
	selectedBaseline: Baseline | null = baseline(current),
) {
	const artifact = plan(current, final);
	return buildMachineApplySet({
		plan: artifact,
		authorization: authorizePlanExecution(artifact, artifact.planId),
		currentMachineTree: current,
		committedFinalMachineTree: final,
		baseline: selectedBaseline,
	});
}

function machinePath(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

describe("machine apply", () => {
	it("builds the complete set, verifies a backup, applies atomically, and verifies final hashes", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const machineRoot = join(temporary.path, "machine");
		const current = { "a.txt": file("a.txt", "old-a"), "b.txt": file("b.txt", "old-b") };
		const final = { "a.txt": file("a.txt", "new-a"), "c.txt": file("c.txt", "new-c") };
		try {
			await writeTree(machineRoot, current);
			const selectedApplySet = applySet(current, final);
			assert.deepEqual(
				selectedApplySet.operations.map(({ kind, path }) => `${kind}:${path}`),
				["write:a.txt", "delete:b.txt", "write:c.txt"],
			);
			const result = await applyMachinePlan({
				agentDirectory,
				machineRoot,
				backupId: "backup-complete",
				createdAt: "2026-01-01T00:00:00.000Z",
				applySet: selectedApplySet,
			});
			assert.equal(result.status, "success");
			assert.equal(result.backupId, "backup-complete");
			assert.equal(await readFile(join(machineRoot, "a.txt"), "utf8"), "new-a");
			await assert.rejects(
				readFile(join(machineRoot, "b.txt"), "utf8"),
				(error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
			);
			assert.equal(await readFile(join(machineRoot, "c.txt"), "utf8"), "new-c");
			const metadata = await verifyBackup({ agentDirectory, backupId: "backup-complete" });
			assert.deepEqual(metadata.entries, [
				{ executable: false, existed: true, path: "a.txt", sha256: current["a.txt"].sha256 },
				{ executable: false, existed: true, path: "b.txt", sha256: current["b.txt"].sha256 },
				{ executable: null, existed: false, path: "c.txt", sha256: null },
			]);
			assert.equal(
				await readFile(join(agentDirectory, ".config-sync", "backups", "backup-complete", "files", "a.txt"), "utf8"),
				"old-a",
			);
		} finally {
			await temporary.cleanup();
		}
	});

	it("requires a confirmed action and valid baseline for every deletion", () => {
		const current = { "a.txt": file("a.txt", "old") };
		const final = {};
		assert.throws(() => applySet(current, final, null), /does not permit the machine deletion/);
		const artifact = plan(current, final);
		assert.throws(
			() =>
				buildMachineApplySet({
					plan: artifact,
					authorization: { planId: "f".repeat(64) },
					currentMachineTree: current,
					committedFinalMachineTree: final,
					baseline: baseline(current),
				}),
			/authorization/,
		);
	});

	it("prevents the first machine change when backup verification fails", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const machineRoot = join(temporary.path, "machine");
		const current = { "a.txt": file("a.txt", "old") };
		const final = { "a.txt": file("a.txt", "new") };
		const native = createMachineApplyOperations();
		let machineWrites = 0;
		const operations: MachineApplyOperations = {
			...native,
			readFile: async (path) => {
				const content = await native.readFile(path);
				return path.includes(`${sep}backups${sep}`) ? Buffer.from("corrupt") : content;
			},
			writeAtomic: async (path, content, mode) => {
				if (machinePath(machineRoot, path)) machineWrites++;
				await native.writeAtomic(path, content, mode);
			},
		};
		try {
			await writeTree(machineRoot, current);
			await assert.rejects(
				applyMachinePlan({
					agentDirectory,
					machineRoot,
					backupId: "backup-invalid",
					createdAt: "2026-01-01T00:00:00.000Z",
					applySet: applySet(current, final),
					operations,
				}),
				/THIS MACHINE was not changed/,
			);
			assert.equal(machineWrites, 0);
			assert.equal(await readFile(join(machineRoot, "a.txt"), "utf8"), "old");
		} finally {
			await temporary.cleanup();
		}
	});

	it("restores every path after a mid-apply failure", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const machineRoot = join(temporary.path, "machine");
		const current = { "a.txt": file("a.txt", "old-a"), "b.txt": file("b.txt", "old-b") };
		const final = { "a.txt": file("a.txt", "new-a"), "b.txt": file("b.txt", "new-b") };
		const native = createMachineApplyOperations();
		let failed = false;
		const operations: MachineApplyOperations = {
			...native,
			writeAtomic: async (path, content, mode) => {
				if (machinePath(machineRoot, path) && path.endsWith("b.txt") && !failed) {
					failed = true;
					throw new Error("injected apply failure");
				}
				await native.writeAtomic(path, content, mode);
			},
		};
		try {
			await writeTree(machineRoot, current);
			try {
				await applyMachinePlan({
					agentDirectory,
					machineRoot,
					backupId: "backup-restore",
					createdAt: "2026-01-01T00:00:00.000Z",
					applySet: applySet(current, final),
					operations,
				});
				assert.fail("Expected apply failure");
			} catch (error) {
				assert.ok(error instanceof MachineApplyError);
				assert.equal(error.restored, true);
			}
			assert.equal(await readFile(join(machineRoot, "a.txt"), "utf8"), "old-a");
			assert.equal(await readFile(join(machineRoot, "b.txt"), "utf8"), "old-b");
		} finally {
			await temporary.cleanup();
		}
	});

	it("records exact manual recovery paths when automatic restore fails", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const machineRoot = join(temporary.path, "machine");
		const current = { "a.txt": file("a.txt", "old-a"), "b.txt": file("b.txt", "old-b") };
		const final = { "a.txt": file("a.txt", "new-a"), "b.txt": file("b.txt", "new-b") };
		const native = createMachineApplyOperations();
		let applyFailed = false;
		const operations: MachineApplyOperations = {
			...native,
			writeAtomic: async (path, content, mode) => {
				if (machinePath(machineRoot, path) && path.endsWith("b.txt") && !applyFailed) {
					applyFailed = true;
					throw new Error("injected apply failure");
				}
				if (machinePath(machineRoot, path) && path.endsWith("a.txt") && applyFailed) {
					throw new Error("injected restore failure");
				}
				await native.writeAtomic(path, content, mode);
			},
		};
		try {
			await writeTree(machineRoot, current);
			try {
				await applyMachinePlan({
					agentDirectory,
					machineRoot,
					backupId: "backup-manual",
					createdAt: "2026-01-01T00:00:00.000Z",
					applySet: applySet(current, final),
					operations,
				});
				assert.fail("Expected restore failure");
			} catch (error) {
				assert.ok(error instanceof MachineApplyError);
				assert.equal(error.restored, false);
				assert.deepEqual(error.manualRecoveryPaths, ["a.txt"]);
				assert.equal(error.backupId, "backup-manual");
			}
			assert.ok((await readFile(getBackupMetadataPath(agentDirectory, "backup-manual"), "utf8")).includes("a.txt"));
		} finally {
			await temporary.cleanup();
		}
	});

	it("stops apply operations at a cancellation boundary and finishes recovery before reporting", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const machineRoot = join(temporary.path, "machine");
		const current = { "a.txt": file("a.txt", "old-a"), "b.txt": file("b.txt", "old-b") };
		const final = { "a.txt": file("a.txt", "new-a"), "b.txt": file("b.txt", "new-b") };
		const controller = new AbortController();
		const native = createMachineApplyOperations();
		const writesBeforeCancellation: string[] = [];
		let machineWriteCount = 0;
		const operations: MachineApplyOperations = {
			...native,
			writeAtomic: async (path, content, mode) => {
				if (machinePath(machineRoot, path)) {
					machineWriteCount++;
					if (!controller.signal.aborted) writesBeforeCancellation.push(path);
				}
				await native.writeAtomic(path, content, mode);
				if (machinePath(machineRoot, path) && !controller.signal.aborted) controller.abort();
			},
		};
		try {
			await writeTree(machineRoot, current);
			await assert.rejects(
				applyMachinePlan({
					agentDirectory,
					machineRoot,
					backupId: "backup-cancel",
					createdAt: "2026-01-01T00:00:00.000Z",
					applySet: applySet(current, final),
					operations,
					signal: controller.signal,
				}),
				(error: unknown) => error instanceof MachineApplyError && error.restored,
			);
			assert.deepEqual(writesBeforeCancellation, [join(machineRoot, "a.txt")]);
			assert.equal(await readFile(join(machineRoot, "a.txt"), "utf8"), "old-a");
			assert.equal(await readFile(join(machineRoot, "b.txt"), "utf8"), "old-b");
			const countAtReport = machineWriteCount;
			await new Promise((accept) => setTimeout(accept, 20));
			assert.equal(machineWriteCount, countAtReport);
		} finally {
			await temporary.cleanup();
		}
	});
});
