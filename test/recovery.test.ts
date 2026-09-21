import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it, mock } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	authorizeRestorePlan,
	buildRestorePlan,
	executeRestorePlan,
	type IncompleteJournal,
	RECOVERY_CHOICES,
	RestorePlanExpiredError,
	requestRecoveryDecision,
	reviewRestorePlan,
} from "../src/recovery.ts";
import { getBackupMetadataPath, saveBackupMetadata } from "../src/state.ts";
import type { BackupMetadata } from "../src/types.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const PLAN_ID = "1".repeat(64);
const OLD_SETTINGS = '{"value":"old"}\n';
const NEW_SETTINGS = '{"value":"new"}\n';
const CHANGED_SETTINGS = '{"value":"changed-after-review"}\n';

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

async function createBackupFixture(agentDirectory: string, machineRoot: string): Promise<BackupMetadata> {
	const metadata: BackupMetadata = {
		backupId: "backup-restore",
		createdAt: "2026-01-01T00:00:00.000Z",
		entries: [
			{ executable: false, existed: true, path: "agent/settings.json", sha256: hash(OLD_SETTINGS) },
			{ executable: null, existed: false, path: "web-search.json", sha256: null },
		],
		planId: PLAN_ID,
		schemaVersion: 1,
	};
	const metadataPath = getBackupMetadataPath(agentDirectory, metadata.backupId);
	await Promise.all([
		mkdir(join(dirname(metadataPath), "files", "agent"), { recursive: true }),
		mkdir(join(machineRoot, "agent"), { recursive: true }),
	]);
	await writeFile(join(dirname(metadataPath), "files", "agent", "settings.json"), OLD_SETTINGS, { mode: 0o644 });
	await saveBackupMetadata(agentDirectory, metadata);
	await Promise.all([
		writeFile(join(machineRoot, "agent", "settings.json"), NEW_SETTINGS),
		writeFile(join(machineRoot, "web-search.json"), "created"),
	]);
	return metadata;
}

describe("recovery decisions", () => {
	it("requires an explicit user choice", async () => {
		const recovery: IncompleteJournal = {
			backupId: "backup-restore",
			message: `RECOVERY REQUIRED: Plan ${PLAN_ID} stopped after backup_verified.`,
			nextStep: "apply_packages",
			planId: PLAN_ID,
			publishedCommit: "2".repeat(40),
			stage: "backup_verified",
		};
		assert.deepEqual(
			await requestRecoveryDecision({
				ctx: { hasUI: false, ui: {} as ExtensionCommandContext["ui"] },
				recovery,
			}),
			{ status: "decision_required", recovery },
		);

		const select = mock.fn(async (_title: string, _options: string[]) => RECOVERY_CHOICES[1].label);
		assert.deepEqual(
			await requestRecoveryDecision({
				ctx: { hasUI: true, ui: { select } as unknown as ExtensionCommandContext["ui"] },
				recovery,
			}),
			{ status: "selected", recovery, choice: "rollback_machine" },
		);
		assert.deepEqual(select.mock.calls[0]?.arguments, [
			recovery.message,
			RECOVERY_CHOICES.map((choice) => choice.label),
		]);
	});
});

describe("backup restore", () => {
	it("requires the exact restore ID and applies verified restore actions", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const machineRoot = join(temporary.path, "machine");
		try {
			const metadata = await createBackupFixture(agentDirectory, machineRoot);
			const plan = await buildRestorePlan({
				agentDirectory,
				machineRoot,
				backupId: metadata.backupId,
				createdAt: "2026-01-02T00:00:00.000Z",
			});
			assert.deepEqual(
				plan.actions.map((action) => `${action.action}:${action.path}`),
				["WRITE ON THIS MACHINE:agent/settings.json", "DELETE FROM THIS MACHINE:web-search.json"],
			);
			assert.throws(() => authorizeRestorePlan(plan, plan.shortPlanId), /Exact restore plan ID/);
			const select = mock.fn(async () => "Enter exact restore plan ID");
			const input = mock.fn(async () => plan.planId);
			const review = await reviewRestorePlan({
				ctx: { hasUI: true, ui: { input, select } as unknown as ExtensionCommandContext["ui"] },
				plan,
			});
			assert.equal(review.status, "confirmed");
			if (review.status !== "confirmed") return;
			await executeRestorePlan({
				agentDirectory,
				machineRoot,
				plan,
				authorization: review.authorization,
			});
			assert.equal(await readFile(join(machineRoot, "agent", "settings.json"), "utf8"), OLD_SETTINGS);
			await assert.rejects(
				readFile(join(machineRoot, "web-search.json"), "utf8"),
				(error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
			);
		} finally {
			await temporary.cleanup();
		}
	});

	it("blocks a stale restore plan before any write", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const agentDirectory = join(temporary.path, "agent");
		const machineRoot = join(temporary.path, "machine");
		try {
			const metadata = await createBackupFixture(agentDirectory, machineRoot);
			const plan = await buildRestorePlan({
				agentDirectory,
				machineRoot,
				backupId: metadata.backupId,
				createdAt: "2026-01-02T00:00:00.000Z",
			});
			await writeFile(join(machineRoot, "agent", "settings.json"), CHANGED_SETTINGS);
			await assert.rejects(
				executeRestorePlan({
					agentDirectory,
					machineRoot,
					plan,
					authorization: authorizeRestorePlan(plan, plan.planId),
				}),
				RestorePlanExpiredError,
			);
			assert.equal(await readFile(join(machineRoot, "agent", "settings.json"), "utf8"), CHANGED_SETTINGS);
			assert.equal(await readFile(join(machineRoot, "web-search.json"), "utf8"), "created");
		} finally {
			await temporary.cleanup();
		}
	});
});
