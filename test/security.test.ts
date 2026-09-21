import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { createDefaultLocalPolicy } from "../src/config.ts";
import { discoverFileInventory } from "../src/files.ts";
import { restoreAgentSecrets } from "../src/secrets.ts";
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

describe("Bitwarden agent secret restore", () => {
	const manifest = {
		projectId: "bdf0f162-017c-4811-a0f4-b48e010f6287" as const,
		environment: {
			ZETA_TOKEN: "zeta-token",
			TEST_TOKEN: "test-token",
			ALPHA_TOKEN: "alpha-token",
		},
		authJsonKey: "pi-auth-json",
	};

	it("writes only mapped values after complete validation with mode 0600", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const previousToken = process.env.BWS_ACCESS_TOKEN;
		process.env.BWS_ACCESS_TOKEN = "test-bootstrap-token";
		try {
			await restoreAgentSecrets({
				exec: async (command, args) => {
					assert.equal(command, "bws");
					assert.deepEqual(args, ["secret", "list", manifest.projectId, "--output", "json"]);
					return {
						stdout: JSON.stringify([
							{ key: "zeta-token", value: "zeta-value" },
							{ key: "pi-auth-json", value: '{"providers":{}}' },
							{ key: "test-token", value: "mapped-value" },
							{ key: "alpha-token", value: "alpha-value" },
							{ key: "unmapped", value: "must-not-be-written" },
						]),
						stderr: "",
						code: 0,
						killed: false,
					};
				},
				manifest,
				piDirectory: temporary.path,
			});
			const environmentPath = join(temporary.path, "agent", ".env");
			const authPath = join(temporary.path, "agent", "auth.json");
			assert.equal(
				await readFile(environmentPath, "utf8"),
				'ALPHA_TOKEN="alpha-value"\nTEST_TOKEN="mapped-value"\nZETA_TOKEN="zeta-value"\n',
			);
			assert.equal(await readFile(authPath, "utf8"), '{"providers":{}}\n');
			assert.equal((await stat(environmentPath)).mode & 0o777, 0o600);
			assert.equal((await stat(authPath)).mode & 0o777, 0o600);
		} finally {
			if (previousToken === undefined) delete process.env.BWS_ACCESS_TOKEN;
			else process.env.BWS_ACCESS_TOKEN = previousToken;
			await temporary.cleanup();
		}
	});

	it("writes neither file when the authentication document is invalid", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const previousToken = process.env.BWS_ACCESS_TOKEN;
		process.env.BWS_ACCESS_TOKEN = "test-bootstrap-token";
		try {
			await assert.rejects(
				restoreAgentSecrets({
					exec: async () => ({
						stdout: JSON.stringify([
							{ key: "test-token", value: "mapped-value" },
							{ key: "alpha-token", value: "alpha-value" },
							{ key: "zeta-token", value: "zeta-value" },
							{ key: "pi-auth-json", value: "invalid-json" },
						]),
						stderr: "",
						code: 0,
						killed: false,
					}),
					manifest,
					piDirectory: temporary.path,
				}),
				/invalid authentication document/,
			);
			await assert.rejects(readFile(join(temporary.path, "agent", ".env")), /ENOENT/);
			await assert.rejects(readFile(join(temporary.path, "agent", "auth.json")), /ENOENT/);
		} finally {
			if (previousToken === undefined) delete process.env.BWS_ACCESS_TOKEN;
			else process.env.BWS_ACCESS_TOKEN = previousToken;
			await temporary.cleanup();
		}
	});

	it("redacts Bitwarden command failures and writes no secret files", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const previousToken = process.env.BWS_ACCESS_TOKEN;
		const sensitiveOutput = "sensitive-command-output";
		process.env.BWS_ACCESS_TOKEN = "test-bootstrap-token";
		try {
			await assert.rejects(
				restoreAgentSecrets({
					exec: async () => ({
						stdout: sensitiveOutput,
						stderr: sensitiveOutput,
						code: 1,
						killed: false,
					}),
					manifest,
					piDirectory: temporary.path,
				}),
				(error: unknown) => error instanceof Error && !error.message.includes(sensitiveOutput),
			);
			await assert.rejects(readFile(join(temporary.path, "agent", ".env")), /ENOENT/);
			await assert.rejects(readFile(join(temporary.path, "agent", "auth.json")), /ENOENT/);
		} finally {
			if (previousToken === undefined) delete process.env.BWS_ACCESS_TOKEN;
			else process.env.BWS_ACCESS_TOKEN = previousToken;
			await temporary.cleanup();
		}
	});
});

describe("staged final-tree validation", () => {
	it("rejects a permanently denied staged path before candidate creation", async () => {
		const temporary = await createTemporaryAgentDirectory();
		const scannerFactory = mock.fn(CLEAN_SCANNER);
		try {
			await writeFile(join(temporary.path, ".env"), "DENIED=value\n", "utf8");
			const input = await validationInput(temporary.path, {
				stagedPaths: [".env"],
				plannedFinalSharedTree: {},
				scannerFactory,
			});
			await assert.rejects(validateStagedCandidate(input), /Permanently denied path/);
			assert.equal(scannerFactory.mock.callCount(), 0);
		} finally {
			await temporary.cleanup();
		}
	});

	it("rejects a full-tree fingerprint mismatch", async () => {
		const temporary = await createTemporaryAgentDirectory();
		try {
			await mkdir(join(temporary.path, "agent"));
			await writeFile(join(temporary.path, "agent", "settings.json"), "{}\n", "utf8");
			const input = await validationInput(temporary.path);
			const expected = {
				...input.plannedFinalSharedTree,
				"agent/settings.json": {
					...input.plannedFinalSharedTree["agent/settings.json"],
					sha256: "f".repeat(64),
				},
			};
			await assert.rejects(
				validateStagedCandidate({ ...input, plannedFinalSharedTree: expected }),
				/does not match the immutable plan: settings\.json/,
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
			await assert.rejects(validateStagedCandidate(await validationInput(conflict.path)), /conflict marker/);
			await writeFile(join(invalidJson.path, "theme.json"), "{invalid", "utf8");
			await assert.rejects(
				validateStagedCandidate(await validationInput(invalidJson.path)),
				/Managed JSON is invalid: theme\.json/,
			);
		} finally {
			await Promise.all([conflict.cleanup(), invalidJson.cleanup()]);
		}
	});

	it("validates shared settings packages and machine-only policy preservation", async () => {
		const invalidPackage = await createTemporaryAgentDirectory();
		const lostPolicy = await createTemporaryAgentDirectory();
		try {
			await Promise.all([mkdir(join(invalidPackage.path, "agent")), mkdir(join(lostPolicy.path, "agent"))]);
			await writeFile(
				join(invalidPackage.path, "agent", "settings.json"),
				'{"packages":["npm:example@latest"]}',
				"utf8",
			);
			await assert.rejects(validateStagedCandidate(await validationInput(invalidPackage.path)), /not pinned/);

			await writeFile(join(lostPolicy.path, "agent", "settings.json"), "{}", "utf8");
			const policy = { ...createDefaultLocalPolicy(), machineOnlySettings: ["/machine/value"] };
			const input = await validationInput(lostPolicy.path, {
				policy,
				machineSettings: {
					currentText: '{"machine":{"value":1}}',
					finalText: '{"machine":{"value":2}}',
				},
			});
			await assert.rejects(validateStagedCandidate(input), /Machine-only setting was not preserved/);
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

	it("blocks scanner startup, read, timeout, and malformed-output failures", async () => {
		for (const { name, factory, phase, timeoutMs = 50 } of failures) {
			const temporary = await createTemporaryAgentDirectory();
			try {
				await writeFile(join(temporary.path, "notes.txt"), "safe\n", "utf8");
				const input = await validationInput(temporary.path, {
					scannerFactory: factory,
					scannerTimeoutMs: timeoutMs,
				});
				await assert.rejects(
					validateStagedCandidate(input),
					(error: unknown) => error instanceof SecretScannerFailure && error.phase === phase,
					name,
				);
			} finally {
				await temporary.cleanup();
			}
		}
	});

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
				assert.ok(error instanceof SecretFindingError);
				assert.deepEqual(error.findings, [{ type: "@secretlint/example", path: "notes.txt", line: 2 }]);
				assert.deepEqual(Object.keys(error.findings[0] ?? {}).sort(), ["line", "path", "type"]);
				assert.ok(!JSON.stringify(error).includes(matchedValue));
				assert.ok(!String(error).includes(matchedValue));
			}
		} finally {
			await temporary.cleanup();
		}
	});
});
