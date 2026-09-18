import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
	const gitConfig = join(root, "gitconfig");
	const templateDirectory = join(root, "git-template");
	await mkdir(templateDirectory);
	await writeFile(gitConfig, "", "utf8");
	await execFileAsync("git", ["-c", "init.defaultBranch=main", "init", "--bare", path], {
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: gitConfig,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TEMPLATE_DIR: templateDirectory,
		},
	});
	return {
		path,
		cleanup: () => rm(root, { force: true, recursive: true }),
	};
}
