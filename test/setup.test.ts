import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { ExecResult, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect } from "expect";
import * as vi from "jest-mock";
import { getConfigSyncPaths } from "../src/config.ts";
import { type GitExec, inspectSetupRepository, SHARED_MANIFEST_PATH } from "../src/git.ts";
import { buildPlanArtifact, type PlanArtifactAction } from "../src/plan.ts";
import { FIRST_SYNC_MODE_OPTIONS, prepareFirstSync, selectFirstSyncMode } from "../src/setup.ts";
import type { RepositoryConfig } from "../src/types.ts";
import { createTemporaryAgentDirectory, createTemporaryBareGitRepository } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const COMMIT = "1".repeat(40);
const HASH = "a".repeat(64);

function plan(
	mode: "publish" | "apply" | "reconcile",
	sharedCommit: string | null,
	actions: PlanArtifactAction[] = [],
) {
	return buildPlanArtifact({
		actions,
		baselineCommit: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		decisions: [],
		effectivePaths: ["settings.json"],
		finalMachineTree: {},
		finalSharedTree: {},
		machineFingerprint: HASH,
		mode,
		noOpEffects: [],
		packageFingerprint: HASH,
		policyFingerprint: HASH,
		prohibitedEffects: [],
		remoteCheckedAt: "2026-01-01T00:00:01.000Z",
		sharedCommit,
		sharedFingerprint: HASH,
		scopeExpansion: null,
	});
}

function context(selected?: string): Pick<ExtensionCommandContext, "hasUI" | "ui"> {
	return {
		hasUI: true,
		ui: {
			select: vi.fn(async () => selected),
		} as unknown as ExtensionCommandContext["ui"],
	};
}

function gitExec(): GitExec {
	return async (command, args, options): Promise<ExecResult> => {
		try {
			const result = await execFileAsync(command, args, {
				cwd: options?.cwd,
				signal: options?.signal,
				timeout: options?.timeout,
				encoding: "utf8",
			});
			return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
		} catch (error) {
			const result = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: typeof result.code === "number" ? result.code : 1,
				killed: result.killed ?? false,
			};
		}
	};
}

async function seedWithoutManifest(repositoryPath: string, root: string): Promise<string> {
	const checkout = join(root, "seed");
	await execFileAsync("git", ["clone", repositoryPath, checkout]);
	await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: checkout });
	await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
	await writeFile(join(checkout, "settings.json"), "{}\n", "utf8");
	await execFileAsync("git", ["add", "settings.json"], { cwd: checkout });
	await execFileAsync("git", ["commit", "-m", "Seed"], { cwd: checkout });
	await execFileAsync("git", ["push", "origin", "HEAD:main"], { cwd: checkout });
	return checkout;
}

async function repositoryRefs(repositoryPath: string): Promise<string> {
	const result = await execFileAsync("git", ["for-each-ref", "--format=%(refname):%(objectname)"], {
		cwd: repositoryPath,
	});
	return result.stdout;
}

describe("first synchronization setup", () => {
	it("asks for exactly one fixed mode and generates one normal first-sync plan", async () => {
		const selected = FIRST_SYNC_MODE_OPTIONS[1];
		const ctx = context(selected.label);
		const inspectRepository = vi.fn(async () => ({
			empty: false,
			manifest: { managedScope: ["settings.json"], schemaVersion: 1 as const },
			privacyNotice: "SHARED REPOSITORY privacy could not be verified." as const,
			sharedCommit: COMMIT,
			workspace: { branch: "main", hooksDirectory: "/hooks", repositoryDirectory: "/repository" },
		}));
		const generatePlan = vi.fn(
			async ({ mode, sharedCommit }: { mode: "publish" | "apply" | "reconcile"; sharedCommit: string | null }) =>
				plan(mode, sharedCommit),
		);
		const result = await prepareFirstSync({ ctx, inspectRepository, generatePlan });
		expect(result).toMatchObject({
			status: "planned",
			mode: "apply",
			privacyNotice: "SHARED REPOSITORY privacy could not be verified.",
		});
		expect(ctx.ui.select).toHaveBeenCalledWith(
			"Select one first synchronization mode",
			FIRST_SYNC_MODE_OPTIONS.map((option) => option.label),
		);
		expect(inspectRepository).toHaveBeenCalledTimes(1);
		expect(generatePlan).toHaveBeenCalledTimes(1);
		expect(generatePlan).toHaveBeenCalledWith(
			expect.objectContaining({ baseline: null, mode: "apply", sharedCommit: COMMIT }),
		);
	});

	it("does not guess a mode and rejects every first-sync deletion", async () => {
		await expect(
			selectFirstSyncMode({ hasUI: false, ui: {} as ExtensionCommandContext["ui"] }),
		).resolves.toBeUndefined();
		const deletion: PlanArtifactAction = {
			action: "DELETE FROM SHARED REPOSITORY",
			codeExecution: false,
			destination: "SHARED REPOSITORY",
			direction: "machine-to-shared",
			finalResult: "old.json will not exist in SHARED REPOSITORY.",
			path: "old.json",
			reason: "THIS MACHINE deleted the tracked file.",
			resultSha256: null,
			risk: "deletion",
			sourceSha256: HASH,
		};
		await expect(
			prepareFirstSync({
				ctx: context(),
				mode: "publish",
				inspectRepository: async () => ({
					empty: true,
					manifest: null,
					privacyNotice: "SHARED REPOSITORY privacy could not be verified.",
					sharedCommit: null,
					workspace: { branch: "main", hooksDirectory: "/hooks", repositoryDirectory: "/repository" },
				}),
				generatePlan: async () => plan("publish", null, [deletion]),
			}),
		).rejects.toThrow("cannot delete");
	});
});

describe("setup repository inspection", () => {
	it("verifies access without changing SHARED REPOSITORY refs and requires a valid manifest", async () => {
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const repository: RepositoryConfig = { branch: "main", repositoryPath: shared.path };
		try {
			const emptyRefs = await repositoryRefs(shared.path);
			const empty = await inspectSetupRepository({
				exec: gitExec(),
				agentDirectory: agent.path,
				repository,
			});
			expect(empty).toMatchObject({
				empty: true,
				manifest: null,
				privacyNotice: "SHARED REPOSITORY privacy could not be verified.",
				sharedCommit: null,
			});
			expect(await repositoryRefs(shared.path)).toBe(emptyRefs);

			const checkout = await seedWithoutManifest(shared.path, agent.path);
			const refsBeforeRejectedInspection = await repositoryRefs(shared.path);
			await expect(inspectSetupRepository({ exec: gitExec(), agentDirectory: agent.path, repository })).rejects.toThrow(
				`valid ${SHARED_MANIFEST_PATH} manifest`,
			);
			expect(await repositoryRefs(shared.path)).toBe(refsBeforeRejectedInspection);

			await writeFile(
				join(checkout, SHARED_MANIFEST_PATH),
				JSON.stringify({ managedScope: ["settings.json"], schemaVersion: 1 }),
				"utf8",
			);
			await execFileAsync("git", ["add", SHARED_MANIFEST_PATH], { cwd: checkout });
			await execFileAsync("git", ["commit", "-m", "Add manifest"], { cwd: checkout });
			await execFileAsync("git", ["push", "origin", "HEAD:main"], { cwd: checkout });
			const refsBeforeAcceptedInspection = await repositoryRefs(shared.path);
			const inspected = await inspectSetupRepository({ exec: gitExec(), agentDirectory: agent.path, repository });
			expect(inspected.empty).toBe(false);
			expect(inspected.manifest).toEqual({ managedScope: ["settings.json"], schemaVersion: 1 });
			expect(await repositoryRefs(shared.path)).toBe(refsBeforeAcceptedInspection);
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});

	for (const failure of ["offline", "authentication"]) {
		it(`blocks ${failure} failure without changing SHARED REPOSITORY refs`, async () => {
			const agent = await createTemporaryAgentDirectory();
			const shared = await createTemporaryBareGitRepository();
			const repository: RepositoryConfig = { branch: "main", repositoryPath: shared.path };
			try {
				await inspectSetupRepository({ exec: gitExec(), agentDirectory: agent.path, repository });
				const refsBefore = await repositoryRefs(shared.path);
				const unavailable: GitExec = async (command, args, options) =>
					args.includes("ls-remote")
						? { stdout: "", stderr: "unavailable", code: 1, killed: false }
						: gitExec()(command, args, options);
				await expect(
					inspectSetupRepository({ exec: unavailable, agentDirectory: agent.path, repository }),
				).rejects.toThrow("access verification failed");
				expect(await repositoryRefs(shared.path)).toBe(refsBefore);
			} finally {
				await Promise.all([agent.cleanup(), shared.cleanup()]);
			}
		});
	}

	it("does not delete or replace an existing invalid clone path", async () => {
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const paths = getConfigSyncPaths(agent.path);
		const sentinel = join(paths.repositoryDirectory, "keep.txt");
		try {
			await mkdir(paths.repositoryDirectory, { recursive: true });
			await writeFile(sentinel, "keep", "utf8");
			await expect(
				inspectSetupRepository({
					exec: gitExec(),
					agentDirectory: agent.path,
					repository: { branch: "main", repositoryPath: shared.path },
				}),
			).rejects.toThrow("not changed");
			expect(await readFile(sentinel, "utf8")).toBe("keep");
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});
});
