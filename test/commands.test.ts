import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_SYNC_SUBCOMMANDS,
	deriveFooterStatus,
	formatDifferenceOutput,
	parseConfigSyncCommand,
	StatusGenerationGuard,
} from "../src/commands.ts";
import { buildPlanArtifact, type PlanArtifactAction } from "../src/plan.ts";
import { runWithProgress } from "../src/progress.ts";

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

	it("limits large plain-text difference output", () => {
		const output = formatDifferenceOutput(`${"changed line\n".repeat(6_000)}`);
		assert.ok(Buffer.byteLength(output) < 60 * 1024);
		assert.ok(output.includes("Difference truncated"));
	});

	it("invalidates late status generations on replacement or shutdown", () => {
		const guard = new StatusGenerationGuard();
		const first = guard.begin();
		const second = guard.begin();
		assert.equal(guard.isCurrent(first), false);
		assert.equal(guard.isCurrent(second), true);
		guard.invalidate();
		assert.equal(guard.isCurrent(second), false);
	});
});

describe("configuration operation progress", () => {
	it("shows STOPPING and waits for active work to settle before returning", async () => {
		const statuses: Array<string | undefined> = [];
		let releaseWork: (() => void) | undefined;
		let settled = false;
		const work = new Promise<void>((resolve) => {
			releaseWork = resolve;
		});
		const ctx = {
			hasUI: true,
			mode: "rpc",
			ui: {
				setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			} as unknown as ExtensionCommandContext["ui"],
		} as Pick<ExtensionCommandContext, "hasUI" | "mode" | "ui">;
		const running = runWithProgress({
			ctx,
			now: (() => {
				let time = 0;
				return () => {
					time += 10;
					return time;
				};
			})(),
			operation: async (reporter) => {
				reporter.update("APPLYING FILES", "Applying one confirmed file on THIS MACHINE");
				reporter.stopping();
				assert.equal(reporter.signal.aborted, true);
				assert.equal(reporter.state().cancellationState, "stopping");
				assert.equal(reporter.state().phase, "STOPPING");
				await work;
				settled = true;
				return "done";
			},
		});
		await Promise.resolve();
		assert.equal(settled, false);
		assert.ok(statuses.at(-1)?.includes("STOPPING"));
		releaseWork?.();
		assert.equal(await running, "done");
		assert.equal(settled, true);
		assert.equal(statuses.at(-1), undefined);
	});
});
