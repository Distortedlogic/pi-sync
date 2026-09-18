import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "expect";
import * as vi from "jest-mock";
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

describe("secret scanner failure handling", () => {
	const failures: Array<{
		name: string;
		factory: SecretScannerFactory;
		phase: SecretScannerFailure["phase"];
		timeoutMs?: number;
	}> = [
		{
			name: "startup",
			factory: async () => {
				throw new Error("startup details");
			},
			phase: "startup",
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
			factory: async () => ({
				scan: () => new Promise<never>(() => undefined),
			}),
			phase: "timeout",
			timeoutMs: 10,
		},
		{
			name: "malformed-output",
			factory: async () => ({
				scan: async () => ({ ok: true, output: "not JSON" }),
			}),
			phase: "parse",
		},
	];

	for (const { name, factory, phase, timeoutMs = 50 } of failures) {
		it(`blocks a ${name} failure`, async () => {
			const temporary = await createTemporaryAgentDirectory();
			try {
				await writeFile(join(temporary.path, "notes.txt"), "safe\n", "utf8");
				const input = await validationInput(temporary.path, {
					scannerFactory: factory,
					scannerTimeoutMs: timeoutMs,
				});
				try {
					await validateStagedCandidate(input);
					assert.fail("Expected scanner failure");
				} catch (error) {
					expect(error).toBeInstanceOf(SecretScannerFailure);
					expect((error as SecretScannerFailure).phase).toBe(phase);
				}
			} finally {
				await temporary.cleanup();
			}
		});
	}

	it("blocks and redacts secret findings", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const matchedValue = "MATCHED-SECRET-TEXT";
		try {
			await writeFile(join(temporary.path, "notes.txt"), "safe\n", "utf8");
			const input = await validationInput(temporary.path, {
				scannerFactory: async () => ({
					scan: async (_content, path) =>
						path === "notes.txt"
							? {
									ok: false,
									output: JSON.stringify([
										{
											messages: [
												{
													ruleId: "@secretlint/example",
													line: 2,
													message: `matched ${matchedValue}`,
												},
											],
										},
									]),
								}
							: { ok: true, output: "[]" },
				}),
			});
			try {
				await validateStagedCandidate(input);
				assert.fail("Expected secret finding");
			} catch (error) {
				expect(error).toBeInstanceOf(SecretFindingError);
				const findingError = error as SecretFindingError;
				expect(findingError.findings).toEqual([{ type: "@secretlint/example", path: "notes.txt", line: 2 }]);
				expect(Object.keys(findingError.findings[0] ?? {}).sort()).toEqual(["line", "path", "type"]);
				expect(JSON.stringify(findingError)).not.toContain(matchedValue);
				expect(String(findingError)).not.toContain(matchedValue);
			}
		} finally {
			await temporary.cleanup();
		}
	});
});
