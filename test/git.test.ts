import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import stableStringify from "json-stable-stringify";
import { getConfigSyncPaths } from "../src/config.ts";
import { discoverFileInventory, type InventoryFile } from "../src/files.ts";
import {
	createCandidateCommit,
	diffFromLastNamedSnapshot,
	fetchSharedSnapshot,
	type GitExec,
	inspectSetupRepository,
	publishCandidateCommit,
	SHARED_MANIFEST_PATH,
} from "../src/git.ts";
import type { RepositoryConfig } from "../src/types.ts";
import { createTemporaryAgentDirectory, createTemporaryBareGitRepository } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const PLAN_ID = "1".repeat(64);
const BITWARDEN_MANIFEST = {
	projectId: "bdf0f162-017c-4811-a0f4-b48e010f6287",
	environment: {
		ALIBABA_TOKEN_PLAN_API_KEY: "alibaba-token-plan-api-key",
		EXA_API_KEY: "exa-api-key",
		FORGEJO_TOKEN: "forgejo-token",
		GEMINI_API_KEY: "gemini-api-key",
		KIMI_API_KEY: "kimi-api-key",
		LANGFUSE_BASE_URL: "langfuse-base-url",
		LANGFUSE_PUBLIC_KEY: "langfuse-public-key",
		LANGFUSE_SECRET_KEY: "langfuse-secret-key",
		PERPLEXITY_API_KEY: "perplexity-api-key",
		PINCHTAB_TOKEN: "pinchtab-token",
		SKILLSMP_API_KEY: "skillsmp-api-key",
	},
	authJsonKey: "pi-auth-json",
} as const;
interface GitCall {
	command: string;
	args: string[];
	cwd?: string;
}

function createGitExec(calls: GitCall[] = []): GitExec {
	return async (command, args, options): Promise<ExecResult> => {
		calls.push({ command, args: [...args], cwd: options?.cwd });
		try {
			const result = await execFileAsync(command, args, {
				cwd: options?.cwd,
				signal: options?.signal,
				timeout: options?.timeout,
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
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

async function seedRepository(repositoryPath: string, parent: string): Promise<string> {
	const seed = join(parent, "seed");
	await execFileAsync("git", ["clone", repositoryPath, seed]);
	await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: seed });
	await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: seed });
	await mkdir(join(seed, "agent"));
	await Promise.all([
		writeFile(join(seed, "agent", "settings.json"), '{"theme":"dark"}\n', "utf8"),
		writeFile(
			join(seed, SHARED_MANIFEST_PATH),
			`${JSON.stringify({ bitwarden: BITWARDEN_MANIFEST, managedScope: ["agent/settings.json"], schemaVersion: 1 })}\n`,
			"utf8",
		),
	]);
	await execFileAsync("git", ["add", "agent/settings.json", SHARED_MANIFEST_PATH], { cwd: seed });
	await execFileAsync("git", ["commit", "-m", "Seed"], { cwd: seed });
	await execFileAsync("git", ["push", "origin", "HEAD:main"], { cwd: seed });
	const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: seed });
	return result.stdout.trim();
}

function file(path: string, content: string): Readonly<InventoryFile> {
	const bytes = Buffer.from(content, "utf8");
	const canonical = path === "agent/settings.json" ? stableStringify(JSON.parse(content)) : content;
	if (canonical === undefined) throw new Error("Cannot create test file.");
	const comparisonBytes = path === "agent/settings.json" ? Buffer.from(canonical) : bytes;
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	return Object.freeze({
		path,
		size: bytes.byteLength,
		sha256,
		comparisonSha256: createHash("sha256").update(comparisonBytes).digest("hex"),
		executable: false,
		exactBytesBase64: bytes.toString("base64"),
	});
}

async function advanceSharedRepository(repositoryPath: string, parent: string): Promise<string> {
	const checkout = join(parent, `advance-${Date.now()}-${Math.random()}`);
	await execFileAsync("git", ["clone", "--branch", "main", repositoryPath, checkout]);
	await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: checkout });
	await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
	await writeFile(join(checkout, "shared.txt"), "concurrent\n", "utf8");
	await execFileAsync("git", ["add", "shared.txt"], { cwd: checkout });
	await execFileAsync("git", ["commit", "-m", "Concurrent change"], { cwd: checkout });
	await execFileAsync("git", ["push", "origin", "HEAD:main"], { cwd: checkout });
	const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: checkout });
	return result.stdout.trim();
}

describe("Git snapshots and candidates", () => {
	it("uses one exact snapshot for a one-parent candidate and focused diff", async () => {
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const calls: GitCall[] = [];
		const exec = createGitExec(calls);
		const repository: RepositoryConfig = { repositoryPath: shared.path, branch: "main" };
		try {
			const seededCommit = await seedRepository(shared.path, agent.path);
			const fetched = await fetchSharedSnapshot({ exec, agentDirectory: agent.path, repository });
			assert.equal(fetched.status, "ready");
			if (fetched.status !== "ready") return;
			assert.equal(fetched.snapshot.sharedCommit, seededCommit);
			const current = await discoverFileInventory(fetched.snapshot.workspace.repositoryDirectory, "shared");
			const finalTree = {
				...current.files,
				"agent/settings.json": file("agent/settings.json", '{"theme":"light"}\n'),
			};
			const candidate = await createCandidateCommit({
				exec,
				snapshot: fetched.snapshot,
				planId: PLAN_ID,
				currentSharedTree: current.files,
				finalSharedTree: finalTree,
			});
			assert.equal(candidate.reviewedSharedCommit, seededCommit);
			const revision = await execFileAsync("git", ["rev-list", "--parents", "-n", "1", candidate.candidateCommit], {
				cwd: candidate.workspace.repositoryDirectory,
			});
			assert.deepEqual(revision.stdout.trim().split(" "), [candidate.candidateCommit, seededCommit]);
			const content = await execFileAsync("git", ["show", `${candidate.candidateCommit}:agent/settings.json`], {
				cwd: candidate.workspace.repositoryDirectory,
			});
			assert.equal(content.stdout, '{"theme":"light"}\n');

			const diffCallIndex = calls.length;
			const focusedDiff = await diffFromLastNamedSnapshot({
				exec,
				workspace: candidate.workspace,
				targetCommit: candidate.candidateCommit,
				path: "agent/settings.json",
			});
			assert.equal(focusedDiff.baseCommit, seededCommit);
			assert.ok(focusedDiff.diff.includes("settings.json"));
			assert.ok(!calls.slice(diffCallIndex).some((call) => call.args.includes("fetch")));

			const hooksDirectory = getConfigSyncPaths(agent.path).hooksDirectory;
			for (const call of calls) {
				assert.equal(call.command, "git");
				assert.ok(call.args.includes(`core.hooksPath=${hooksDirectory}`));
				assert.ok(call.args.includes(`init.templateDir=${hooksDirectory}`));
			}
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});
});

describe("setup repository inspection", () => {
	it("accepts a valid shared manifest", async () => {
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const repository: RepositoryConfig = { branch: "main", repositoryPath: shared.path };
		try {
			const sharedCommit = await seedRepository(shared.path, agent.path);
			const inspected = await inspectSetupRepository({
				exec: createGitExec(),
				agentDirectory: agent.path,
				repository,
			});
			assert.equal(inspected.empty, false);
			assert.deepEqual(inspected.manifest, {
				bitwarden: BITWARDEN_MANIFEST,
				managedScope: ["agent/settings.json"],
				schemaVersion: 1,
			});
			assert.equal(inspected.sharedCommit, sharedCommit);
			assert.equal(inspected.privacyNotice, "SHARED REPOSITORY privacy could not be verified.");
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});

	it("does not delete or replace an invalid clone path", async () => {
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const paths = getConfigSyncPaths(agent.path);
		const sentinel = join(paths.repositoryDirectory, "keep.txt");
		try {
			await mkdir(paths.repositoryDirectory, { recursive: true });
			await writeFile(sentinel, "keep", "utf8");
			await assert.rejects(
				inspectSetupRepository({
					exec: createGitExec(),
					agentDirectory: agent.path,
					repository: { branch: "main", repositoryPath: shared.path },
				}),
				/not changed/,
			);
			assert.equal(await readFile(sentinel, "utf8"), "keep");
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});
});

describe("PUBLISH revalidation", () => {
	it("returns PLAN EXPIRED, preserves the candidate, and does not change THIS MACHINE", async () => {
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const exec = createGitExec();
		const repository: RepositoryConfig = { repositoryPath: shared.path, branch: "main" };
		const machineMarker = join(agent.path, "machine-marker");
		try {
			await seedRepository(shared.path, agent.path);
			await writeFile(machineMarker, "unchanged", "utf8");
			const fetched = await fetchSharedSnapshot({ exec, agentDirectory: agent.path, repository });
			if (fetched.status !== "ready") throw new Error("Snapshot unavailable");
			const current = await discoverFileInventory(fetched.snapshot.workspace.repositoryDirectory, "shared");
			const candidate = await createCandidateCommit({
				exec,
				snapshot: fetched.snapshot,
				planId: PLAN_ID,
				currentSharedTree: current.files,
				finalSharedTree: {
					...current.files,
					"agent/settings.json": file("agent/settings.json", "{}\n"),
				},
			});
			const concurrentCommit = await advanceSharedRepository(shared.path, agent.path);
			const result = await publishCandidateCommit({ exec, candidate });
			assert.deepEqual(result, {
				status: "plan_expired",
				message: "PLAN EXPIRED",
				candidateCommit: candidate.candidateCommit,
				currentSharedCommit: concurrentCommit,
			});
			assert.equal(await readFile(machineMarker, "utf8"), "unchanged");
			const preserved = await execFileAsync("git", ["rev-parse", candidate.ref], {
				cwd: candidate.workspace.repositoryDirectory,
			});
			assert.equal(preserved.stdout.trim(), candidate.candidateCommit);
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});

	it("publishes the exact candidate with a normal fast-forward update", async () => {
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const calls: GitCall[] = [];
		const exec = createGitExec(calls);
		const repository: RepositoryConfig = { repositoryPath: shared.path, branch: "main" };
		try {
			await seedRepository(shared.path, agent.path);
			const fetched = await fetchSharedSnapshot({ exec, agentDirectory: agent.path, repository });
			if (fetched.status !== "ready") throw new Error("Snapshot unavailable");
			const current = await discoverFileInventory(fetched.snapshot.workspace.repositoryDirectory, "shared");
			const candidate = await createCandidateCommit({
				exec,
				snapshot: fetched.snapshot,
				planId: PLAN_ID,
				currentSharedTree: current.files,
				finalSharedTree: {
					...current.files,
					"agent/settings.json": file("agent/settings.json", "{}\n"),
				},
			});
			const result = await publishCandidateCommit({ exec, candidate });
			assert.deepEqual(result, { status: "published", publishedCommit: candidate.candidateCommit });
			const head = await execFileAsync("git", ["rev-parse", "refs/heads/main"], { cwd: shared.path });
			assert.equal(head.stdout.trim(), candidate.candidateCommit);
			const pushCalls = calls.filter((call) => call.args.includes("push"));
			assert.equal(pushCalls.length, 1);
			assert.ok(!pushCalls[0]?.args.includes("--force"));
			assert.ok(!pushCalls[0]?.args.includes("--force-with-lease"));
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});
});
