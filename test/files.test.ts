import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertNoPathCollisions, buildInventorySet, discoverFileInventory, resolveManagedPath } from "../src/files.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

async function createRoots(parent: string): Promise<{ machine: string; shared: string }> {
	const machine = join(parent, "machine");
	const shared = join(parent, "shared");
	await Promise.all([mkdir(machine), mkdir(shared)]);
	return { machine, shared };
}

describe("managed path safety", () => {
	it("rejects traversal, collisions, symlinks, and nested repositories", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			assert.throws(() => resolveManagedPath(temporary.path, "../outside"), /cannot contain '\.\.'/);
			for (const paths of [
				["skills/Rule.md", "skills/rule.md"],
				["skills/é.md", "skills/é.md"],
			]) {
				assert.throws(() => assertNoPathCollisions(paths), /path collision/);
			}

			const roots = await createRoots(temporary.path);
			await mkdir(join(roots.machine, "extensions", "nested", ".git"), { recursive: true });
			await assert.rejects(
				discoverFileInventory(roots.machine, "machine", { managedPatterns: ["extensions/**"] }),
				/Nested Git repository/,
			);

			if (process.platform !== "win32") {
				const linkedRoot = join(temporary.path, "linked-machine");
				await symlink(roots.machine, linkedRoot, "dir");
				await assert.rejects(discoverFileInventory(linkedRoot, "machine"), /path component is a symlink/);

				const symlinkMachine = join(temporary.path, "symlink-machine");
				await mkdir(symlinkMachine);
				await writeFile(join(roots.shared, "target.json"), "{}", "utf8");
				await symlink(join(roots.shared, "target.json"), join(symlinkMachine, "settings.json"));
				await assert.rejects(discoverFileInventory(symlinkMachine, "machine"), /Managed path is a symlink/);
			}
		} finally {
			await temporary.cleanup();
		}
	});
});

describe("file inventory", () => {
	it("preserves exact bytes, compares canonical settings, and enforces size limits", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			const roots = await createRoots(temporary.path);
			const machineBytes = Buffer.from('{"theme":"dark","packages":[]}\n');
			const sharedBytes = Buffer.from('{\n  "packages": [],\n  "theme": "dark"\n}\n');
			await Promise.all([
				writeFile(join(roots.machine, "settings.json"), machineBytes),
				writeFile(join(roots.shared, "settings.json"), sharedBytes),
			]);

			const inventories = await buildInventorySet({
				machineRoot: roots.machine,
				sharedRoot: roots.shared,
				baseline: null,
			});
			const machine = inventories.machine.files["settings.json"];
			const shared = inventories.shared.files["settings.json"];
			assert.notEqual(machine?.sha256, shared?.sha256);
			assert.equal(machine?.comparisonSha256, shared?.comparisonSha256);
			assert.deepEqual(Buffer.from(machine?.exactBytesBase64 ?? "", "base64"), machineBytes);
			assert.deepEqual(Buffer.from(shared?.exactBytesBase64 ?? "", "base64"), sharedBytes);

			const combinedLimit = Math.max(machineBytes.length, sharedBytes.length);
			const limitCases: Array<{ run: () => Promise<unknown>; pattern: RegExp }> = [
				{
					run: () =>
						discoverFileInventory(roots.machine, "machine", {
							limits: { maxFileBytes: 4 },
						}),
					pattern: /settings\.json/,
				},
				{
					run: () =>
						buildInventorySet({
							machineRoot: roots.machine,
							sharedRoot: roots.shared,
							baseline: null,
							limits: { maxFileBytes: 1024, maxTotalBytes: combinedLimit },
						}),
					pattern: /SHARED REPOSITORY causes managed files/,
				},
			];
			for (const { run, pattern } of limitCases) await assert.rejects(run(), pattern);
		} finally {
			await temporary.cleanup();
		}
	});
});
