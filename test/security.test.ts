import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultLocalPolicy } from "../src/config.ts";
import { discoverFileInventory } from "../src/files.ts";
import {
	SecretFindingError,
	type SecretScannerFactory,
	SecretScannerFailure,
	type StagedCandidateValidationInput,
	validateStagedCandidate,
} from "../src/security.ts";
import { createTemporaryAgentDirectory } from "./helpers.ts";

const CLEAN_SCANNER: SecretScannerFactory = async () => ({
	scan: async () => ({ ok: true, output: "[]" }),
});

async function validationInput(
	root: string,
	overrides: Partial<StagedCandidateValidationInput> = {},
): Promise<StagedCandidateValidationInput> {
	const managedPatterns = overrides.managedPatterns ?? ["**/*"];
	const inventory = await discoverFileInventory(root, "shared", { managedPatterns });
	return {
		stagedRoot: root,
		stagedPaths: Object.keys(inventory.files),
		plannedFinalSharedTree: inventory.files,
		candidateDiff: "",
		policy: createDefaultLocalPolicy(),
		managedPatterns,
		scannerFactory: CLEAN_SCANNER,
		...overrides,
	};
}

describe("staged final-tree validation", () => {
	it("validates the complete tree and exact candidate diff without changing either input", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const scanned = new Map<string, string>();
		try {
			const settingsPath = join(temporary.path, "settings.json");
			const notesPath = join(temporary.path, "notes.txt");
			const settings = '{"packages":["npm:example@1.0.0"],"theme":"dark"}\n';
			const notes = "reviewed text\n";
			const candidateDiff = "+exact candidate difference\n";
			await Promise.all([writeFile(settingsPath, settings, "utf8"), writeFile(notesPath, notes, "utf8")]);
			const input = await validationInput(temporary.path, {
				candidateDiff,
				machineSettings: {
					currentText: '{"machine":{"value":1},"packages":["file:../machine-only"]}',
					finalText: '{"machine":{"value":1},"packages":["file:../machine-only"]}',
				},
				scannerFactory: async () => ({
					scan: async (content, path) => {
						scanned.set(path, content);
						return { ok: true, output: "[]" };
					},
				}),
			});
			await expect(validateStagedCandidate(input)).resolves.toEqual({ findings: [] });
			expect(scanned.get("settings.json")).toBe(settings);
			expect(scanned.get("notes.txt")).toBe(notes);
			expect(scanned.get("candidate.diff")).toBe(candidateDiff);
			expect(await readFile(settingsPath, "utf8")).toBe(settings);
			expect(await readFile(notesPath, "utf8")).toBe(notes);
		} finally {
			await temporary.cleanup();
		}
	});

	it("rejects a permanently denied staged path before candidate creation", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const scannerFactory = vi.fn(CLEAN_SCANNER);
		try {
			await writeFile(join(temporary.path, ".env"), "DENIED=value\n", "utf8");
			const input = await validationInput(temporary.path, {
				stagedPaths: [".env"],
				plannedFinalSharedTree: {},
				scannerFactory,
			});
			await expect(validateStagedCandidate(input)).rejects.toThrow("Permanently denied path");
			expect(scannerFactory).not.toHaveBeenCalled();
		} finally {
			await temporary.cleanup();
		}
	});

	it("rejects a full-tree fingerprint mismatch", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			await writeFile(join(temporary.path, "settings.json"), "{}\n", "utf8");
			const input = await validationInput(temporary.path);
			const expected = {
				...input.plannedFinalSharedTree,
				"settings.json": {
					...input.plannedFinalSharedTree["settings.json"],
					sha256: "f".repeat(64),
				},
			};
			await expect(validateStagedCandidate({ ...input, plannedFinalSharedTree: expected })).rejects.toThrow(
				"does not match the immutable plan: settings.json",
			);
		} finally {
			await temporary.cleanup();
		}
	});

	it("rejects conflict markers and invalid JSON anywhere in the managed tree", async () => {
		const conflict = await createTemporaryAgentDirectory();
		const invalidJson = await createTemporaryAgentDirectory();
		try {
			await writeFile(join(conflict.path, "notes.txt"), "before\n<<<<<<< THIS MACHINE\nafter\n", "utf8");
			await expect(validateStagedCandidate(await validationInput(conflict.path))).rejects.toThrow("conflict marker");
			await writeFile(join(invalidJson.path, "theme.json"), "{invalid", "utf8");
			await expect(validateStagedCandidate(await validationInput(invalidJson.path))).rejects.toThrow(
				"Managed JSON is invalid: theme.json",
			);
		} finally {
			await Promise.all([conflict.cleanup(), invalidJson.cleanup()]);
		}
	});

	it("validates shared settings packages and machine-only policy preservation", async () => {
		const invalidPackage = await createTemporaryAgentDirectory();
		const lostPolicy = await createTemporaryAgentDirectory();
		try {
			await writeFile(join(invalidPackage.path, "settings.json"), '{"packages":["npm:example@latest"]}', "utf8");
			await expect(validateStagedCandidate(await validationInput(invalidPackage.path))).rejects.toThrow("not pinned");

			await writeFile(join(lostPolicy.path, "settings.json"), "{}", "utf8");
			const policy = { ...createDefaultLocalPolicy(), machineOnlySettings: ["/machine/value"] };
			const input = await validationInput(lostPolicy.path, {
				policy,
				machineSettings: {
					currentText: '{"machine":{"value":1}}',
					finalText: '{"machine":{"value":2}}',
				},
			});
			await expect(validateStagedCandidate(input)).rejects.toThrow("Machine-only setting was not preserved");
		} finally {
			await Promise.all([invalidPackage.cleanup(), lostPolicy.cleanup()]);
		}
	});
});

describe("Secretlint failure handling", () => {
	it.each([
		{
			name: "startup",
			factory: async () => {
				throw new Error("startup details");
			},
			phase: "startup",
		},
		{
			name: "configuration",
			factory: async () => {
				throw new SecretScannerFailure("configuration", "configuration failed");
			},
			phase: "configuration",
		},
		{
			name: "read",
			factory: async () => ({
				scan: async () => {
					throw new Error("read details");
				},
			}),
			phase: "read",
		},
		{
			name: "timeout",
			factory: async () => ({ scan: async () => new Promise<never>(() => {}) }),
			phase: "timeout",
		},
		{
			name: "parse",
			factory: async () => ({ scan: async () => ({ ok: true, output: "not JSON" }) }),
			phase: "parse",
		},
	])("blocks a $name failure", async ({ factory, phase }) => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			await writeFile(join(temporary.path, "notes.txt"), "safe\n", "utf8");
			const input = await validationInput(temporary.path, {
				scannerFactory: factory,
				scannerTimeoutMs: 10,
			});
			try {
				await validateStagedCandidate(input);
				expect.fail("Expected scanner failure");
			} catch (error) {
				expect(error).toBeInstanceOf(SecretScannerFailure);
				expect((error as SecretScannerFailure).phase).toBe(phase);
			}
		} finally {
			await temporary.cleanup();
		}
	});

	it("reports only finding type, relative path, and line number", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const matchedValue = "MATCHED-SECRET-TEXT";
		try {
			await writeFile(join(temporary.path, "notes.txt"), "safe\n", "utf8");
			const input = await validationInput(temporary.path, {
				scannerFactory: async () => ({
					scan: async () => ({
						ok: false,
						output: JSON.stringify([
							{
								messages: [{ ruleId: "@secretlint/example", line: 2, message: `matched ${matchedValue}` }],
							},
						]),
					}),
				}),
			});
			try {
				await validateStagedCandidate(input);
				expect.fail("Expected secret finding");
			} catch (error) {
				expect(error).toBeInstanceOf(SecretFindingError);
				const findingError = error as SecretFindingError;
				expect(findingError.findings[0]).toEqual({ type: "@secretlint/example", path: "notes.txt", line: 2 });
				expect(Object.keys(findingError.findings[0] ?? {}).sort()).toEqual(["line", "path", "type"]);
				expect(JSON.stringify(findingError)).not.toContain(matchedValue);
				expect(String(findingError)).not.toContain(matchedValue);
			}
		} finally {
			await temporary.cleanup();
		}
	});

	it("uses the maintained recommended rule set", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			await writeFile(
				join(temporary.path, "key.txt"),
				"-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
				"utf8",
			);
			const input = await validationInput(temporary.path, { scannerFactory: undefined });
			await expect(validateStagedCandidate(input)).rejects.toBeInstanceOf(SecretFindingError);
		} finally {
			await temporary.cleanup();
		}
	});
});
