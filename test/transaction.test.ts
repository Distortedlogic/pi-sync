import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { describe, it } from "node:test";
import type { InventoryFile } from "../src/files.ts";
import { buildPlanArtifact, type PlanArtifactAction } from "../src/plan.ts";
import { getBackupMetadataPath } from "../src/state.ts";
import {
	applyMachineFilesFromBackup,
	applyMachinePlan,
	buildMachineApplySet,
	createMachineApplyOperations,
	createVerifiedMachineBackup,
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
		const destination = join(root, path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, Buffer.from(entry.exactBytesBase64 ?? "", "base64"));
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

async function createFailureFixture() {
	const temporary = await createTemporaryAgentDirectory();
	const agentDirectory = join(temporary.path, "agent");
	const machineRoot = join(temporary.path, "machine");
	const current = { "a.txt": file("a.txt", "old-a"), "b.txt": file("b.txt", "old-b") };
	const final = { "a.txt": file("a.txt", "new-a"), "b.txt": file("b.txt", "new-b") };
	await writeTree(machineRoot, current);
	return { temporary, agentDirectory, machineRoot, selectedApplySet: applySet(current, final) };
}

describe("machine apply", () => {
	it("builds the complete set, verifies a backup, applies atomically, and verifies final hashes", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const machineRoot = join(temporary.path, "machine");
		const current = {
			"agent/a.txt": file("agent/a.txt", "old-a"),
			"agent/b.txt": file("agent/b.txt", "old-b"),
		};
		const final = {
			"agent/a.txt": file("agent/a.txt", "new-a"),
			"agent/c.txt": file("agent/c.txt", "new-c"),
		};
		try {
			await writeTree(machineRoot, current);
			const selectedApplySet = applySet(current, final);
			assert.deepEqual(
				selectedApplySet.operations.map(({ kind, path }) => `${kind}:${path}`),
				["write:agent/a.txt", "delete:agent/b.txt", "write:agent/c.txt"],
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
			assert.equal(await readFile(join(machineRoot, "agent", "a.txt"), "utf8"), "new-a");
			await assert.rejects(
				readFile(join(machineRoot, "agent", "b.txt"), "utf8"),
				(error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
			);
			assert.equal(await readFile(join(machineRoot, "agent", "c.txt"), "utf8"), "new-c");
			const metadata = await verifyBackup({ agentDirectory, backupId: "backup-complete" });
			assert.deepEqual(metadata.entries, [
				{ executable: false, existed: true, path: "agent/a.txt", sha256: current["agent/a.txt"].sha256 },
				{ executable: false, existed: true, path: "agent/b.txt", sha256: current["agent/b.txt"].sha256 },
				{ executable: null, existed: false, path: "agent/c.txt", sha256: null },
			]);
			assert.equal(
				await readFile(
					join(agentDirectory, ".config-sync", "backups", "backup-complete", "files", "agent", "a.txt"),
					"utf8",
				),
				"old-a",
			);
		} finally {
			await temporary.cleanup();
		}
	});

	it("gives the reviewed managed file precedence over a package-created file", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const machineRoot = join(temporary.path, "machine");
		const path = "agent/extensions/generated/index.ts";
		const current = {};
		const final = { [path]: file(path, "reviewed") };
		try {
			await writeTree(machineRoot, current);
			const selectedApplySet = applySet(current, final);
			await createVerifiedMachineBackup({
				agentDirectory,
				machineRoot,
				backupId: "backup-package-created",
				createdAt: "2026-01-01T00:00:00.000Z",
				applySet: selectedApplySet,
			});
			await mkdir(join(machineRoot, "agent", "extensions", "generated"), { recursive: true });
			await writeFile(join(machineRoot, path), "package-created");

			await applyMachineFilesFromBackup({
				agentDirectory,
				machineRoot,
				backupId: "backup-package-created",
				applySet: selectedApplySet,
				verifyFinal: true,
			});

			assert.equal(await readFile(join(machineRoot, path), "utf8"), "reviewed");
			assert.deepEqual((await verifyBackup({ agentDirectory, backupId: "backup-package-created" })).entries, [
				{ executable: null, existed: false, path, sha256: null },
			]);
		} finally {
			await temporary.cleanup();
		}
	});

	it("requires a confirmed action and valid baseline for every deletion", () => {
		const current = { "agent/settings.json": file("agent/settings.json", "old") };
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
		const fixture = await createFailureFixture();
		const native = createMachineApplyOperations();
		let machineWrites = 0;
		const operations: MachineApplyOperations = {
			...native,
			readFile: async (path) => {
				const content = await native.readFile(path);
				return path.includes(`${sep}backups${sep}`) ? Buffer.from("corrupt") : content;
			},
			writeAtomic: async (path, content, mode) => {
				if (machinePath(fixture.machineRoot, path)) machineWrites++;
				await native.writeAtomic(path, content, mode);
			},
		};
		try {
			await assert.rejects(
				applyMachinePlan({
					agentDirectory: fixture.agentDirectory,
					machineRoot: fixture.machineRoot,
					backupId: "backup-invalid",
					createdAt: "2026-01-01T00:00:00.000Z",
					applySet: fixture.selectedApplySet,
					operations,
				}),
				/THIS MACHINE was not changed/,
			);
			assert.equal(machineWrites, 0);
			assert.equal(await readFile(join(fixture.machineRoot, "a.txt"), "utf8"), "old-a");
		} finally {
			await fixture.temporary.cleanup();
		}
	});

	it("restores every path after a mid-apply failure", async () => {
		const fixture = await createFailureFixture();
		const native = createMachineApplyOperations();
		let failed = false;
		const operations: MachineApplyOperations = {
			...native,
			writeAtomic: async (path, content, mode) => {
				if (machinePath(fixture.machineRoot, path) && path.endsWith("b.txt") && !failed) {
					failed = true;
					throw new Error("injected apply failure");
				}
				await native.writeAtomic(path, content, mode);
			},
		};
		try {
			try {
				await applyMachinePlan({
					agentDirectory: fixture.agentDirectory,
					machineRoot: fixture.machineRoot,
					backupId: "backup-restore",
					createdAt: "2026-01-01T00:00:00.000Z",
					applySet: fixture.selectedApplySet,
					operations,
				});
				assert.fail("Expected apply failure");
			} catch (error) {
				assert.ok(error instanceof MachineApplyError);
				assert.equal(error.restored, true);
			}
			assert.equal(await readFile(join(fixture.machineRoot, "a.txt"), "utf8"), "old-a");
			assert.equal(await readFile(join(fixture.machineRoot, "b.txt"), "utf8"), "old-b");
		} finally {
			await fixture.temporary.cleanup();
		}
	});

	it("records exact manual recovery paths when automatic restore fails", async () => {
		const fixture = await createFailureFixture();
		const native = createMachineApplyOperations();
		let applyFailed = false;
		const operations: MachineApplyOperations = {
			...native,
			writeAtomic: async (path, content, mode) => {
				if (machinePath(fixture.machineRoot, path) && path.endsWith("b.txt") && !applyFailed) {
					applyFailed = true;
					throw new Error("injected apply failure");
				}
				if (machinePath(fixture.machineRoot, path) && path.endsWith("a.txt") && applyFailed) {
					throw new Error("injected restore failure");
				}
				await native.writeAtomic(path, content, mode);
			},
		};
		try {
			try {
				await applyMachinePlan({
					agentDirectory: fixture.agentDirectory,
					machineRoot: fixture.machineRoot,
					backupId: "backup-manual",
					createdAt: "2026-01-01T00:00:00.000Z",
					applySet: fixture.selectedApplySet,
					operations,
				});
				assert.fail("Expected restore failure");
			} catch (error) {
				assert.ok(error instanceof MachineApplyError);
				assert.equal(error.restored, false);
				assert.deepEqual(error.manualRecoveryPaths, ["a.txt"]);
				assert.equal(error.backupId, "backup-manual");
			}
			assert.ok(
				(await readFile(getBackupMetadataPath(fixture.agentDirectory, "backup-manual"), "utf8")).includes("a.txt"),
			);
		} finally {
			await fixture.temporary.cleanup();
		}
	});

	it("stops apply operations at a cancellation boundary and finishes recovery before reporting", async () => {
		const fixture = await createFailureFixture();
		const controller = new AbortController();
		const native = createMachineApplyOperations();
		const writesBeforeCancellation: string[] = [];
		const operations: MachineApplyOperations = {
			...native,
			writeAtomic: async (path, content, mode) => {
				if (machinePath(fixture.machineRoot, path) && !controller.signal.aborted) {
					writesBeforeCancellation.push(path);
				}
				await native.writeAtomic(path, content, mode);
				if (machinePath(fixture.machineRoot, path) && !controller.signal.aborted) controller.abort();
			},
		};
		try {
			await assert.rejects(
				applyMachinePlan({
					agentDirectory: fixture.agentDirectory,
					machineRoot: fixture.machineRoot,
					backupId: "backup-cancel",
					createdAt: "2026-01-01T00:00:00.000Z",
					applySet: fixture.selectedApplySet,
					operations,
					signal: controller.signal,
				}),
				(error: unknown) => error instanceof MachineApplyError && error.restored,
			);
			assert.deepEqual(writesBeforeCancellation, [join(fixture.machineRoot, "a.txt")]);
			assert.equal(await readFile(join(fixture.machineRoot, "a.txt"), "utf8"), "old-a");
			assert.equal(await readFile(join(fixture.machineRoot, "b.txt"), "utf8"), "old-b");
		} finally {
			await fixture.temporary.cleanup();
		}
	});
});
