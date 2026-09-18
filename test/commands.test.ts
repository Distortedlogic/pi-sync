import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect } from "expect";
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
		finalResult: "settings.json in SHARED REPOSITORY will match THIS MACHINE.",
		path: "settings.json",
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
		effectivePaths: ["settings.json"],
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
		expect(parseConfigSyncCommand("")).toEqual({ command: "status", arguments: [] });
		for (const command of CONFIG_SYNC_SUBCOMMANDS) {
			expect(parseConfigSyncCommand(`${command} one two`)).toEqual({
				command,
				arguments: ["one", "two"],
			});
		}
		expect(() => parseConfigSyncCommand("unknown")).toThrow("Unknown /config-sync action");
	});

	it("uses only the fixed footer states", () => {
		expect(deriveFooterStatus(plan([]))).toBe("Config sync: clean");
		expect(deriveFooterStatus(plan([action()]))).toBe("Config sync: 1 to publish");
		expect(
			deriveFooterStatus(
				plan([
					action({
						action: "WRITE ON THIS MACHINE",
						destination: "THIS MACHINE",
						direction: "shared-to-machine",
					}),
				]),
			),
		).toBe("Config sync: 1 to apply");
		expect(
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
		).toBe("Config sync: 1 conflicts");
	});

	it("limits large plain-text difference output", () => {
		const output = formatDifferenceOutput(`${"changed line\n".repeat(6_000)}`);
		expect(Buffer.byteLength(output)).toBeLessThan(60 * 1024);
		expect(output).toContain("Difference truncated");
	});

	it("invalidates late status generations on replacement or shutdown", () => {
		const guard = new StatusGenerationGuard();
		const first = guard.begin();
		const second = guard.begin();
		expect(guard.isCurrent(first)).toBe(false);
		expect(guard.isCurrent(second)).toBe(true);
		guard.invalidate();
		expect(guard.isCurrent(second)).toBe(false);
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
				expect(reporter.signal.aborted).toBe(true);
				expect(reporter.state()).toMatchObject({ cancellationState: "stopping", phase: "STOPPING" });
				await work;
				settled = true;
				return "done";
			},
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(statuses.at(-1)).toContain("STOPPING");
		releaseWork?.();
		await expect(running).resolves.toBe("done");
		expect(settled).toBe(true);
		expect(statuses.at(-1)).toBeUndefined();
	});
});
