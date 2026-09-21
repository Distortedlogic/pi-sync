import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
	DEFAULT_MANAGED_SCOPE,
	ensureConfigSyncDirectories,
	isPermanentlyDenied,
	resolveEffectivePaths,
} from "../src/config.ts";
import { loadPlanArtifact, loadState, RecoveryRequiredError, savePlanArtifact, saveState } from "../src/state.ts";
import { CONFIG_SYNC_SCHEMA_VERSION, type PlanArtifact, type StateDocument } from "../src/types.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const FIRST_PLAN_ID = "1".repeat(64);
const BASELINE_COMMIT = "a".repeat(40);

function state(deviceId: string): StateDocument {
	return {
		baseline: {
			commit: BASELINE_COMMIT,
			files: {
				"agent/settings.json": { comparisonSha256: "b".repeat(64), executable: false, sha256: "b".repeat(64) },
			},
		},
		deviceId,
		lastBackupId: null,
		lastSuccessTime: null,
		pendingOperation: null,
		schemaVersion: CONFIG_SYNC_SCHEMA_VERSION,
	};
}

function plan(): PlanArtifact {
	return {
		actions: [],
		baselineCommit: BASELINE_COMMIT,
		createdAt: "2026-01-01T00:00:00.000Z",
		decisions: [],
		effectivePaths: ["agent/settings.json"],
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
}

describe("configuration storage", () => {
	it("rejects corrupt state instead of creating an empty baseline", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		try {
			const paths = await ensureConfigSyncDirectories(agentDirectory.path);
			await saveState(agentDirectory.path, state("machine-one"));
			await writeFile(paths.stateFile, "{not-json", "utf8");

			await assert.rejects(loadState(agentDirectory.path), RecoveryRequiredError);
			assert.equal(await readFile(paths.stateFile, "utf8"), "{not-json");
		} finally {
			await agentDirectory.cleanup();
		}
	});

	it("rejects unknown schema versions without a migration", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		try {
			const paths = await ensureConfigSyncDirectories(agentDirectory.path);
			await writeFile(paths.stateFile, JSON.stringify({ ...state("machine-one"), schemaVersion: 2 }), "utf8");

			await assert.rejects(loadState(agentDirectory.path), /No migration was attempted/);
		} finally {
			await agentDirectory.cleanup();
		}
	});

	it("round trips one state artifact", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		const expected = state("machine-one");
		try {
			await saveState(agentDirectory.path, expected);
			assert.deepEqual(await loadState(agentDirectory.path), expected);
		} finally {
			await agentDirectory.cleanup();
		}
	});

	it("round trips one plan artifact", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		const expected = plan();
		try {
			await savePlanArtifact(agentDirectory.path, expected);
			assert.deepEqual(await loadPlanArtifact(agentDirectory.path, FIRST_PLAN_ID), expected);
		} finally {
			await agentDirectory.cleanup();
		}
	});
});

describe("managed scope", () => {
	it("includes persistent Pi-root files and extension-installed resources", () => {
		const candidates = [
			"acp.json",
			"agent/AGENTS.md",
			"agent/agents/reviewer.md",
			"agent/context-preload/default.json",
			"agent/extensions/example/index.ts",
			"agent/keybindings.json",
			"agent/models.json",
			"agent/prompts/review.md",
			"agent/settings.json",
			"agent/skills/example/SKILL.md",
			"agent/themes/example.json",
			"mermaid/package.json",
			"mermaid/puppeteer.json",
			"mermaid/vscode-dark-high-contrast.json",
			"web-search.json",
		];
		assert.deepEqual(resolveEffectivePaths(candidates, ["**/*"], DEFAULT_MANAGED_SCOPE), [...candidates].sort());
	});

	it("includes agent models and settings in the default managed scope", () => {
		const paths = resolveEffectivePaths(["agent/models.json", "agent/settings.json"], ["**/*"], DEFAULT_MANAGED_SCOPE);
		assert.deepEqual(paths, ["agent/models.json", "agent/settings.json"]);
	});

	it("always applies permanent deny rules", () => {
		const denied = [
			"agent/.config-sync/state.json",
			"agent/.env",
			"agent/auth.json",
			"agent/git/example/HEAD",
			"agent/npm/package/index.js",
			"mermaid/node_modules/@mermaid-js/mermaid-cli/package.json",
			"agent/extensions/example/bin/tool",
			"agent/extensions/example/node_modules/dependency/index.js",
			"agent/sessions/a.jsonl",
			"agent/cache/catalog.json",
			"agent/tmp/work.tmp",
			"agent/agents/store.json",
			"agent/agents/usage.json",
			"agent/trusted-projects.json",
			"agent/oauth/token.json",
			"agent/extensions/example/.installed",
		];
		for (const path of denied) assert.equal(isPermanentlyDenied(path), true);
		assert.deepEqual(resolveEffectivePaths(["agent/settings.json", ...denied], ["**/*"], ["**/*"]), [
			"agent/settings.json",
		]);
	});
});
