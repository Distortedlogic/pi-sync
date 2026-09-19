import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_SYNC_SUBCOMMANDS } from "../src/commands.ts";
import { loadJournal } from "../src/state.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(packageRoot, "src/index.ts");

describe("pi-sync foundation", () => {
	it("loads the extension and handles missing configuration without a journal", async () => {
		const agentDirectory = await createTemporaryAgentDirectory();
		const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;

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

			const notifications: string[] = [];
			process.env.PI_CODING_AGENT_DIR = agentDirectory.path;
			result.runtime.appendEntry = () => {};
			await command.handler("doctor", {
				cwd: packageRoot,
				hasUI: false,
				ui: { notify: (message: string) => notifications.push(message) },
			} as unknown as ExtensionCommandContext);
			assert.equal(
				notifications.some((message) => message.includes("Configuration is missing")),
				true,
			);
			assert.equal(await loadJournal(agentDirectory.path), undefined);
		} finally {
			if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
			await agentDirectory.cleanup();
		}
	});
});
