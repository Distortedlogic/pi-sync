import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createTemporaryAgentDirectory, createTemporaryBareGitRepository } from "./helpers.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("pi-config-sync foundation", () => {
	it("loads the extension and registers /config-sync", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();

		try {
			const result = await discoverAndLoadExtensions([join(packageRoot, "index.ts")], packageRoot, agentDirectory.path);

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0]?.commands.has("config-sync")).toBe(true);
		} finally {
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
