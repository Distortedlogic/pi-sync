import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	authorizeMigration,
	buildMigrationPreview,
	importLegacyMigration,
	type MigrationExec,
} from "../src/migration.ts";
import { loadConfig, loadState } from "../src/state.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const LEGACY_COMMIT = "a".repeat(40);
const REPOSITORY_PATH = "https://example.invalid/pi-config.git";

interface LegacyFixture {
	agentDirectory: string;
	homeDirectory: string;
	legacyStatePath: string;
}

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function gitExec(): MigrationExec {
	return async (command, args) => {
		if (command === "git" && args.join(" ") === "remote get-url origin") {
			return { stdout: `${REPOSITORY_PATH}\n`, stderr: "", code: 0, killed: false };
		}
		if (command === "git" && args.join(" ") === `cat-file -e ${LEGACY_COMMIT}^{commit}`) {
			return { stdout: "", stderr: "", code: 0, killed: false };
		}
		return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
	};
}

async function createLegacyFixture(root: string): Promise<LegacyFixture> {
	const homeDirectory = join(root, "home");
	const piDirectory = join(homeDirectory, ".pi");
	const agentDirectory = join(piDirectory, "agent");
	const legacyRepository = join(piDirectory, "config-repo");
	const settingsText = '{"theme":"dark"}\n';
	const modelsText = '{"providers":[]}\n';
	await Promise.all([
		mkdir(agentDirectory, { recursive: true }),
		mkdir(join(legacyRepository, "sync"), { recursive: true }),
		mkdir(join(legacyRepository, ".pi-sync"), { recursive: true }),
	]);
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
	const legacyStatePath = join(legacyRepository, ".pi-sync", "state.json");
	await writeFile(
		legacyStatePath,
		`${JSON.stringify({
			schemaVersion: 3,
			repoPath: legacyRepository,
			branch: "main",
			lastSyncedCommit: LEGACY_COMMIT,
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
	return { agentDirectory, homeDirectory, legacyStatePath };
}

describe("legacy migration", () => {
	it("previews and imports validated legacy metadata", async () => {
		const root = await createTemporaryAgentDirectory();
		try {
			const fixture = await createLegacyFixture(root.path);
			const preview = await buildMigrationPreview({
				agentDirectory: fixture.agentDirectory,
				homeDirectory: fixture.homeDirectory,
				exec: gitExec(),
			});
			assert.equal(preview.branch, "main");
			assert.equal(preview.deletionAllowed, true);
			assert.equal(preview.repositoryPath, REPOSITORY_PATH);
			assert.equal(preview.status, "ready");
			assert.deepEqual(Object.keys(preview.baseline?.files ?? {}), ["settings.json"]);

			const result = await importLegacyMigration({
				agentDirectory: fixture.agentDirectory,
				preview,
				authorization: authorizeMigration(preview, preview.migrationId),
			});
			assert.deepEqual(result, { status: "success", requiredMode: "reconcile", deletionAllowed: true });
			assert.deepEqual((await loadConfig(fixture.agentDirectory))?.repository, {
				branch: "main",
				repositoryPath: REPOSITORY_PATH,
			});
			assert.deepEqual((await loadState(fixture.agentDirectory))?.baseline, preview.baseline);
		} finally {
			await root.cleanup();
		}
	});

	it("uses a no-delete RECONCILE plan when the old baseline is ambiguous", async () => {
		const root = await createTemporaryAgentDirectory();
		try {
			const fixture = await createLegacyFixture(root.path);
			const state = JSON.parse(await readFile(fixture.legacyStatePath, "utf8"));
			state.files["settings.json"].sha256 = "f".repeat(64);
			await writeFile(fixture.legacyStatePath, `${JSON.stringify(state)}\n`);
			const preview = await buildMigrationPreview({
				agentDirectory: fixture.agentDirectory,
				homeDirectory: fixture.homeDirectory,
				exec: gitExec(),
			});
			assert.equal(preview.status, "no_delete_reconcile");
			assert.equal(preview.requiredMode, "reconcile");
			assert.equal(preview.deletionAllowed, false);
			assert.equal(preview.baseline, null);
			const result = await importLegacyMigration({
				agentDirectory: fixture.agentDirectory,
				preview,
				authorization: authorizeMigration(preview, preview.migrationId),
			});
			assert.equal(result.deletionAllowed, false);
			assert.equal((await loadState(fixture.agentDirectory))?.baseline, null);
		} finally {
			await root.cleanup();
		}
	});
});
