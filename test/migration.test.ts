import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { expect } from "expect";
import {
	authorizeMigration,
	buildMigrationPreview,
	importLegacyMigration,
	type MigrationExec,
} from "../src/migration.ts";
import { loadConfig, loadState } from "../src/state.ts";
import { createTemporaryAgentDirectory, createTemporaryBareGitRepository } from "./helpers.ts";

const execFileAsync = promisify(execFile);

interface LegacyFixture {
	agentDirectory: string;
	homeDirectory: string;
	legacyStatePath: string;
}

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function gitExec(): MigrationExec {
	return async (command, args, options): Promise<ExecResult> => {
		try {
			const result = await execFileAsync(command, args, {
				cwd: options?.cwd,
				signal: options?.signal,
				timeout: options?.timeout,
				encoding: "utf8",
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

async function createLegacyFixture(root: string, sharedRepository: string): Promise<LegacyFixture> {
	const homeDirectory = join(root, "home");
	const piDirectory = join(homeDirectory, ".pi");
	const agentDirectory = join(piDirectory, "agent");
	const legacyRepository = join(piDirectory, "config-repo");
	await mkdir(agentDirectory, { recursive: true });
	await execFileAsync("git", ["clone", sharedRepository, legacyRepository]);
	await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: legacyRepository });
	await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: legacyRepository });
	const settingsText = '{"theme":"dark"}\n';
	const modelsText = '{"providers":[]}\n';
	await mkdir(join(legacyRepository, "sync"));
	await Promise.all([
		writeFile(join(legacyRepository, "sync", "settings.json"), settingsText),
		writeFile(join(legacyRepository, "sync", "models.json"), modelsText),
		writeFile(
			join(legacyRepository, "pi-sync.json"),
			`${JSON.stringify({
				schemaVersion: 2,
				branch: "main",
				root: "sync",
				include: ["settings.json", "models.json"],
				exclude: [],
				delete: "tracked",
				pullTimeoutMs: 10_000,
				security: { scanSecretsBeforePush: true },
			})}\n`,
		),
	]);
	await execFileAsync("git", ["add", "pi-sync.json", "sync"], { cwd: legacyRepository });
	await execFileAsync("git", ["commit", "-m", "Legacy configuration"], { cwd: legacyRepository });
	await execFileAsync("git", ["push", "origin", "HEAD:main"], { cwd: legacyRepository });
	const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: legacyRepository })).stdout.trim();
	const legacyStatePath = join(legacyRepository, ".pi-sync", "state.json");
	await mkdir(join(legacyRepository, ".pi-sync"));
	await writeFile(
		legacyStatePath,
		`${JSON.stringify({
			schemaVersion: 3,
			repoPath: legacyRepository,
			branch: "main",
			lastSyncedCommit: commit,
			lastSyncedAt: "2026-01-01T00:00:00.000Z",
			files: {
				"settings.json": { sha256: hash(settingsText), mode: 0o644 },
				"models.json": { sha256: hash(modelsText), mode: 0o644 },
			},
			pendingOperation: null,
			lastBackup: "legacy-backup",
			deviceId: "legacy-device",
		})}\n`,
	);
	const settingsPath = join(agentDirectory, "settings.json");
	await writeFile(settingsPath, `${JSON.stringify({ packages: ["npm:@jachy/pi-git-sync"] })}\n`);
	if (process.platform !== "win32") await symlink(join(legacyRepository, ".pi-sync"), join(agentDirectory, ".pi-sync"));
	return { agentDirectory, homeDirectory, legacyStatePath };
}

describe("legacy migration", () => {
	it("previews and imports validated legacy metadata", async () => {
		const root = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		try {
			const fixture = await createLegacyFixture(root.path, shared.path);
			const preview = await buildMigrationPreview({
				agentDirectory: fixture.agentDirectory,
				homeDirectory: fixture.homeDirectory,
				exec: gitExec(),
			});
			expect(preview).toMatchObject({
				branch: "main",
				deletionAllowed: true,
				repositoryPath: shared.path,
				status: "ready",
			});
			expect(Object.keys(preview.baseline?.files ?? {})).toEqual(["settings.json"]);

			const result = await importLegacyMigration({
				agentDirectory: fixture.agentDirectory,
				preview,
				authorization: authorizeMigration(preview, preview.migrationId),
			});
			expect(result).toEqual({ status: "success", requiredMode: "reconcile", deletionAllowed: true });
			expect((await loadConfig(fixture.agentDirectory))?.repository).toEqual({
				branch: "main",
				repositoryPath: shared.path,
			});
			expect((await loadState(fixture.agentDirectory))?.baseline).toEqual(preview.baseline);
		} finally {
			await Promise.all([root.cleanup(), shared.cleanup()]);
		}
	});

	it("uses a no-delete RECONCILE plan when the old baseline is ambiguous", async () => {
		const root = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		try {
			const fixture = await createLegacyFixture(root.path, shared.path);
			const state = JSON.parse(await readFile(fixture.legacyStatePath, "utf8"));
			state.files["settings.json"].sha256 = "f".repeat(64);
			await writeFile(fixture.legacyStatePath, `${JSON.stringify(state)}\n`);
			const preview = await buildMigrationPreview({
				agentDirectory: fixture.agentDirectory,
				homeDirectory: fixture.homeDirectory,
				exec: gitExec(),
			});
			expect(preview.status).toBe("no_delete_reconcile");
			expect(preview.requiredMode).toBe("reconcile");
			expect(preview.deletionAllowed).toBe(false);
			expect(preview.baseline).toBeNull();
			const result = await importLegacyMigration({
				agentDirectory: fixture.agentDirectory,
				preview,
				authorization: authorizeMigration(preview, preview.migrationId),
			});
			expect(result.deletionAllowed).toBe(false);
			expect((await loadState(fixture.agentDirectory))?.baseline).toBeNull();
		} finally {
			await Promise.all([root.cleanup(), shared.cleanup()]);
		}
	});
});
