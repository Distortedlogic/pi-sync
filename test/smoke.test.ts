import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_SYNC_SUBCOMMANDS } from "../src/commands.ts";
import { RECOVERY_CHOICES } from "../src/recovery.ts";
import { loadJournal, saveJournal } from "../src/state.ts";
import { createTemporaryAgentDirectory, createTemporaryBareGitRepository } from "./helpers.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("pi-sync foundation", () => {
	it("loads the extension and registers /config-sync", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();

		try {
			const result = await discoverAndLoadExtensions([join(packageRoot, "index.ts")], packageRoot, agentDirectory.path);

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			const command = result.extensions[0]?.commands.get("config-sync");
			expect(command).toBeDefined();
			const completions = await command?.getArgumentCompletions?.("");
			expect(completions?.map((item) => item.value)).toEqual(CONFIG_SYNC_SUBCOMMANDS);
		} finally {
			await agentDirectory.cleanup();
		}
	});

	it("detects an incomplete journal at session start and command start without running recovery", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		const notify = vi.fn();
		const select = vi.fn(async () => RECOVERY_CHOICES[2].label);
		const setStatus = vi.fn();
		const ctx = {
			hasUI: true,
			ui: { notify, select, setStatus } as unknown as ExtensionCommandContext["ui"],
		} as ExtensionCommandContext;
		try {
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory.path);
			await saveJournal(agentDirectory.path, {
				planId: "1".repeat(64),
				reviewedSharedCommit: "2".repeat(40),
				schemaVersion: 1,
				stage: "prepared",
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
			const result = await discoverAndLoadExtensions([join(packageRoot, "index.ts")], packageRoot, agentDirectory.path);
			const extension = result.extensions[0];
			const sessionStart = extension?.handlers.get("session_start")?.[0];
			await sessionStart?.({ type: "session_start", reason: "startup" }, ctx);
			await extension?.commands.get("config-sync")?.handler("", ctx);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("stopped after prepared"), "warning");
			expect(select).toHaveBeenCalledWith(
				expect.stringContaining("stopped after prepared"),
				RECOVERY_CHOICES.map((choice) => choice.label),
			);
			expect(notify).toHaveBeenCalledWith("STOP WITHOUT CHANGES selected. No recovery ran automatically.", "info");
			await expect(loadJournal(agentDirectory.path)).resolves.toMatchObject({ stage: "prepared" });
		} finally {
			vi.unstubAllEnvs();
			await agentDirectory.cleanup();
		}
	});

	it("creates temporary agent and bare Git directories", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		const sharedRepository = await createTemporaryBareGitRepository();

		try {
			expect((await stat(agentDirectory.path)).isDirectory()).toBe(true);
			expect((await stat(sharedRepository.path)).isDirectory()).toBe(true);
			expect((await stat(join(sharedRepository.path, "HEAD"))).isFile()).toBe(true);
		} finally {
			await Promise.all([agentDirectory.cleanup(), sharedRepository.cleanup()]);
		}
	});
});
