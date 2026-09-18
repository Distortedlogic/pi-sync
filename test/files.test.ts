import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "expect";
import {
	assertNoPathCollisions,
	buildInventorySet,
	discoverFileInventory,
	portableExecutableBit,
	resolveInventoryRoots,
	resolveManagedPath,
} from "../src/files.ts";
import type { Baseline } from "../src/types.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

async function createRoots(parent: string): Promise<{ machine: string; shared: string }> {
	const machine = join(parent, "machine");
	const shared = join(parent, "shared");
	await Promise.all([mkdir(machine), mkdir(shared)]);
	return { machine, shared };
}

describe("managed path safety", () => {
	it("resolves both inventory roots and rejects unsafe paths", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			const roots = await createRoots(temporary.path);
			const resolved = resolveInventoryRoots(roots.machine, roots.shared);
			expect(Object.isFrozen(resolved)).toBe(true);
			expect(() => resolveManagedPath(resolved.machine, "../outside")).toThrow("cannot contain '..'");
			expect(() => resolveManagedPath(resolved.machine, "/outside")).toThrow("must be relative");
			expect(() => resolveManagedPath(resolved.machine, "C:\\outside")).toThrow("must be relative");
			expect(() => resolveManagedPath(resolved.machine, "bad\0name")).toThrow("NUL");
			expect(() => resolveManagedPath(resolved.machine, "CON.txt")).toThrow("Windows reserved");
		} finally {
			await temporary.cleanup();
		}
	});

	it("detects case and Unicode collisions before file reads", () => {
		expect(() => assertNoPathCollisions(["skills/Rule.md", "skills/rule.md"])).toThrow("path collision");
		expect(() => assertNoPathCollisions(["skills/é.md", "skills/é.md"])).toThrow("path collision");
	});

	it("rejects root and managed-file symlinks", async () => {
		if (process.platform === "win32") return;
		const temporary = await createTemporaryAgentDirectory();
		try {
			const roots = await createRoots(temporary.path);
			const linkedRoot = join(temporary.path, "linked-machine");
			await symlink(roots.machine, linkedRoot, "dir");
			await expect(discoverFileInventory(linkedRoot, "machine")).rejects.toThrow("path component is a symlink");

			await writeFile(join(roots.shared, "target.json"), "{}", "utf8");
			await symlink(join(roots.shared, "target.json"), join(roots.machine, "settings.json"));
			await expect(discoverFileInventory(roots.machine, "machine")).rejects.toThrow("Managed path is a symlink");
		} finally {
			await temporary.cleanup();
		}
	});
});

describe("file inventory", () => {
	it("hashes exact bytes and canonicalizes settings.json only for comparison", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			const roots = await createRoots(temporary.path);
			const machineBytes = Buffer.from('{"theme":"dark","packages":[]}\n');
			const sharedBytes = Buffer.from('{\n  "packages": [],\n  "theme": "dark"\n}\n');
			await Promise.all([
				writeFile(join(roots.machine, "settings.json"), machineBytes),
				writeFile(join(roots.shared, "settings.json"), sharedBytes),
			]);
			await chmod(join(roots.machine, "settings.json"), 0o755);

			const inventories = await buildInventorySet({
				machineRoot: roots.machine,
				sharedRoot: roots.shared,
				baseline: null,
			});
			const machine = inventories.machine.files["settings.json"];
			const shared = inventories.shared.files["settings.json"];
			expect(machine?.sha256).not.toBe(shared?.sha256);
			expect(machine?.comparisonSha256).toBe(shared?.comparisonSha256);
			expect(Buffer.from(machine?.exactBytesBase64 ?? "", "base64")).toEqual(machineBytes);
			expect(Buffer.from(shared?.exactBytesBase64 ?? "", "base64")).toEqual(sharedBytes);
			expect(machine?.executable).toBe(process.platform !== "win32");
			expect(Object.isFrozen(inventories)).toBe(true);
			expect(Object.isFrozen(inventories.machine.files)).toBe(true);
			expect(Object.isFrozen(machine)).toBe(true);
		} finally {
			await temporary.cleanup();
		}
	});

	it("returns immutable machine, shared, and baseline inventories", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const baseline: Baseline = {
			commit: "a".repeat(40),
			files: {
				"settings.json": {
					comparisonSha256: "b".repeat(64),
					executable: false,
					sha256: "c".repeat(64),
				},
			},
		};
		try {
			const roots = await createRoots(temporary.path);
			const inventories = await buildInventorySet({
				machineRoot: roots.machine,
				sharedRoot: roots.shared,
				baseline,
			});
			expect(inventories.baseline.files["settings.json"]?.comparisonSha256).toBe("b".repeat(64));
			expect(Object.isFrozen(inventories.machine)).toBe(true);
			expect(Object.isFrozen(inventories.shared)).toBe(true);
			expect(Object.isFrozen(inventories.baseline)).toBe(true);
		} finally {
			await temporary.cleanup();
		}
	});

	it("rejects nested repositories and unsupported special files", async () => {
		if (process.platform === "win32") return;
		const temporary = await createTemporaryAgentDirectory();
		let server: ReturnType<typeof createServer> | undefined;
		try {
			const roots = await createRoots(temporary.path);
			await mkdir(join(roots.machine, "extensions", "nested", ".git"), { recursive: true });
			await expect(
				discoverFileInventory(roots.machine, "machine", { managedPatterns: ["extensions/**"] }),
			).rejects.toThrow("Nested Git repository");

			await mkdir(join(roots.shared, "skills"));
			const socketPath = join(roots.shared, "skills", "service.sock");
			server = createServer();
			await new Promise<void>((accept, reject) => {
				server?.once("error", reject);
				server?.listen(socketPath, accept);
			});
			await expect(discoverFileInventory(roots.shared, "shared", { managedPatterns: ["skills/**"] })).rejects.toThrow(
				"not a regular file",
			);
			await new Promise<void>((accept, reject) => server?.close((error) => (error ? reject(error) : accept())));
			server = undefined;
		} finally {
			if (server) await new Promise<void>((accept) => server?.close(() => accept()));
			await temporary.cleanup();
		}
	});

	it("blocks unreadable managed files instead of omitting them", async () => {
		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const temporary = await createTemporaryAgentDirectory();
		let lockedPath: string | undefined;
		try {
			const roots = await createRoots(temporary.path);
			await mkdir(join(roots.machine, "skills"));
			lockedPath = join(roots.machine, "skills", "locked.md");
			await writeFile(lockedPath, "managed", "utf8");
			await chmod(lockedPath, 0);
			await expect(discoverFileInventory(roots.machine, "machine", { managedPatterns: ["skills/**"] })).rejects.toThrow(
				"skills/locked.md",
			);
		} finally {
			if (lockedPath) await chmod(lockedPath, 0o600);
			await temporary.cleanup();
		}
	});

	it("reports the path for size failures without changing the file", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			const roots = await createRoots(temporary.path);
			const path = join(roots.machine, "settings.json");
			await writeFile(path, '{"large":true}', "utf8");
			await expect(discoverFileInventory(roots.machine, "machine", { limits: { maxFileBytes: 4 } })).rejects.toThrow(
				"settings.json",
			);
			expect(await readFile(path, "utf8")).toBe('{"large":true}');
		} finally {
			await temporary.cleanup();
		}
	});

	it("applies the total plan limit across THIS MACHINE and SHARED REPOSITORY", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			const roots = await createRoots(temporary.path);
			await Promise.all([
				writeFile(join(roots.machine, "settings.json"), "{}", "utf8"),
				writeFile(join(roots.shared, "settings.json"), "{}", "utf8"),
			]);
			await expect(
				buildInventorySet({
					machineRoot: roots.machine,
					sharedRoot: roots.shared,
					baseline: null,
					limits: { maxFileBytes: 10, maxTotalBytes: 3 },
				}),
			).rejects.toThrow("SHARED REPOSITORY causes managed files");
		} finally {
			await temporary.cleanup();
		}
	});

	it("handles many managed files and long nested paths within configured limits", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			const roots = await createRoots(temporary.path);
			const skills = join(roots.machine, "skills");
			await mkdir(skills);
			await Promise.all(
				Array.from({ length: 200 }, (_, index) =>
					writeFile(join(skills, `rule-${index.toString().padStart(3, "0")}.md`), `rule ${index}\n`, "utf8"),
				),
			);
			const longDirectory = join(skills, ...Array.from({ length: 12 }, (_, index) => `segment-${index}`));
			await mkdir(longDirectory, { recursive: true });
			await writeFile(join(longDirectory, "long-rule.md"), "long path\n", "utf8");
			const inventory = await discoverFileInventory(roots.machine, "machine", {
				managedPatterns: ["skills/**"],
			});
			expect(Object.keys(inventory.files)).toHaveLength(201);
			expect(Object.keys(inventory.files).some((path) => path.endsWith("long-rule.md"))).toBe(true);
		} finally {
			await temporary.cleanup();
		}
	});

	it("checks cancellation and portable executable bits", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			const roots = await createRoots(temporary.path);
			const controller = new AbortController();
			controller.abort();
			await expect(
				discoverFileInventory(roots.machine, "machine", { signal: controller.signal }),
			).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(portableExecutableBit(0o755, "linux")).toBe(true);
			expect(portableExecutableBit(0o755, "darwin")).toBe(true);
			expect(portableExecutableBit(0o755, "win32")).toBe(false);
		} finally {
			await temporary.cleanup();
		}
	});
});
