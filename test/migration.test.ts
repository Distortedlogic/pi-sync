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
const PUBLISHED_COMMIT = "b".repeat(40);
const PACKAGE_COMMIT = "c".repeat(40);
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
		if (command === "npm" && args.join(" ") === "view example@^1.0.0 version --json") {
			return { stdout: '"1.2.3"\n', stderr: "", code: 0, killed: false };
		}
		if (command === "git" && args[0] === "ls-remote") {
			return { stdout: `${PACKAGE_COMMIT}\trefs/heads/main\n`, stderr: "", code: 0, killed: false };
		}
		return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
	};
}

async function createLegacyFixture(root: string): Promise<LegacyFixture> {
	const homeDirectory = join(root, "home");
	const piDirectory = join(homeDirectory, ".pi");
	const agentDirectory = join(piDirectory, "agent");
	const legacyRepository = join(piDirectory, "config-repo");
	const settingsText = `${JSON.stringify({
		theme: "dark",
		packages: ["npm:example@^1.0.0", "git:https://example.invalid/tool.git@main"],
	})}\n`;
	const modelsText = '{"providers":[]}\n';
	await Promise.all([
		mkdir(agentDirectory, { recursive: true }),
		mkdir(join(legacyRepository, "sync"), { recursive: true }),
		mkdir(join(legacyRepository, ".pi-sync"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(piDirectory, "web-search.json"), '{"provider":"local"}\n'),
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
			assert.deepEqual(Object.keys(preview.baseline?.files ?? {}), ["agent/models.json", "agent/settings.json"]);
			assert.equal(
				Buffer.from(preview.finalSharedTree["web-search.json"]?.exactBytesBase64 ?? "", "base64").toString(),
				'{"provider":"local"}\n',
			);
			const settingsFile = preview.finalSharedTree["agent/settings.json"];
			const migratedSettings = JSON.parse(Buffer.from(settingsFile?.exactBytesBase64 ?? "", "base64").toString());
			assert.deepEqual(migratedSettings.packages, [
				"npm:example@1.2.3",
				`git:https://example.invalid/tool.git@${PACKAGE_COMMIT}`,
			]);

			const result = await importLegacyMigration({
				agentDirectory: fixture.agentDirectory,
				preview,
				authorization: authorizeMigration(preview, preview.migrationId),
				publishedCommit: PUBLISHED_COMMIT,
			});
			assert.deepEqual(result, { status: "success", requiredMode: "reconcile", deletionAllowed: true });
			assert.deepEqual((await loadConfig(fixture.agentDirectory))?.repository, {
				branch: "main",
				repositoryPath: REPOSITORY_PATH,
			});
			const baseline = (await loadState(fixture.agentDirectory))?.baseline;
			assert.equal(baseline?.commit, PUBLISHED_COMMIT);
			assert.deepEqual(Object.keys(baseline?.files ?? {}), ["agent/models.json", "agent/settings.json"]);
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
			await assert.rejects(
				importLegacyMigration({
					agentDirectory: fixture.agentDirectory,
					preview,
					authorization: authorizeMigration(preview, preview.migrationId),
					publishedCommit: PUBLISHED_COMMIT,
				}),
				/cannot import unvalidated repository configuration/,
			);
			assert.equal(await loadState(fixture.agentDirectory), undefined);
		} finally {
			await root.cleanup();
		}
	});
});
