import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { CONFIG_SYNC_SUBCOMMANDS } from "../src/commands.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(packageRoot, "src/index.ts");

describe("pi-sync foundation", () => {
	it("loads the extension and registers /config-sync", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();

		try {
			const result = await discoverAndLoadExtensions([extensionPath], packageRoot, agentDirectory.path);

			assert.deepEqual(result.errors, []);
			assert.equal(result.extensions.length, 1);
			const command = result.extensions[0]?.commands.get("config-sync");
			assert.ok(command);
			const completions = await command.getArgumentCompletions?.("");
			assert.deepEqual(
				completions?.map((item) => item.value),
				CONFIG_SYNC_SUBCOMMANDS,
			);
		} finally {
			await agentDirectory.cleanup();
		}
	});
});
