import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG_SYNC_SUBCOMMANDS, deriveFooterStatus, parseConfigSyncCommand } from "../src/commands.ts";
import { buildPlanArtifact, type PlanArtifactAction } from "../src/plan.ts";

const HASH = "a".repeat(64);

function action(overrides: Partial<PlanArtifactAction> = {}): PlanArtifactAction {
	return {
		action: "WRITE IN SHARED REPOSITORY",
		codeExecution: false,
		destination: "SHARED REPOSITORY",
		direction: "machine-to-shared",
		finalResult: "agent/settings.json in SHARED REPOSITORY will match THIS MACHINE.",
		path: "agent/settings.json",
		reason: "THIS MACHINE changed the tracked file.",
		resultSha256: HASH,
		risk: "write",
		sourceSha256: HASH,
		...overrides,
	};
}

function plan(actions: PlanArtifactAction[]) {
	return buildPlanArtifact({
		actions,
		baselineCommit: "1".repeat(40),
		createdAt: "2026-01-01T00:00:00.000Z",
		decisions: [],
		effectivePaths: ["agent/settings.json"],
		finalMachineTree: {},
		finalSharedTree: {},
		machineFingerprint: HASH,
		mode: "reconcile",
		noOpEffects: [],
		packageFingerprint: HASH,
		policyFingerprint: HASH,
		prohibitedEffects: [],
		remoteCheckedAt: "2026-01-01T00:00:01.000Z",
		sharedCommit: "2".repeat(40),
		sharedFingerprint: HASH,
		scopeExpansion: null,
	});
}

describe("configuration command routing", () => {
	it("supports every required /config-sync form through one native command", () => {
		assert.deepEqual(parseConfigSyncCommand(""), { command: "status", arguments: [] });
		for (const command of CONFIG_SYNC_SUBCOMMANDS) {
			assert.deepEqual(parseConfigSyncCommand(`${command} one two`), {
				command,
				arguments: ["one", "two"],
			});
		}
		assert.throws(() => parseConfigSyncCommand("unknown"), /Unknown \/config-sync action/);
	});

	it("uses only the fixed footer states", () => {
		assert.equal(deriveFooterStatus(plan([])), "Config sync: clean");
		assert.equal(deriveFooterStatus(plan([action()])), "Config sync: 1 to publish");
		assert.equal(
			deriveFooterStatus(
				plan([
					action({
						action: "WRITE ON THIS MACHINE",
						destination: "THIS MACHINE",
						direction: "shared-to-machine",
					}),
				]),
			),
			"Config sync: 1 to apply",
		);
		assert.equal(
			deriveFooterStatus(
				plan([
					action({
						action: "CONFLICT — NO ACTION SELECTED",
						destination: "NONE",
						direction: "none",
						resultSha256: null,
						risk: "conflict",
					}),
				]),
			),
			"Config sync: 1 conflicts",
		);
	});
});
