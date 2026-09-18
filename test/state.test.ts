import { lstat, readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { expect } from "expect";
import {
	activateScopeApprovalForPlan,
	approveScopeExpansion,
	createDefaultLocalPolicy,
	DEFAULT_MANAGED_SCOPE,
	ensureConfigSyncDirectories,
	isPermanentlyDenied,
	resolveEffectivePaths,
	resolveScopePlan,
} from "../src/config.ts";
import {
	loadBackupMetadata,
	loadConfig,
	loadJournal,
	loadPlanArtifact,
	loadState,
	RecoveryRequiredError,
	saveBackupMetadata,
	saveConfig,
	saveJournal,
	savePlanArtifact,
	saveState,
} from "../src/state.ts";
import {
	type BackupMetadata,
	CONFIG_SYNC_SCHEMA_VERSION,
	type ConfigDocument,
	type LocalPolicy,
	type OperationJournal,
	type PlanArtifact,
	type StateDocument,
} from "../src/types.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const FIRST_PLAN_ID = "1".repeat(64);
const NEXT_PLAN_ID = "2".repeat(64);
const BASELINE_COMMIT = "a".repeat(40);

function state(deviceId: string): StateDocument {
	return {
		baseline: {
			commit: BASELINE_COMMIT,
			files: {
				"settings.json": { comparisonSha256: "b".repeat(64), executable: false, sha256: "b".repeat(64) },
			},
		},
		deviceId,
		lastBackupId: null,
		lastSuccessTime: null,
		pendingOperation: null,
		schemaVersion: CONFIG_SYNC_SCHEMA_VERSION,
	};
}

describe("configuration storage", () => {
	it("creates the required data layout without symlinks", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		try {
			const paths = await ensureConfigSyncDirectories(agentDirectory.path);
			for (const path of [paths.root, paths.plansDirectory, paths.candidatesDirectory, paths.backupsDirectory]) {
				const details = await lstat(path);
				expect(details.isDirectory()).toBe(true);
				expect(details.isSymbolicLink()).toBe(false);
			}
		} finally {
			await agentDirectory.cleanup();
		}
	});

	it("rejects corrupt state instead of creating an empty baseline", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		try {
			const paths = await ensureConfigSyncDirectories(agentDirectory.path);
			await saveState(agentDirectory.path, state("machine-one"));
			await writeFile(paths.stateFile, "{not-json", "utf8");

			await expect(loadState(agentDirectory.path)).rejects.toBeInstanceOf(RecoveryRequiredError);
			expect(await readFile(paths.stateFile, "utf8")).toBe("{not-json");
		} finally {
			await agentDirectory.cleanup();
		}
	});

	it("rejects unknown schema versions without a migration", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		try {
			const paths = await ensureConfigSyncDirectories(agentDirectory.path);
			await writeFile(paths.stateFile, JSON.stringify({ ...state("machine-one"), schemaVersion: 2 }), "utf8");

			await expect(loadState(agentDirectory.path)).rejects.toThrow("No migration was attempted");
		} finally {
			await agentDirectory.cleanup();
		}
	});

	it("keeps one complete state document when atomic writes overlap", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		try {
			await Promise.all([
				saveState(agentDirectory.path, state("machine-one")),
				saveState(agentDirectory.path, state("machine-two")),
			]);
			const saved = await loadState(agentDirectory.path);
			expect(["machine-one", "machine-two"]).toContain(saved?.deviceId);
			expect(saved?.baseline?.files["settings.json"]?.sha256).toBe("b".repeat(64));
		} finally {
			await agentDirectory.cleanup();
		}
	});

	it("writes and reads every durable artifact type", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		const policy = createDefaultLocalPolicy();
		const configuration: ConfigDocument = {
			policy,
			repository: { branch: "main", repositoryPath: "/srv/pi-config.git" },
			schemaVersion: CONFIG_SYNC_SCHEMA_VERSION,
		};
		const plan: PlanArtifact = {
			actions: [],
			baselineCommit: BASELINE_COMMIT,
			createdAt: "2026-01-01T00:00:00.000Z",
			decisions: [],
			effectivePaths: ["settings.json"],
			finalMachineTree: {},
			finalSharedTree: {},
			machineFingerprint: "c".repeat(64),
			mode: "reconcile",
			noOpEffects: [],
			packageFingerprint: "d".repeat(64),
			planId: FIRST_PLAN_ID,
			policyFingerprint: "e".repeat(64),
			prohibitedEffects: [],
			remoteCheckedAt: "2026-01-01T00:00:01.000Z",
			schemaVersion: CONFIG_SYNC_SCHEMA_VERSION,
			sharedCommit: BASELINE_COMMIT,
			sharedFingerprint: "f".repeat(64),
			shortPlanId: FIRST_PLAN_ID.slice(0, 12),
			scopeExpansion: null,
		};
		const journal: OperationJournal = {
			planId: FIRST_PLAN_ID,
			reviewedSharedCommit: BASELINE_COMMIT,
			schemaVersion: CONFIG_SYNC_SCHEMA_VERSION,
			stage: "prepared",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const backup: BackupMetadata = {
			backupId: "backup-one",
			createdAt: "2026-01-01T00:00:00.000Z",
			entries: [{ executable: false, existed: true, path: "settings.json", sha256: "b".repeat(64) }],
			planId: FIRST_PLAN_ID,
			schemaVersion: CONFIG_SYNC_SCHEMA_VERSION,
		};

		try {
			await saveConfig(agentDirectory.path, configuration);
			await savePlanArtifact(agentDirectory.path, plan);
			await saveJournal(agentDirectory.path, journal);
			await saveBackupMetadata(agentDirectory.path, backup);

			expect(await loadConfig(agentDirectory.path)).toEqual(configuration);
			expect(await loadPlanArtifact(agentDirectory.path, FIRST_PLAN_ID)).toEqual(plan);
			expect(await loadJournal(agentDirectory.path)).toEqual(journal);
			expect(await loadBackupMetadata(agentDirectory.path, "backup-one")).toEqual(backup);
		} finally {
			await agentDirectory.cleanup();
		}
	});
});

describe("managed scope", () => {
	it("excludes models.json from the default managed scope", () => {
		const paths = resolveEffectivePaths(["models.json", "settings.json"], ["**/*"], DEFAULT_MANAGED_SCOPE);
		expect(paths).toEqual(["settings.json"]);
	});

	it("always applies permanent deny rules", () => {
		const denied = [
			".config-sync/state.json",
			".env",
			"auth.json",
			"git/example/HEAD",
			"npm/package/index.js",
			"sessions/a.jsonl",
		];
		for (const path of denied) expect(isPermanentlyDenied(path)).toBe(true);
		expect(resolveEffectivePaths(["settings.json", ...denied], ["**/*"], ["**/*"])).toEqual(["settings.json"]);
	});

	it("makes a shared scope expansion a policy-only plan", () => {
		const policy: LocalPolicy = {
			...createDefaultLocalPolicy(),
			acceptedSharedScope: ["settings.json"],
		};
		const requestedScope = ["settings.json", "skills/**"];
		const currentPlan = resolveScopePlan(["settings.json", "skills/example/SKILL.md"], requestedScope, policy);
		expect(currentPlan).toEqual({ effectivePaths: [], expansion: ["skills/**"], policyChangeOnly: true });

		const approved = approveScopeExpansion(policy, requestedScope, FIRST_PLAN_ID);
		expect(() => activateScopeApprovalForPlan(approved, FIRST_PLAN_ID)).toThrow("only to the next plan");
		const activePolicy = activateScopeApprovalForPlan(approved, NEXT_PLAN_ID);
		const nextPlan = resolveScopePlan(["settings.json", "skills/example/SKILL.md"], requestedScope, activePolicy);
		expect(nextPlan).toEqual({
			effectivePaths: ["settings.json", "skills/example/SKILL.md"],
			expansion: [],
			policyChangeOnly: false,
		});
	});
});
