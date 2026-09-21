import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import writeFileAtomic from "write-file-atomic";
import type { SharedManifest } from "./types.ts";

export interface MappedSecrets {
	environment: Readonly<Record<string, string>>;
	authJson: string;
}

type BitwardenManifest = SharedManifest["bitwarden"];
type PiExec = ExtensionAPI["exec"];

interface BwsSecret {
	key: string;
	value: string;
}

function parseSecretList(stdout: string): BwsSecret[] {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new Error("Bitwarden returned an invalid secret list.");
	}
	if (
		!Array.isArray(value) ||
		value.some(
			(secret) =>
				!secret ||
				typeof secret !== "object" ||
				typeof (secret as { key?: unknown }).key !== "string" ||
				typeof (secret as { value?: unknown }).value !== "string",
		)
	) {
		throw new Error("Bitwarden returned an invalid secret list.");
	}
	return value as BwsSecret[];
}

const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function validatedSecretFiles(
	manifest: Readonly<BitwardenManifest>,
	secrets: Readonly<MappedSecrets>,
): {
	environment: string;
	authJson: string;
} {
	const mappings = Object.entries(manifest.environment);
	if (mappings.length === 0 || mappings.some(([name]) => !ENVIRONMENT_NAME_PATTERN.test(name))) {
		throw new Error("The Bitwarden environment mapping is invalid.");
	}
	if (
		Object.hasOwn(manifest.environment, "BWS_ACCESS_TOKEN") ||
		Object.values(manifest.environment).includes(manifest.authJsonKey) ||
		Object.keys(secrets.environment).length !== mappings.length
	) {
		throw new Error("The Bitwarden secret mapping is invalid.");
	}
	const environmentLines = mappings
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name]) => {
			const value = secrets.environment[name];
			if (typeof value !== "string" || value.length === 0) {
				throw new Error("Bitwarden did not return the complete mapped secret set.");
			}
			return `${name}=${JSON.stringify(value)}`;
		});
	if (!secrets.authJson) throw new Error("Bitwarden did not return the complete mapped secret set.");
	let auth: unknown;
	try {
		auth = JSON.parse(secrets.authJson);
	} catch {
		throw new Error("Bitwarden returned an invalid authentication document.");
	}
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
		throw new Error("Bitwarden returned an invalid authentication document.");
	}
	return {
		environment: `${environmentLines.join("\n")}\n`,
		authJson: secrets.authJson.endsWith("\n") ? secrets.authJson : `${secrets.authJson}\n`,
	};
}

async function writeSecretFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFileAtomic(path, content, { encoding: "utf8", fsync: true, mode: 0o600 });
	await chmod(path, 0o600);
}

export async function fetchMappedSecrets(options: {
	exec: PiExec;
	manifest: Readonly<BitwardenManifest>;
	signal?: AbortSignal;
}): Promise<MappedSecrets> {
	if (!process.env.BWS_ACCESS_TOKEN) {
		throw new Error("BWS_ACCESS_TOKEN is required to restore agent secrets.");
	}
	options.signal?.throwIfAborted();
	const result = await options.exec("bws", ["secret", "list", options.manifest.projectId, "--output", "json"], {
		signal: options.signal,
		timeout: 30_000,
	});
	options.signal?.throwIfAborted();
	if (result.code !== 0 || result.killed) throw new Error("Bitwarden secret retrieval failed.");

	const requestedKeys = new Set([...Object.values(options.manifest.environment), options.manifest.authJsonKey]);
	const values = new Map<string, string>();
	for (const secret of parseSecretList(result.stdout)) {
		if (!requestedKeys.has(secret.key)) continue;
		if (values.has(secret.key)) throw new Error("Bitwarden returned duplicate mapped secrets.");
		values.set(secret.key, secret.value);
	}

	const environment: Record<string, string> = {};
	for (const [name, key] of Object.entries(options.manifest.environment)) {
		const value = values.get(key);
		if (value === undefined) throw new Error("Bitwarden did not return the complete mapped secret set.");
		environment[name] = value;
	}
	const authJson = values.get(options.manifest.authJsonKey);
	if (authJson === undefined) throw new Error("Bitwarden did not return the complete mapped secret set.");
	return { environment: Object.freeze(environment), authJson };
}

export async function restoreAgentSecrets(options: {
	exec: PiExec;
	manifest: Readonly<BitwardenManifest>;
	piDirectory: string;
	signal?: AbortSignal;
}): Promise<void> {
	const secrets = await fetchMappedSecrets(options);
	const files = validatedSecretFiles(options.manifest, secrets);
	options.signal?.throwIfAborted();
	await writeSecretFile(resolve(options.piDirectory, "agent/.env"), files.environment);
	options.signal?.throwIfAborted();
	await writeSecretFile(resolve(options.piDirectory, "agent/auth.json"), files.authJson);
}
