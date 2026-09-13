import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import writeFileAtomic from "write-file-atomic";
import { createDefaultLocalPolicy, ensureConfigSyncDirectories, getConfigSyncPaths } from "./config.ts";
import { type InventoryFile, resolveManagedPath } from "./files.ts";
import { type CandidateSecurityOptions, validateStagedCandidate } from "./security.ts";
import { validateArtifact } from "./state.ts";
import { type RepositoryConfig, type SharedManifest, SharedManifestSchema } from "./types.ts";

export type GitExec = ExtensionAPI["exec"];

export interface GitWorkspace {
	repositoryDirectory: string;
	hooksDirectory: string;
	branch: string;
}

export interface SharedSnapshot {
	workspace: Readonly<GitWorkspace>;
	sharedCommit: string;
	ref: string;
}

export interface GitDoctorResult {
	ok: false;
	code: "invalid_repository" | "repository_mismatch" | "dirty_worktree";
	message: string;
}

export type FetchSharedSnapshotResult =
	| { status: "ready"; snapshot: Readonly<SharedSnapshot> }
	| { status: "doctor"; doctor: Readonly<GitDoctorResult> };

export const SHARED_MANIFEST_PATH = "pi-config-sync.json";

export interface SetupRepositoryInspection {
	empty: boolean;
	manifest: Readonly<SharedManifest> | null;
	privacyNotice: "SHARED REPOSITORY privacy could not be verified.";
	sharedCommit: string | null;
	workspace: Readonly<GitWorkspace>;
}

export interface CandidateCommit {
	planId: string;
	reviewedSharedCommit: string;
	candidateCommit: string;
	ref: string;
	workspace: Readonly<GitWorkspace>;
}

export type PublishCandidateResult =
	| { status: "published"; publishedCommit: string }
	| { status: "plan_expired"; message: "PLAN EXPIRED"; candidateCommit: string; currentSharedCommit: string };

export const LAST_NAMED_SNAPSHOT_REF = "refs/pi-config-sync/snapshots/last-reviewed";
const LAST_CANDIDATE_REF = "refs/pi-config-sync/candidates/last";
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const PLAN_ID_PATTERN = /^[a-f0-9]{64}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class GitOperationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "GitOperationError";
	}
}

function validateBranch(branch: string): void {
	if (
		!BRANCH_PATTERN.test(branch) ||
		branch.includes("..") ||
		branch.includes("@{") ||
		branch.endsWith("/") ||
		branch.endsWith(".") ||
		branch.endsWith(".lock")
	) {
		throw new GitOperationError("SHARED REPOSITORY branch name is invalid.");
	}
}

function validateCommit(commit: string, label: string): void {
	if (!COMMIT_PATTERN.test(commit)) throw new GitOperationError(`${label} is not a valid commit ID.`);
}

function validatePlanId(planId: string): void {
	if (!PLAN_ID_PATTERN.test(planId)) throw new GitOperationError("Plan ID is invalid.");
}

function gitArguments(hooksDirectory: string, args: readonly string[]): string[] {
	return [
		"-c",
		`core.hooksPath=${hooksDirectory}`,
		"-c",
		`init.templateDir=${hooksDirectory}`,
		"-c",
		"commit.gpgSign=false",
		...args,
	];
}

async function executeGit(
	exec: GitExec,
	workspace: Pick<GitWorkspace, "repositoryDirectory" | "hooksDirectory">,
	args: readonly string[],
	operation: string,
	options: { signal?: AbortSignal; timeout?: number; allowFailure?: boolean } = {},
): Promise<ExecResult> {
	options.signal?.throwIfAborted();
	const result = await exec("git", gitArguments(workspace.hooksDirectory, args), {
		cwd: workspace.repositoryDirectory,
		signal: options.signal,
		timeout: options.timeout ?? DEFAULT_GIT_TIMEOUT_MS,
	});
	options.signal?.throwIfAborted();
	if (result.code !== 0 && !options.allowFailure) throw new GitOperationError(`${operation} failed.`);
	return result;
}

async function pathDetails(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function workspaceFor(agentDirectory: string, branch: string): Readonly<GitWorkspace> {
	const paths = getConfigSyncPaths(agentDirectory);
	return Object.freeze({
		repositoryDirectory: paths.repositoryDirectory,
		hooksDirectory: paths.hooksDirectory,
		branch,
	});
}

async function inspectWorkspace(
	exec: GitExec,
	workspace: Readonly<GitWorkspace>,
	repositoryPath: string,
	signal?: AbortSignal,
): Promise<Readonly<GitDoctorResult> | undefined> {
	const details = await pathDetails(workspace.repositoryDirectory);
	if (!details?.isDirectory() || details.isSymbolicLink()) {
		return Object.freeze({
			ok: false,
			code: "invalid_repository",
			message: "The extension-owned Git directory is invalid. Run /config-sync doctor.",
		});
	}
	const inside = await executeGit(exec, workspace, ["rev-parse", "--is-inside-work-tree"], "Git repository check", {
		signal,
		allowFailure: true,
	});
	if (inside.code !== 0 || inside.stdout.trim() !== "true") {
		return Object.freeze({
			ok: false,
			code: "invalid_repository",
			message: "The extension-owned Git directory is not a worktree. Run /config-sync doctor.",
		});
	}
	const origin = await executeGit(exec, workspace, ["remote", "get-url", "origin"], "Git origin check", {
		signal,
		allowFailure: true,
	});
	if (origin.code !== 0 || origin.stdout.trim() !== repositoryPath) {
		return Object.freeze({
			ok: false,
			code: "repository_mismatch",
			message: "The extension-owned Git directory does not match SHARED REPOSITORY. Run /config-sync doctor.",
		});
	}
	const status = await executeGit(
		exec,
		workspace,
		["status", "--porcelain=v1", "--untracked-files=all"],
		"Git worktree check",
		{ signal },
	);
	if (status.stdout.trim() !== "") {
		return Object.freeze({
			ok: false,
			code: "dirty_worktree",
			message: "The extension-owned Git worktree has unknown changes. Run /config-sync doctor.",
		});
	}
	return undefined;
}

async function ensureWorkspace(
	exec: GitExec,
	agentDirectory: string,
	repository: RepositoryConfig,
	signal?: AbortSignal,
): Promise<{ workspace: Readonly<GitWorkspace>; doctor?: Readonly<GitDoctorResult> }> {
	validateBranch(repository.branch);
	const paths = await ensureConfigSyncDirectories(agentDirectory);
	const workspace = workspaceFor(agentDirectory, repository.branch);
	const existing = await pathDetails(workspace.repositoryDirectory);
	if (!existing) {
		await executeGit(
			exec,
			{ repositoryDirectory: paths.root, hooksDirectory: paths.hooksDirectory },
			[
				"clone",
				"--branch",
				repository.branch,
				"--single-branch",
				"--",
				repository.repositoryPath,
				workspace.repositoryDirectory,
			],
			"SHARED REPOSITORY clone",
			{ signal },
		);
	}
	const doctor = await inspectWorkspace(exec, workspace, repository.repositoryPath, signal);
	return doctor ? { workspace, doctor } : { workspace };
}

async function fetchBranchCommit(
	exec: GitExec,
	workspace: Readonly<GitWorkspace>,
	signal?: AbortSignal,
): Promise<string> {
	await executeGit(
		exec,
		workspace,
		["fetch", "--no-tags", "origin", `refs/heads/${workspace.branch}`],
		"SHARED REPOSITORY fetch",
		{ signal },
	);
	const result = await executeGit(
		exec,
		workspace,
		["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
		"Fetched commit resolution",
		{ signal },
	);
	const commit = result.stdout.trim();
	validateCommit(commit, "Fetched SHARED REPOSITORY commit");
	return commit;
}

export async function inspectSetupRepository(options: {
	exec: GitExec;
	agentDirectory: string;
	repository: RepositoryConfig;
	signal?: AbortSignal;
}): Promise<Readonly<SetupRepositoryInspection>> {
	validateBranch(options.repository.branch);
	const paths = await ensureConfigSyncDirectories(options.agentDirectory);
	const workspace = workspaceFor(options.agentDirectory, options.repository.branch);
	const existing = await pathDetails(workspace.repositoryDirectory);
	if (!existing) {
		await mkdir(workspace.repositoryDirectory, { recursive: true });
		await executeGit(options.exec, workspace, ["init"], "Extension-owned Git initialization", {
			signal: options.signal,
		});
		await executeGit(
			options.exec,
			workspace,
			["remote", "add", "origin", options.repository.repositoryPath],
			"SHARED REPOSITORY origin setup",
			{ signal: options.signal },
		);
	} else {
		if (!existing.isDirectory() || existing.isSymbolicLink()) {
			throw new GitOperationError("The existing extension-owned Git path will not be deleted or replaced.");
		}
		const doctor = await inspectWorkspace(options.exec, workspace, options.repository.repositoryPath, options.signal);
		if (doctor) throw new GitOperationError(`${doctor.message} The existing clone was not changed.`);
	}
	await mkdir(paths.hooksDirectory, { recursive: true });
	const refs = await executeGit(options.exec, workspace, ["ls-remote", "origin"], "SHARED REPOSITORY access check", {
		signal: options.signal,
		allowFailure: true,
	});
	if (refs.code !== 0) throw new GitOperationError("SHARED REPOSITORY access verification failed.");
	const remoteRefs = refs.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/, 2))
		.filter((entry): entry is [string, string] => entry.length === 2);
	const branchRef = `refs/heads/${options.repository.branch}`;
	const branchEntry = remoteRefs.find(([, ref]) => ref === branchRef);
	if (remoteRefs.length === 0) {
		return Object.freeze({
			empty: true,
			manifest: null,
			privacyNotice: "SHARED REPOSITORY privacy could not be verified.",
			sharedCommit: null,
			workspace,
		});
	}
	if (!branchEntry) {
		throw new GitOperationError("SHARED REPOSITORY is not empty and its configured branch has no valid manifest.");
	}
	const sharedCommit = branchEntry[0];
	validateCommit(sharedCommit, "Inspected SHARED REPOSITORY commit");
	const setupRef = "refs/pi-config-sync/setup/inspected";
	await executeGit(
		options.exec,
		workspace,
		["fetch", "--no-tags", "origin", `${branchRef}:${setupRef}`],
		"SHARED REPOSITORY manifest fetch",
		{ signal: options.signal },
	);
	const manifestResult = await executeGit(
		options.exec,
		workspace,
		["show", `${setupRef}:${SHARED_MANIFEST_PATH}`],
		"SHARED REPOSITORY manifest read",
		{ signal: options.signal, allowFailure: true },
	);
	if (manifestResult.code !== 0) {
		throw new GitOperationError(
			`SHARED REPOSITORY is not empty and does not contain a valid ${SHARED_MANIFEST_PATH} manifest.`,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(manifestResult.stdout);
	} catch {
		throw new GitOperationError(
			`SHARED REPOSITORY is not empty and does not contain a valid ${SHARED_MANIFEST_PATH} manifest.`,
		);
	}
	let manifest: SharedManifest;
	try {
		manifest = validateArtifact(SharedManifestSchema, value, "SHARED REPOSITORY manifest");
	} catch {
		throw new GitOperationError(
			`SHARED REPOSITORY is not empty and does not contain a valid ${SHARED_MANIFEST_PATH} manifest.`,
		);
	}
	return Object.freeze({
		empty: false,
		manifest: Object.freeze({ ...manifest, managedScope: [...manifest.managedScope] }),
		privacyNotice: "SHARED REPOSITORY privacy could not be verified.",
		sharedCommit,
		workspace,
	});
}

export async function withSharedSnapshotWorktree<T>(options: {
	exec: GitExec;
	snapshot: Readonly<SharedSnapshot>;
	run(directory: string): Promise<T>;
	signal?: AbortSignal;
}): Promise<T> {
	const directory = resolve(
		dirname(options.snapshot.workspace.repositoryDirectory),
		"candidates",
		`snapshot-${options.snapshot.sharedCommit}-${randomUUID()}`,
	);
	if (await pathDetails(directory)) {
		throw new GitOperationError("The exact SHARED REPOSITORY snapshot workspace already exists.");
	}
	await executeGit(
		options.exec,
		options.snapshot.workspace,
		["worktree", "add", "--detach", directory, options.snapshot.sharedCommit],
		"SHARED REPOSITORY snapshot worktree creation",
		{ signal: options.signal },
	);
	try {
		return await options.run(directory);
	} finally {
		await executeGit(
			options.exec,
			options.snapshot.workspace,
			["worktree", "remove", directory],
			"SHARED REPOSITORY snapshot worktree cleanup",
		);
	}
}

export async function fetchSharedSnapshot(options: {
	exec: GitExec;
	agentDirectory: string;
	repository: RepositoryConfig;
	signal?: AbortSignal;
}): Promise<FetchSharedSnapshotResult> {
	const prepared = await ensureWorkspace(options.exec, options.agentDirectory, options.repository, options.signal);
	if (prepared.doctor) return { status: "doctor", doctor: prepared.doctor };
	const sharedCommit = await fetchBranchCommit(options.exec, prepared.workspace, options.signal);
	await executeGit(
		options.exec,
		prepared.workspace,
		["update-ref", LAST_NAMED_SNAPSHOT_REF, sharedCommit],
		"Named snapshot update",
		{ signal: options.signal },
	);
	return {
		status: "ready",
		snapshot: Object.freeze({ workspace: prepared.workspace, sharedCommit, ref: LAST_NAMED_SNAPSHOT_REF }),
	};
}

async function assertSafeCandidatePath(root: string, path: string): Promise<string> {
	const resolved = resolveManagedPath(root, path);
	const rootRelative = relative(root, resolved.absolutePath);
	let current = resolve(root);
	for (const component of rootRelative.split(sep)) {
		current = resolve(current, component);
		const details = await pathDetails(current);
		if (!details) break;
		if (details.isSymbolicLink()) throw new GitOperationError(`Candidate path is a symlink: ${path}`);
	}
	return resolved.absolutePath;
}

async function writeCandidateFile(root: string, path: string, file: Readonly<InventoryFile>): Promise<void> {
	if (file.exactBytesBase64 === undefined) throw new GitOperationError(`Candidate content is unavailable: ${path}`);
	const absolutePath = await assertSafeCandidatePath(root, path);
	const existing = await pathDetails(absolutePath);
	if (existing && !existing.isFile()) throw new GitOperationError(`Candidate path is not a regular file: ${path}`);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFileAtomic(absolutePath, Buffer.from(file.exactBytesBase64, "base64"), {
		fsync: true,
		mode: file.executable ? 0o755 : 0o644,
	});
	if (process.platform !== "win32") await chmod(absolutePath, file.executable ? 0o755 : 0o644);
}

async function deleteCandidateFile(root: string, path: string): Promise<void> {
	const absolutePath = await assertSafeCandidatePath(root, path);
	const existing = await pathDetails(absolutePath);
	if (!existing) return;
	if (!existing.isFile()) throw new GitOperationError(`Candidate path is not a regular file: ${path}`);
	await unlink(absolutePath);
}

async function resolveCommit(
	exec: GitExec,
	workspace: Readonly<GitWorkspace>,
	revision: string,
	signal?: AbortSignal,
): Promise<string> {
	const result = await executeGit(
		exec,
		workspace,
		["rev-parse", "--verify", `${revision}^{commit}`],
		"Commit resolution",
		{ signal },
	);
	const commit = result.stdout.trim();
	validateCommit(commit, "Resolved commit");
	return commit;
}

export async function createCandidateCommit(options: {
	exec: GitExec;
	snapshot: Readonly<SharedSnapshot>;
	planId: string;
	currentSharedTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	finalSharedTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	validation?: Partial<CandidateSecurityOptions>;
	signal?: AbortSignal;
}): Promise<Readonly<CandidateCommit>> {
	validatePlanId(options.planId);
	validateCommit(options.snapshot.sharedCommit, "Reviewed SHARED REPOSITORY commit");
	const reviewedRefCommit = await resolveCommit(
		options.exec,
		options.snapshot.workspace,
		options.snapshot.ref,
		options.signal,
	);
	if (reviewedRefCommit !== options.snapshot.sharedCommit)
		throw new GitOperationError("Reviewed snapshot no longer matches its named commit.");

	const candidateRef = `refs/pi-config-sync/candidates/${options.planId}`;
	const existingCandidate = await executeGit(
		options.exec,
		options.snapshot.workspace,
		["show-ref", "--verify", "--quiet", candidateRef],
		"Candidate lookup",
		{ signal: options.signal, allowFailure: true },
	);
	if (existingCandidate.code === 0) throw new GitOperationError("Candidate already exists and will not be rebuilt.");

	const candidateDirectory = resolve(
		dirname(options.snapshot.workspace.repositoryDirectory),
		"candidates",
		options.planId,
	);
	if (await pathDetails(candidateDirectory))
		throw new GitOperationError("Candidate workspace already exists and will not be replaced.");
	await executeGit(
		options.exec,
		options.snapshot.workspace,
		["worktree", "add", "--detach", candidateDirectory, options.snapshot.sharedCommit],
		"Candidate worktree creation",
		{ signal: options.signal },
	);

	const changedPaths = [
		...new Set([...Object.keys(options.currentSharedTree), ...Object.keys(options.finalSharedTree)]),
	].sort();
	for (const path of changedPaths) {
		options.signal?.throwIfAborted();
		const finalFile = options.finalSharedTree[path];
		if (finalFile) await writeCandidateFile(candidateDirectory, path, finalFile);
		else await deleteCandidateFile(candidateDirectory, path);
	}

	const candidateWorkspace = Object.freeze({
		...options.snapshot.workspace,
		repositoryDirectory: candidateDirectory,
	});
	if (changedPaths.length > 0) {
		await executeGit(options.exec, candidateWorkspace, ["add", "--all", "--", ...changedPaths], "Candidate staging", {
			signal: options.signal,
		});
	}
	const candidateDiff = await executeGit(
		options.exec,
		candidateWorkspace,
		["diff", "--cached", "--no-color", "--no-ext-diff", "--binary", options.snapshot.sharedCommit, "--"],
		"Candidate diff creation",
		{ signal: options.signal },
	);
	const stagedPathResult = await executeGit(
		options.exec,
		candidateWorkspace,
		["ls-files", "-z"],
		"Candidate path listing",
		{ signal: options.signal },
	);
	await validateStagedCandidate({
		stagedRoot: candidateDirectory,
		stagedPaths: stagedPathResult.stdout.split("\0").filter(Boolean),
		plannedFinalSharedTree: options.finalSharedTree,
		candidateDiff: candidateDiff.stdout,
		policy: options.validation?.policy ?? createDefaultLocalPolicy(),
		managedPatterns: options.validation?.managedPatterns ?? Object.keys(options.finalSharedTree),
		machineSettings: options.validation?.machineSettings,
		limits: options.validation?.limits,
		scannerFactory: options.validation?.scannerFactory,
		scannerTimeoutMs: options.validation?.scannerTimeoutMs,
		signal: options.signal,
	});
	await executeGit(
		options.exec,
		candidateWorkspace,
		[
			"-c",
			"user.name=Pi Config Sync",
			"-c",
			"user.email=pi-config-sync@invalid.example",
			"commit",
			"--allow-empty",
			"--no-gpg-sign",
			"--no-verify",
			"-m",
			`pi-config-sync candidate ${options.planId.slice(0, 12)}`,
		],
		"Candidate commit creation",
		{ signal: options.signal },
	);
	const candidateCommit = await resolveCommit(options.exec, candidateWorkspace, "HEAD", options.signal);
	const parentCommit = await resolveCommit(options.exec, candidateWorkspace, "HEAD^", options.signal);
	if (parentCommit !== options.snapshot.sharedCommit)
		throw new GitOperationError("Candidate parent does not match the reviewed commit.");
	await executeGit(
		options.exec,
		options.snapshot.workspace,
		["update-ref", candidateRef, candidateCommit],
		"Candidate reference update",
		{ signal: options.signal },
	);
	await executeGit(
		options.exec,
		options.snapshot.workspace,
		["update-ref", LAST_CANDIDATE_REF, candidateCommit],
		"Latest candidate reference update",
		{ signal: options.signal },
	);
	await executeGit(
		options.exec,
		options.snapshot.workspace,
		["worktree", "remove", candidateDirectory],
		"Candidate worktree cleanup",
		{ signal: options.signal },
	);
	return Object.freeze({
		planId: options.planId,
		reviewedSharedCommit: options.snapshot.sharedCommit,
		candidateCommit,
		ref: candidateRef,
		workspace: options.snapshot.workspace,
	});
}

function planExpired(candidate: Readonly<CandidateCommit>, currentSharedCommit: string): PublishCandidateResult {
	return {
		status: "plan_expired",
		message: "PLAN EXPIRED",
		candidateCommit: candidate.candidateCommit,
		currentSharedCommit,
	};
}

export async function publishCandidateCommit(options: {
	exec: GitExec;
	candidate: Readonly<CandidateCommit>;
	signal?: AbortSignal;
}): Promise<PublishCandidateResult> {
	validateCommit(options.candidate.reviewedSharedCommit, "Reviewed SHARED REPOSITORY commit");
	validateCommit(options.candidate.candidateCommit, "Candidate commit");
	const candidateCommit = await resolveCommit(
		options.exec,
		options.candidate.workspace,
		options.candidate.ref,
		options.signal,
	);
	if (candidateCommit !== options.candidate.candidateCommit)
		throw new GitOperationError("Candidate reference does not match the confirmed plan.");
	const parentCommit = await resolveCommit(
		options.exec,
		options.candidate.workspace,
		`${candidateCommit}^`,
		options.signal,
	);
	if (parentCommit !== options.candidate.reviewedSharedCommit) {
		throw new GitOperationError("Candidate parent does not match the reviewed commit.");
	}

	const currentSharedCommit = await fetchBranchCommit(options.exec, options.candidate.workspace, options.signal);
	if (currentSharedCommit !== options.candidate.reviewedSharedCommit) {
		return planExpired(options.candidate, currentSharedCommit);
	}
	const push = await executeGit(
		options.exec,
		options.candidate.workspace,
		["push", "origin", `${candidateCommit}:refs/heads/${options.candidate.workspace.branch}`],
		"PUBLISH to SHARED REPOSITORY",
		{ signal: options.signal, allowFailure: true },
	);
	if (push.code !== 0) {
		const latestSharedCommit = await fetchBranchCommit(options.exec, options.candidate.workspace, options.signal);
		if (latestSharedCommit !== options.candidate.reviewedSharedCommit) {
			return planExpired(options.candidate, latestSharedCommit);
		}
		throw new GitOperationError("PUBLISH to SHARED REPOSITORY failed.");
	}
	return { status: "published", publishedCommit: candidateCommit };
}

export async function diffFromLastNamedSnapshot(options: {
	exec: GitExec;
	workspace: Readonly<GitWorkspace>;
	targetCommit: string;
	path?: string;
	signal?: AbortSignal;
	refresh?: { agentDirectory: string; repository: RepositoryConfig };
}): Promise<{ baseCommit: string; diff: string }> {
	validateCommit(options.targetCommit, "Diff target commit");
	let workspace = options.workspace;
	if (options.refresh) {
		const refreshed = await fetchSharedSnapshot({
			exec: options.exec,
			agentDirectory: options.refresh.agentDirectory,
			repository: options.refresh.repository,
			signal: options.signal,
		});
		if (refreshed.status === "doctor") throw new GitOperationError(refreshed.doctor.message);
		workspace = refreshed.snapshot.workspace;
	}
	const baseCommit = await resolveCommit(options.exec, workspace, LAST_NAMED_SNAPSHOT_REF, options.signal);
	const path = options.path ? resolveManagedPath(workspace.repositoryDirectory, options.path).relativePath : undefined;
	const result = await executeGit(
		options.exec,
		workspace,
		[
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--src-prefix=SHARED_REPOSITORY/",
			"--dst-prefix=CANDIDATE/",
			baseCommit,
			options.targetCommit,
			...(path ? ["--", path] : []),
		],
		"Named snapshot diff",
		{ signal: options.signal },
	);
	return { baseCommit, diff: result.stdout };
}
