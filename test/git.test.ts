import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFileInventory, type InventoryFile } from "../src/files.ts";
import {
	createCandidateCommit,
	diffFromLastNamedSnapshot,
	fetchSharedSnapshot,
	type GitExec,
	publishCandidateCommit,
} from "../src/git.ts";
import type { RepositoryConfig } from "../src/types.ts";
import { createTemporaryAgentDirectory, createTemporaryBareGitRepository } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const PLAN_ID = "1".repeat(64);
let savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;

interface GitCall {
	command: string;
	args: string[];
	cwd?: string;
	timeout?: number;
	signal?: AbortSignal;
}

function createGitExec(calls: GitCall[] = []): GitExec {
	return async (command, args, options): Promise<ExecResult> => {
		calls.push({ command, args: [...args], cwd: options?.cwd, timeout: options?.timeout, signal: options?.signal });
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
	await writeFile(join(seed, "settings.json"), '{"theme":"dark"}\n', "utf8");
	await execFileAsync("git", ["add", "settings.json"], { cwd: seed });
	await execFileAsync("git", ["commit", "-m", "Seed"], { cwd: seed });
	await execFileAsync("git", ["push", "origin", "HEAD:main"], { cwd: seed });
	const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: seed });
	return result.stdout.trim();
}

function file(path: string, content: string): Readonly<InventoryFile> {
	const bytes = Buffer.from(content, "utf8");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	return Object.freeze({
		path,
		size: bytes.byteLength,
		sha256,
		comparisonSha256: sha256,
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

afterEach(() => {
	if (savedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig;
	savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
});

describe("Git snapshots and candidates", () => {
	it("fetches before planning and creates a one-parent candidate from that exact commit", async () => {
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const calls: GitCall[] = [];
		const exec = createGitExec(calls);
		const repository: RepositoryConfig = { repositoryPath: shared.path, branch: "main" };
		try {
			const seededCommit = await seedRepository(shared.path, agent.path);
			const fetched = await fetchSharedSnapshot({ exec, agentDirectory: agent.path, repository });
			expect(fetched.status).toBe("ready");
			if (fetched.status !== "ready") return;
			expect(fetched.snapshot.sharedCommit).toBe(seededCommit);
			const current = await discoverFileInventory(fetched.snapshot.workspace.repositoryDirectory, "shared");
			const finalTree = { ...current.files, "settings.json": file("settings.json", '{"theme":"light"}\n') };
			const candidate = await createCandidateCommit({
				exec,
				snapshot: fetched.snapshot,
				planId: PLAN_ID,
				currentSharedTree: current.files,
				finalSharedTree: finalTree,
			});
			expect(candidate.reviewedSharedCommit).toBe(seededCommit);
			const parent = await execFileAsync("git", ["rev-parse", `${candidate.candidateCommit}^`], {
				cwd: candidate.workspace.repositoryDirectory,
			});
			expect(parent.stdout.trim()).toBe(seededCommit);
			const content = await execFileAsync("git", ["show", `${candidate.candidateCommit}:settings.json`], {
				cwd: candidate.workspace.repositoryDirectory,
			});
			expect(content.stdout).toBe('{"theme":"light"}\n');
			expect(calls.every((call) => call.command === "git" && call.timeout === 30_000)).toBe(true);
			expect(
				calls.every((call) => call.args.includes(`core.hooksPath=${fetched.snapshot.workspace.hooksDirectory}`)),
			).toBe(true);
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});

	it("returns a doctor result for an unknown worktree change", async () => {
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const exec = createGitExec();
		const repository: RepositoryConfig = { repositoryPath: shared.path, branch: "main" };
		try {
			await seedRepository(shared.path, agent.path);
			const first = await fetchSharedSnapshot({ exec, agentDirectory: agent.path, repository });
			expect(first.status).toBe("ready");
			if (first.status !== "ready") return;
			await writeFile(join(first.snapshot.workspace.repositoryDirectory, "unknown.txt"), "unknown", "utf8");
			const second = await fetchSharedSnapshot({ exec, agentDirectory: agent.path, repository });
			expect(second).toEqual({
				status: "doctor",
				doctor: {
					ok: false,
					code: "dirty_worktree",
					message: "The extension-owned Git worktree has unknown changes. Run /config-sync doctor.",
				},
			});
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});

	it("does not execute configured Git hooks", async () => {
		if (process.platform === "win32") return;
		const agent = await createTemporaryAgentDirectory();
		const shared = await createTemporaryBareGitRepository();
		const marker = join(agent.path, "hook-ran");
		const maliciousHooks = join(agent.path, "malicious-hooks");
		const globalConfig = join(agent.path, "gitconfig");
		await mkdir(maliciousHooks);
		for (const hook of ["post-checkout", "pre-commit", "post-commit"]) {
			const hookPath = join(maliciousHooks, hook);
			await writeFile(hookPath, `#!/bin/sh\nprintf ran > "${marker}"\n`, "utf8");
			await chmod(hookPath, 0o755);
		}
		await writeFile(globalConfig, `[core]\n\thooksPath = ${maliciousHooks}\n`, "utf8");
		await seedRepository(shared.path, agent.path);
		process.env.GIT_CONFIG_GLOBAL = globalConfig;
		const exec = createGitExec();
		const repository: RepositoryConfig = { repositoryPath: shared.path, branch: "main" };
		try {
			const fetched = await fetchSharedSnapshot({ exec, agentDirectory: agent.path, repository });
			expect(fetched.status).toBe("ready");
			if (fetched.status !== "ready") return;
			const repositoryHooks = join(fetched.snapshot.workspace.repositoryDirectory, ".git", "hooks");
			await mkdir(repositoryHooks, { recursive: true });
			for (const hook of ["post-checkout", "pre-commit", "post-commit"]) {
				const hookPath = join(repositoryHooks, hook);
				await writeFile(hookPath, `#!/bin/sh\nprintf ran > "${marker}"\n`, "utf8");
				await chmod(hookPath, 0o755);
			}
			const current = await discoverFileInventory(fetched.snapshot.workspace.repositoryDirectory, "shared");
			await createCandidateCommit({
				exec,
				snapshot: fetched.snapshot,
				planId: PLAN_ID,
				currentSharedTree: current.files,
				finalSharedTree: { ...current.files, "settings.json": file("settings.json", "{}\n") },
			});
			await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});

	it("uses the last named snapshot for diff and refreshes only when requested", async () => {
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
				finalSharedTree: { ...current.files, "settings.json": file("settings.json", "{}\n") },
			});
			calls.length = 0;
			const firstDiff = await diffFromLastNamedSnapshot({
				exec,
				workspace: candidate.workspace,
				targetCommit: candidate.candidateCommit,
				path: "settings.json",
			});
			expect(firstDiff.baseCommit).toBe(candidate.reviewedSharedCommit);
			expect(firstDiff.diff).toContain("settings.json");
			expect(calls.some((call) => call.args.includes("fetch"))).toBe(false);

			calls.length = 0;
			await diffFromLastNamedSnapshot({
				exec,
				workspace: candidate.workspace,
				targetCommit: candidate.candidateCommit,
				refresh: { agentDirectory: agent.path, repository },
			});
			expect(calls.some((call) => call.args.includes("fetch"))).toBe(true);
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
				finalSharedTree: { ...current.files, "settings.json": file("settings.json", "{}\n") },
			});
			const concurrentCommit = await advanceSharedRepository(shared.path, agent.path);
			const result = await publishCandidateCommit({ exec, candidate });
			expect(result).toEqual({
				status: "plan_expired",
				message: "PLAN EXPIRED",
				candidateCommit: candidate.candidateCommit,
				currentSharedCommit: concurrentCommit,
			});
			expect(await readFile(machineMarker, "utf8")).toBe("unchanged");
			const preserved = await execFileAsync("git", ["rev-parse", candidate.ref], {
				cwd: candidate.workspace.repositoryDirectory,
			});
			expect(preserved.stdout.trim()).toBe(candidate.candidateCommit);
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
				finalSharedTree: { ...current.files, "settings.json": file("settings.json", "{}\n") },
			});
			const result = await publishCandidateCommit({ exec, candidate });
			expect(result).toEqual({ status: "published", publishedCommit: candidate.candidateCommit });
			const head = await execFileAsync("git", ["rev-parse", "refs/heads/main"], { cwd: shared.path });
			expect(head.stdout.trim()).toBe(candidate.candidateCommit);
			const pushCalls = calls.filter((call) => call.args.includes("push"));
			expect(pushCalls).toHaveLength(1);
			expect(pushCalls[0]?.args).not.toContain("--force");
			expect(pushCalls[0]?.args).not.toContain("--force-with-lease");
		} finally {
			await Promise.all([agent.cleanup(), shared.cleanup()]);
		}
	});
});
