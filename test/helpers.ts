import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface TemporaryPath {
	path: string;
	cleanup(): Promise<void>;
}

export async function createTemporaryAgentDirectory(): Promise<TemporaryPath> {
	const path = await mkdtemp(join(tmpdir(), "pi-sync-agent-"));
	return {
		path,
		cleanup: () => rm(path, { force: true, recursive: true }),
	};
}

export async function createTemporaryBareGitRepository(): Promise<TemporaryPath> {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-git-"));
	const path = join(root, "shared.git");
	await execFileAsync("git", ["-c", "init.defaultBranch=main", "init", "--bare", path]);
	return {
		path,
		cleanup: () => rm(root, { force: true, recursive: true }),
	};
}
