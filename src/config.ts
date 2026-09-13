import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { minimatch } from "minimatch";
import type { LocalPolicy } from "./types.ts";

export const DEFAULT_MANAGED_SCOPE = Object.freeze([
	"AGENTS.md",
	"SYSTEM.md",
	"extensions/**",
	"keybindings.json",
	"prompts/**",
	"settings.json",
	"skills/**",
	"themes/**",
]);

export const PERMANENT_DENY_PATTERNS = Object.freeze([
	".config-sync/**",
	".env",
	"**/.env",
	"auth.json",
	"git/**",
	"npm/**",
	"sessions/**",
]);

export interface ConfigSyncPaths {
	root: string;
	configFile: string;
	stateFile: string;
	journalFile: string;
	plansDirectory: string;
	candidatesDirectory: string;
	backupsDirectory: string;
	repositoryDirectory: string;
	hooksDirectory: string;
}

export interface ScopePlan {
	effectivePaths: readonly string[];
	expansion: readonly string[];
	policyChangeOnly: boolean;
}

const MATCH_OPTIONS = {
	dot: true,
	matchBase: false,
	nocase: false,
	nonegate: true,
	windowsPathsNoEscape: true,
} as const;

function normalizeScope(scope: readonly string[]): string[] {
	return [...new Set(scope.map((pattern) => pattern.trim().replaceAll("\\", "/")).filter(Boolean))].sort();
}

function normalizeCandidatePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => minimatch(path, pattern, MATCH_OPTIONS));
}

export function getConfigSyncPaths(agentDirectory: string): Readonly<ConfigSyncPaths> {
	const root = resolve(agentDirectory, ".config-sync");
	return Object.freeze({
		root,
		configFile: resolve(root, "config.json"),
		stateFile: resolve(root, "state.json"),
		journalFile: resolve(root, "journal.json"),
		plansDirectory: resolve(root, "plans"),
		candidatesDirectory: resolve(root, "candidates"),
		backupsDirectory: resolve(root, "backups"),
		repositoryDirectory: resolve(root, "repository"),
		hooksDirectory: resolve(root, "hooks-disabled"),
	});
}

export async function ensureConfigSyncDirectories(agentDirectory: string): Promise<Readonly<ConfigSyncPaths>> {
	const paths = getConfigSyncPaths(agentDirectory);
	await Promise.all(
		[paths.root, paths.plansDirectory, paths.candidatesDirectory, paths.backupsDirectory, paths.hooksDirectory].map(
			(path) => mkdir(path, { recursive: true }),
		),
	);
	return paths;
}

export function createDefaultLocalPolicy(): LocalPolicy {
	return {
		acceptedSharedScope: [],
		approvedScope: [...DEFAULT_MANAGED_SCOPE],
		machineOnlySettings: [],
	};
}

export function isPermanentlyDenied(path: string): boolean {
	return matchesAny(normalizeCandidatePath(path), PERMANENT_DENY_PATTERNS);
}

export function resolveEffectivePaths(
	candidatePaths: readonly string[],
	sharedRequestedScope: readonly string[],
	machineApprovedScope: readonly string[],
): readonly string[] {
	const sharedScope = normalizeScope(sharedRequestedScope);
	const machineScope = normalizeScope(machineApprovedScope);
	const paths = [...new Set(candidatePaths.map(normalizeCandidatePath))]
		.filter((path) => matchesAny(path, sharedScope) && matchesAny(path, machineScope) && !isPermanentlyDenied(path))
		.sort();
	return Object.freeze(paths);
}

export function resolveScopePlan(
	candidatePaths: readonly string[],
	sharedRequestedScope: readonly string[],
	policy: LocalPolicy,
): Readonly<ScopePlan> {
	const requestedScope = normalizeScope(sharedRequestedScope);
	const acceptedScope = new Set(normalizeScope(policy.acceptedSharedScope));
	const expansion = requestedScope.filter((pattern) => !acceptedScope.has(pattern));
	if (expansion.length > 0) {
		return Object.freeze({
			effectivePaths: Object.freeze([]),
			expansion: Object.freeze(expansion),
			policyChangeOnly: true,
		});
	}
	return Object.freeze({
		effectivePaths: resolveEffectivePaths(candidatePaths, requestedScope, policy.approvedScope),
		expansion: Object.freeze([]),
		policyChangeOnly: false,
	});
}

export function approveScopeExpansion(
	policy: LocalPolicy,
	requestedScope: readonly string[],
	approvedInPlanId: string,
): LocalPolicy {
	return {
		...policy,
		acceptedSharedScope: [...policy.acceptedSharedScope],
		approvedScope: [...policy.approvedScope],
		machineOnlySettings: [...policy.machineOnlySettings],
		pendingScopeApproval: {
			approvedInPlanId,
			requestedScope: normalizeScope(requestedScope),
		},
	};
}

export function activateScopeApprovalForPlan(policy: LocalPolicy, planId: string): LocalPolicy {
	const approval = policy.pendingScopeApproval;
	if (!approval) return policy;
	if (approval.approvedInPlanId === planId) {
		throw new Error("A shared scope expansion can apply only to the next plan.");
	}
	return {
		acceptedSharedScope: [...approval.requestedScope],
		approvedScope: [...policy.approvedScope],
		machineOnlySettings: [...policy.machineOnlySettings],
	};
}
