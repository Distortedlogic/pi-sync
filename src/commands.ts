import { hash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import stableStringify from "json-stable-stringify";
import { resolveScopePlan } from "./config.ts";
import { buildConflictSummaries, collectConflictDecisions, createConflictMergeWorkspace } from "./conflicts.ts";
import { executeConfirmedTransaction, type TransactionSteps } from "./coordinator.ts";
import {
	buildInventorySet,
	createInventoryFile,
	type FileInventory,
	type InventoryFile,
	type InventorySet,
	sameContentFile,
	sameExactFile,
} from "./files.ts";
import {
	createCandidateCommit,
	diffFromLastNamedSnapshot,
	fetchSharedSnapshot,
	inspectSetupRepository,
	publishCandidateCommit,
	SHARED_MANIFEST_PATH,
	type SharedSnapshot,
	withSharedSnapshotWorktree,
} from "./git.ts";
import { executeConfirmedPackagePlan, packageActionDecisionId } from "./package-execution.ts";
import { packageSetFingerprint, planPackageChanges } from "./packages.ts";
import {
	blockersFor,
	buildPlanArtifact,
	createSyncPlan,
	type FilePlanAction,
	type PlanArtifactAction,
	type PlanDecision,
	planActionId,
	type SyncMode,
} from "./plan.ts";
import { type ProgressReporter, runWithProgress } from "./progress.ts";
import {
	buildRestorePlan,
	detectIncompleteJournal,
	executeRestorePlan,
	formatRecoveryNotice,
	getActiveAgentDirectory,
	type IncompleteJournal,
	listMachineBackups,
	requestRecoveryDecision,
	reviewRestorePlan,
} from "./recovery.ts";
import { restoreAgentSecrets } from "./secrets.ts";
import { createApplySettingsPlan, parseSettings } from "./settings.ts";
import { loadConfig, loadPlanArtifact, loadState, savePlanArtifact, validateArtifact } from "./state.ts";
import {
	applyMachineFilesFromBackup,
	buildMachineApplySet,
	createVerifiedMachineBackup,
	type MachineApplySet,
	restoreVerifiedMachineBackup,
	verifyMachineApplySet,
} from "./transaction.ts";
import {
	type ConfigDocument,
	type FileFingerprint,
	type PlanArtifact,
	type SharedManifest,
	SharedManifestSchema,
	type StateDocument,
} from "./types.ts";
import {
	authorizePlanExecution,
	type CollectedDecision,
	type DecisionRequirement,
	formatPlanText,
	reviewSyncPlan,
} from "./ui.ts";

export const CONFIG_SYNC_SUBCOMMANDS = Object.freeze([
	"status",
	"publish",
	"apply",
	"reconcile",
	"diff",
	"recover",
	"restore",
	"doctor",
]);

export type FooterStatusText =
	| "Config sync: clean"
	| `Config sync: ${number} to publish`
	| `Config sync: ${number} to apply`
	| `Config sync: ${number} conflicts`
	| "Config sync: recovery required"
	| "Config sync: remote status unknown";

export interface FooterStatus {
	freshness: "fresh" | "unknown";
	remoteCheckedAt?: string;
	text: FooterStatusText;
}

interface PlanInputs {
	agentDirectory: string;
	piDirectory: string;
	config: Readonly<ConfigDocument>;
	manifest: Readonly<SharedManifest>;
	state: Readonly<StateDocument>;
	snapshot: Readonly<SharedSnapshot>;
	inventory: Readonly<InventorySet>;
	machine: Readonly<FileInventory>;
	shared: Readonly<FileInventory>;
	baseline: Readonly<FileInventory>;
	effectivePaths: readonly string[];
	scopeExpansion: readonly string[];
	createdAt: string;
	remoteCheckedAt: string;
}

interface PreparedSync {
	agentDirectory: string;
	piDirectory: string;
	manifest: Readonly<SharedManifest>;
	blocked: boolean;
	blockers: readonly string[];
	config: Readonly<ConfigDocument>;
	state: Readonly<StateDocument>;
	snapshot: Readonly<SharedSnapshot>;
	machineTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	sharedTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	finalMachineTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	finalSharedTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	plannedSettingsText?: string;
	plan: Readonly<PlanArtifact>;
}

interface ParsedCommand {
	command: (typeof CONFIG_SYNC_SUBCOMMANDS)[number];
	arguments: string[];
}

const LOADED_RESOURCE_PATTERN =
	/^agent\/(?:AGENTS\.md|APPEND_SYSTEM\.md|SYSTEM\.md|keybindings\.json|models\.json|settings\.json|extensions\/|prompts\/|skills\/|themes\/)/;

function stableHash(value: unknown): string {
	const text = stableStringify(value);
	if (text === undefined) throw new Error("Cannot fingerprint configuration synchronization input.");
	return hash("sha256", text, "hex");
}

function exactText(file: Readonly<InventoryFile> | undefined, fallback = "{}\n"): string {
	return file?.exactBytesBase64 === undefined
		? fallback
		: Buffer.from(file.exactBytesBase64, "base64").toString("utf8");
}

function filterInventory(inventory: Readonly<FileInventory>, paths: readonly string[]): Readonly<FileInventory> {
	const selected = new Set(paths);
	const files = Object.freeze(
		Object.fromEntries(Object.entries(inventory.files).filter(([path]) => selected.has(path))),
	);
	return Object.freeze({ ...inventory, files });
}

function fileTreeHash(files: Readonly<Record<string, Readonly<InventoryFile>>>): string {
	return stableHash(
		Object.fromEntries(
			Object.entries(files)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([path, file]) => [
					path,
					{
						comparisonSha256: file.comparisonSha256,
						executable: file.executable,
						sha256: file.sha256,
					},
				]),
		),
	);
}

function mutableTree(
	files: Readonly<Record<string, Readonly<InventoryFile>>>,
): Record<string, Readonly<InventoryFile>> {
	return Object.fromEntries(Object.entries(files).map(([path, file]) => [path, Object.freeze({ ...file })]));
}

function fileArtifactAction(
	action: Readonly<FilePlanAction>,
	machineTree: Readonly<Record<string, Readonly<InventoryFile>>>,
	sharedTree: Readonly<Record<string, Readonly<InventoryFile>>>,
	finalMachineTree: Readonly<Record<string, Readonly<InventoryFile>>>,
	finalSharedTree: Readonly<Record<string, Readonly<InventoryFile>>>,
): PlanArtifactAction {
	const destination =
		action.direction === "machine-to-shared"
			? "SHARED REPOSITORY"
			: action.direction === "shared-to-machine"
				? "THIS MACHINE"
				: action.direction === "baseline-only"
					? "BASELINE"
					: "NONE";
	const source = action.direction === "machine-to-shared" ? sharedTree[action.path] : machineTree[action.path];
	const result =
		action.direction === "machine-to-shared"
			? finalSharedTree[action.path]
			: action.direction === "shared-to-machine"
				? finalMachineTree[action.path]
				: (machineTree[action.path] ?? sharedTree[action.path]);
	return {
		action: action.action,
		codeExecution: false,
		destination,
		direction: action.direction,
		finalResult: action.finalResult,
		path: action.path,
		reason: action.reason,
		resultSha256: result?.sha256 ?? null,
		risk: action.risk,
		sourceSha256: source?.sha256 ?? null,
	};
}

function packageArtifactAction(action: ReturnType<typeof planPackageChanges>["actions"][number]): PlanArtifactAction {
	return {
		action: action.action,
		codeExecution: true,
		destination: "THIS MACHINE",
		direction: "shared-to-machine",
		exactPackageSource: action.exactSource,
		finalResult: action.finalResult,
		normalizedPackageSource: action.normalizedSource,
		packageOperation: action.operation,
		path: action.identity,
		previousExactPackageSource: action.previousExactSource,
		previousNormalizedPackageSource: action.previousNormalizedSource,
		reason: action.reason,
		resultSha256: null,
		risk: "package",
		sourceSha256: null,
	};
}

function conflictDecision(decisions: readonly PlanDecision[], path: string): string | undefined {
	return decisions.find((decision) => decision.category === "conflict" && decision.id === `conflict:${path}`)?.choice;
}

function resolveConflicts(options: {
	actions: readonly Readonly<FilePlanAction>[];
	decisions: readonly PlanDecision[];
	machineTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	sharedTree: Readonly<Record<string, Readonly<InventoryFile>>>;
	finalMachineTree: Record<string, Readonly<InventoryFile>>;
	finalSharedTree: Record<string, Readonly<InventoryFile>>;
}): FilePlanAction[] {
	return options.actions.map((action) => {
		if (action.risk !== "conflict") return { ...action };
		const choice = conflictDecision(options.decisions, action.path);
		if (choice === "use_machine_both") {
			const file = options.machineTree[action.path];
			if (file) options.finalSharedTree[action.path] = file;
			else delete options.finalSharedTree[action.path];
			return {
				action: file ? "WRITE IN SHARED REPOSITORY" : "DELETE FROM SHARED REPOSITORY",
				direction: "machine-to-shared",
				finalResult: file
					? `${action.path} in SHARED REPOSITORY will match THIS MACHINE.`
					: `${action.path} will not exist in SHARED REPOSITORY.`,
				path: action.path,
				reason: "The confirmed conflict choice uses THIS MACHINE on both sides.",
				risk: file ? "write" : "deletion",
			};
		}
		if (choice === "use_shared_both") {
			const file = options.sharedTree[action.path];
			if (file) options.finalMachineTree[action.path] = file;
			else delete options.finalMachineTree[action.path];
			return {
				action: file ? "WRITE ON THIS MACHINE" : "DELETE FROM THIS MACHINE",
				direction: "shared-to-machine",
				finalResult: file
					? `${action.path} on THIS MACHINE will match SHARED REPOSITORY.`
					: `${action.path} will not exist on THIS MACHINE.`,
				path: action.path,
				reason: "The confirmed conflict choice uses SHARED REPOSITORY on both sides.",
				risk: file ? "write" : "deletion",
			};
		}
		return { ...action };
	});
}

async function readSharedManifest(directory: string): Promise<Readonly<SharedManifest>> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(`${directory}/${SHARED_MANIFEST_PATH}`, "utf8"));
	} catch (error) {
		throw new Error(`SHARED REPOSITORY has no valid ${SHARED_MANIFEST_PATH} manifest.`, { cause: error });
	}
	return validateArtifact(SharedManifestSchema, value, "SHARED REPOSITORY manifest");
}

async function loadPlanInputs(options: {
	pi: ExtensionAPI;
	mode: SyncMode;
	reporter: ProgressReporter;
	now(): string;
	createdAt?: string;
	remoteCheckedAt?: string;
}): Promise<PlanInputs> {
	const agentDirectory = getActiveAgentDirectory();
	const piDirectory = dirname(agentDirectory);
	options.reporter.update("PREPARING", "Reading configuration and baseline state");
	const [config, state] = await Promise.all([loadConfig(agentDirectory), loadState(agentDirectory)]);
	if (!config) throw new Error("Configuration is missing. Run /config-sync doctor.");
	if (!state) throw new Error("State is missing. Complete first synchronization setup.");
	options.reporter.update("FETCHING", "Fetching SHARED REPOSITORY");
	const fetched = await fetchSharedSnapshot({
		exec: options.pi.exec,
		agentDirectory,
		repository: config.repository,
		signal: options.reporter.signal,
	});
	if (fetched.status === "doctor") throw new Error(fetched.doctor.message);
	const remoteCheckedAt = options.remoteCheckedAt ?? options.now();
	let inventory: Readonly<InventorySet> | undefined;
	let manifest: Readonly<SharedManifest> | undefined;
	await withSharedSnapshotWorktree({
		exec: options.pi.exec,
		snapshot: fetched.snapshot,
		signal: options.reporter.signal,
		run: async (directory) => {
			manifest = await readSharedManifest(directory);
			options.reporter.update("PLANNING", "Inventorying THIS MACHINE and SHARED REPOSITORY");
			inventory = await buildInventorySet({
				machineRoot: piDirectory,
				sharedRoot: directory,
				baseline: state.baseline,
				managedPatterns: [...new Set([...config.policy.approvedScope, ...manifest.managedScope])],
				signal: options.reporter.signal,
			});
		},
	});
	if (!inventory || !manifest) throw new Error("Planning inventory is unavailable.");
	const allPaths = [
		...new Set([
			...Object.keys(inventory.machine.files),
			...Object.keys(inventory.shared.files),
			...Object.keys(inventory.baseline.files),
		]),
	];
	const scope = resolveScopePlan(allPaths, manifest.managedScope, config.policy);
	return {
		agentDirectory,
		piDirectory,
		config,
		manifest,
		state,
		snapshot: fetched.snapshot,
		inventory,
		machine: filterInventory(inventory.machine, scope.effectivePaths),
		shared: filterInventory(inventory.shared, scope.effectivePaths),
		baseline: filterInventory(inventory.baseline, scope.effectivePaths),
		effectivePaths: scope.effectivePaths,
		scopeExpansion: scope.expansion,
		createdAt: options.createdAt ?? options.now(),
		remoteCheckedAt,
	};
}

function buildPreparedSync(inputs: PlanInputs, mode: SyncMode, decisions: readonly PlanDecision[]): PreparedSync {
	const filePlan = createSyncPlan({ mode, machine: inputs.machine, shared: inputs.shared, baseline: inputs.baseline });
	const finalMachineTree = mutableTree(filePlan.finalMachineTree);
	const finalSharedTree = mutableTree(filePlan.finalSharedTree);
	const resolvedActions = resolveConflicts({
		actions: filePlan.actions,
		decisions,
		machineTree: inputs.machine.files,
		sharedTree: inputs.shared.files,
		finalMachineTree,
		finalSharedTree,
	});
	let plannedSettingsText: string | undefined;
	let packageFingerprint = stableHash([]);
	const packageActions: PlanArtifactAction[] = [];
	const settingsAction = resolvedActions.find(
		(action) => action.path === "agent/settings.json" && action.direction === "shared-to-machine",
	);
	if (settingsAction && inputs.shared.files["agent/settings.json"]) {
		const machineText = exactText(inputs.machine.files["agent/settings.json"]);
		const sharedText = exactText(inputs.shared.files["agent/settings.json"]);
		const machineSettings = parseSettings(machineText, { source: "machine", policy: inputs.config.policy });
		const sharedSettings = parseSettings(sharedText, { source: "shared", policy: inputs.config.policy });
		const rawPackagePlan = planPackageChanges(machineSettings.packages, sharedSettings.packages);
		const rawPackageActions = rawPackagePlan.actions.map(packageArtifactAction);
		const packageDecisions = rawPackageActions.map((action, index) => {
			const selected = decisions.find(
				(decision) => decision.category === "package" && decision.id === packageActionDecisionId(action),
			);
			return {
				operation: rawPackagePlan.actions[index].operation,
				exactSource: rawPackagePlan.actions[index].exactSource,
				previousExactSource: rawPackagePlan.actions[index].previousExactSource,
				approved: selected?.choice === "approve" || selected?.choice === "approve_and_remember" || !selected,
			};
		});
		const settingsPlan = createApplySettingsPlan({
			machineText,
			sharedText,
			policy: inputs.config.policy,
			packageDecisions,
		});
		plannedSettingsText = settingsPlan.finalSettingsText;
		const finalSettingsFile = createInventoryFile("agent/settings.json", Buffer.from(plannedSettingsText));
		finalMachineTree["agent/settings.json"] = finalSettingsFile;
		packageActions.push(...rawPackageActions);
		packageFingerprint = packageSetFingerprint(
			parseSettings(plannedSettingsText, { source: "machine", policy: inputs.config.policy }).packages,
		);
	}
	const fileActions = resolvedActions.map((action) =>
		fileArtifactAction(action, inputs.machine.files, inputs.shared.files, finalMachineTree, finalSharedTree),
	);
	const settingsArtifactAction = fileActions.find(
		(action) => action.path === "agent/settings.json" && action.direction === "shared-to-machine",
	);
	if (settingsArtifactAction && plannedSettingsText) {
		settingsArtifactAction.resultSha256 = finalMachineTree["agent/settings.json"]?.sha256 ?? null;
		settingsArtifactAction.finalResult =
			"agent/settings.json on THIS MACHINE will match the reviewed preserved result.";
	}
	if (!plannedSettingsText) {
		const finalSettings = finalMachineTree["agent/settings.json"];
		if (finalSettings) {
			packageFingerprint = packageSetFingerprint(
				parseSettings(exactText(finalSettings), { source: "machine", policy: inputs.config.policy }).packages,
			);
		}
	}
	if (inputs.scopeExpansion.length > 0) {
		fileActions.push({
			action: "UPDATE BASELINE ONLY",
			codeExecution: false,
			destination: "BASELINE",
			direction: "baseline-only",
			finalResult: "The shared scope expansion will apply only to a later plan.",
			path: "managed scope policy",
			reason: "SHARED REPOSITORY requested paths outside the accepted scope.",
			resultSha256: null,
			risk: "policy",
			sourceSha256: null,
		});
	}
	const actions = [...fileActions, ...packageActions];
	const blockers = [
		...(inputs.scopeExpansion.length > 0 ? ["A shared scope expansion requires a separate policy plan."] : []),
		...blockersFor(mode, resolvedActions),
	];
	const plan = buildPlanArtifact({
		actions,
		baselineCommit: inputs.state.baseline?.commit ?? null,
		createdAt: inputs.createdAt,
		decisions,
		effectivePaths: inputs.effectivePaths,
		finalMachineTree,
		finalSharedTree,
		machineFingerprint: fileTreeHash(inputs.machine.files),
		mode,
		noOpEffects: [],
		packageFingerprint,
		policyFingerprint: stableHash({ bitwarden: inputs.manifest.bitwarden, local: inputs.config.policy }),
		prohibitedEffects: [
			{
				code: "NO_UNREVIEWED_PATHS",
				description: "No path outside the reviewed plan will change.",
				destination: "NONE",
			},
		],
		remoteCheckedAt: inputs.remoteCheckedAt,
		sharedCommit: inputs.snapshot.sharedCommit,
		sharedFingerprint: fileTreeHash(inputs.shared.files),
		scopeExpansion: inputs.scopeExpansion.length > 0 ? inputs.scopeExpansion : null,
	});
	return {
		agentDirectory: inputs.agentDirectory,
		piDirectory: inputs.piDirectory,
		manifest: inputs.manifest,
		blocked: blockers.length > 0,
		blockers: Object.freeze(blockers),
		config: inputs.config,
		state: inputs.state,
		snapshot: inputs.snapshot,
		machineTree: inputs.machine.files,
		sharedTree: inputs.shared.files,
		finalMachineTree: Object.freeze(finalMachineTree),
		finalSharedTree: Object.freeze(finalSharedTree),
		plannedSettingsText,
		plan,
	};
}

function materializePlanTree(
	expected: Readonly<Record<string, Readonly<FileFingerprint>>>,
	candidates: readonly Readonly<Record<string, Readonly<InventoryFile>>>[],
): Readonly<Record<string, Readonly<InventoryFile>>> {
	const files: Record<string, Readonly<InventoryFile>> = {};
	for (const [path, fingerprint] of Object.entries(expected)) {
		const file = candidates
			.map((tree) => tree[path])
			.find(
				(candidate) => candidate && sameExactFile(candidate, fingerprint) && sameContentFile(candidate, fingerprint),
			);
		if (!file || file.exactBytesBase64 === undefined) {
			throw new Error(`Cannot recover exact planned content for ${path}.`);
		}
		files[path] = file;
	}
	return Object.freeze(files);
}

function prepareResumeSync(current: Readonly<PreparedSync>, plan: Readonly<PlanArtifact>): PreparedSync {
	const candidates = [current.machineTree, current.sharedTree, current.finalMachineTree, current.finalSharedTree];
	const finalMachineTree = materializePlanTree(plan.finalMachineTree, candidates);
	const finalSharedTree = materializePlanTree(plan.finalSharedTree, candidates);
	const hasPackages = plan.actions.some((action) => action.risk === "package");
	const settingsFile = finalMachineTree["agent/settings.json"];
	if (hasPackages && (!settingsFile || settingsFile.exactBytesBase64 === undefined)) {
		throw new Error("Cannot recover exact planned agent/settings.json content.");
	}
	return {
		...current,
		blocked: false,
		blockers: Object.freeze([]),
		finalMachineTree,
		finalSharedTree,
		plannedSettingsText: hasPackages
			? Buffer.from(settingsFile?.exactBytesBase64 ?? "", "base64").toString("utf8")
			: current.plannedSettingsText,
		plan,
	};
}

function decisionRequirements(prepared: Readonly<PreparedSync>): DecisionRequirement[] {
	const requirements: DecisionRequirement[] = [];
	for (const action of prepared.plan.actions) {
		if (action.risk === "package") {
			requirements.push({
				category: "package",
				id: packageActionDecisionId(action),
				message: `${action.action}: ${action.path} from exact source ${action.exactPackageSource}`,
				choices: [
					{ id: "approve", label: "APPROVE THIS EXACT PACKAGE ACTION" },
					{ id: "approve_and_remember", label: "APPROVE AND REMEMBER THIS EXACT PACKAGE SOURCE" },
				],
				exactSource: action.exactPackageSource,
				normalizedSource: action.normalizedPackageSource,
				previousExactSource: action.previousExactPackageSource,
				previousNormalizedSource: action.previousNormalizedPackageSource,
			});
		} else if (action.risk === "deletion") {
			requirements.push({
				category: "deletion",
				id: planActionId(action),
				message: `${action.action}: ${action.path}`,
				choices: [{ id: "approve", label: "APPROVE THIS EXACT DELETION" }],
			});
		} else if (action.risk === "policy") {
			requirements.push({
				category: "policy",
				id: planActionId(action),
				message: action.finalResult,
				choices: [{ id: "approve", label: "APPROVE FOR THE NEXT PLAN" }],
			});
		}
	}
	return requirements;
}

function assertExecutionDecisions(prepared: Readonly<PreparedSync>): void {
	for (const requirement of decisionRequirements(prepared)) {
		const decision = prepared.plan.decisions.find(
			(candidate) => candidate.category === requirement.category && candidate.id === requirement.id,
		);
		if (!decision || !requirement.choices.some((choice) => choice.id === decision.choice)) {
			throw new Error(`The confirmed plan has no exact ${requirement.category} approval for ${requirement.id}.`);
		}
	}
}

export function deriveFooterStatus(plan: Readonly<PlanArtifact>): FooterStatusText {
	const conflicts = plan.actions.filter((action) => action.risk === "conflict").length;
	if (conflicts > 0) return `Config sync: ${conflicts} conflicts`;
	const publish = plan.actions.filter((action) => action.direction === "machine-to-shared").length;
	if (publish > 0) return `Config sync: ${publish} to publish`;
	const apply = plan.actions.filter((action) => action.direction === "shared-to-machine").length;
	return apply > 0 ? `Config sync: ${apply} to apply` : "Config sync: clean";
}

export function formatDifferenceOutput(difference: string): string {
	const truncated = truncateHead(difference, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return truncated.truncated
		? `${truncated.content}\n\n[Difference truncated. Run /config-sync diff with a narrower path.]`
		: truncated.content;
}

export function parseConfigSyncCommand(argumentsText: string): ParsedCommand {
	const parts = argumentsText.trim().split(/\s+/).filter(Boolean);
	const command = parts.shift() ?? "status";
	if (!CONFIG_SYNC_SUBCOMMANDS.includes(command as ParsedCommand["command"])) {
		throw new Error(`Unknown /config-sync action: ${command}`);
	}
	return { command: command as ParsedCommand["command"], arguments: parts };
}

function loadedResourcesChanged(plan: Readonly<PlanArtifact>): boolean {
	return plan.actions.some(
		(action) =>
			action.destination === "THIS MACHINE" && !action.codeExecution && LOADED_RESOURCE_PATTERN.test(action.path),
	);
}

async function shouldReload(ctx: ExtensionCommandContext, changed: boolean): Promise<boolean> {
	if (!changed || !ctx.hasUI) return false;
	return ctx.ui.confirm("Reload Pi resources?", "A completed APPLY changed loaded Pi resources. Reload now?");
}

function appendResult(pi: ExtensionAPI, data: Record<string, unknown>): void {
	pi.appendEntry("pi-sync/result", { schemaVersion: 1, ...data });
}

async function executePreparedSync(options: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	mode: SyncMode;
	decisions: readonly PlanDecision[];
	prepared: PreparedSync;
	authorization: Readonly<{ planId: string }>;
	reporter: ProgressReporter;
	deferPackageSettings?: boolean;
}): Promise<{ resourcesChanged: boolean }> {
	let current = options.prepared;
	let candidate: Awaited<ReturnType<typeof createCandidateCommit>> | undefined;
	let applySet: Readonly<MachineApplySet> | undefined;
	const rebuildCurrent = async (): Promise<PreparedSync> => {
		const inputs = await loadPlanInputs({
			pi: options.pi,
			mode: options.mode,
			reporter: options.reporter,
			now: () => new Date().toISOString(),
		});
		return buildPreparedSync(inputs, options.mode, options.decisions);
	};
	const ensureApplySet = (): Readonly<MachineApplySet> => {
		applySet ??= buildMachineApplySet({
			plan: options.prepared.plan,
			authorization: options.authorization,
			currentMachineTree: current.machineTree,
			committedFinalMachineTree: current.finalMachineTree,
			baseline: current.state.baseline,
			deferredPaths:
				options.deferPackageSettings !== false && current.plan.actions.some((action) => action.risk === "package")
					? ["agent/settings.json"]
					: [],
		});
		return applySet;
	};
	const steps: TransactionSteps = {
		fetchAndRebuildPlan: async () => {
			current = await rebuildCurrent();
			return current.plan;
		},
		createAndValidateCandidate: async ({ signal }) => {
			options.reporter.update("VALIDATING", "Validating the exact candidate commit");
			candidate = await createCandidateCommit({
				exec: options.pi.exec,
				snapshot: current.snapshot,
				planId: options.prepared.plan.planId,
				currentSharedTree: current.sharedTree,
				finalSharedTree: current.finalSharedTree,
				validation: {
					managedPatterns: current.plan.effectivePaths,
					machineSettings: {
						currentText: exactText(current.machineTree["agent/settings.json"]),
						finalText: exactText(current.finalMachineTree["agent/settings.json"]),
					},
					policy: current.config.policy,
				},
				signal,
			});
			return { candidateCommit: candidate.candidateCommit };
		},
		publishCandidate: async ({ signal }) => {
			if (!candidate) throw new Error("The exact candidate commit is unavailable.");
			options.reporter.update("PUBLISHING", "Publishing the exact candidate commit in SHARED REPOSITORY");
			const result = await publishCandidateCommit({ exec: options.pi.exec, candidate, signal });
			return result.status === "published"
				? result
				: { status: "plan_expired", currentSharedCommit: result.currentSharedCommit };
		},
		createAndVerifyBackup: async ({ signal }) => {
			options.reporter.update("BACKING UP", "Creating and verifying the THIS MACHINE backup");
			const backupId = `backup-${Date.now()}-${options.prepared.plan.shortPlanId}`;
			await createVerifiedMachineBackup({
				agentDirectory: current.agentDirectory,
				machineRoot: current.piDirectory,
				backupId,
				createdAt: new Date().toISOString(),
				applySet: ensureApplySet(),
				signal,
			});
			return { backupId };
		},
		applyMachineFiles: async ({ backupId, signal }) => {
			options.reporter.update("APPLYING FILES", "Applying confirmed files on THIS MACHINE");
			await applyMachineFilesFromBackup({
				agentDirectory: current.agentDirectory,
				machineRoot: current.piDirectory,
				backupId,
				applySet: ensureApplySet(),
				signal,
			});
		},
		applyPackages: async ({ signal }) => {
			if (!current.plannedSettingsText) throw new Error("The exact planned settings are unavailable.");
			options.reporter.update("APPLYING PACKAGES", "Executing exact approved package actions on THIS MACHINE");
			await executeConfirmedPackagePlan({
				exec: options.pi.exec,
				cwd: options.ctx.cwd,
				agentDirectory: current.agentDirectory,
				machineRoot: current.piDirectory,
				plan: options.prepared.plan,
				authorization: options.authorization,
				plannedSettingsText: current.plannedSettingsText,
				policy: current.config.policy,
				signal,
			});
		},
		verifyFinalMachine: async () => {
			options.reporter.update("VERIFYING", "Verifying the final THIS MACHINE tree");
			await verifyMachineApplySet({ machineRoot: current.piDirectory, applySet: ensureApplySet() });
		},
		restoreSecrets: async ({ signal }) => {
			options.reporter.update("RESTORING SECRETS", "Restoring agent secrets from Bitwarden");
			await restoreAgentSecrets({
				exec: options.pi.exec,
				manifest: current.manifest.bitwarden,
				piDirectory: current.piDirectory,
				signal,
			});
		},
		restoreMachine: async ({ backupId }) => {
			options.reporter.update("RECOVERING", "Restoring THIS MACHINE from the verified backup");
			try {
				await restoreVerifiedMachineBackup({
					agentDirectory: current.agentDirectory,
					machineRoot: current.piDirectory,
					backupId,
					expectedPlanId: options.prepared.plan.planId,
				});
				return { restored: true };
			} catch (error) {
				return {
					restored: false,
					manualRecoveryPaths:
						error instanceof Error && "manualRecoveryPaths" in error
							? (error.manualRecoveryPaths as readonly string[])
							: [],
				};
			}
		},
	};
	const result = await executeConfirmedTransaction({
		agentDirectory: options.prepared.agentDirectory,
		plan: options.prepared.plan,
		authorization: options.authorization,
		steps,
		signal: options.reporter.signal,
		onJournalStage: ({ stage }) => {
			if (stage === "candidate_created") options.reporter.update("VALIDATING", "Candidate commit recorded");
			else if (stage === "shared_published") options.reporter.update("BACKING UP", "Shared commit recorded");
			else if (stage === "backup_verified") options.reporter.update("APPLYING PACKAGES", "Verified backup recorded");
			else if (stage === "packages_applied") options.reporter.update("APPLYING FILES", "Package APPLY recorded");
			else if (stage === "machine_files_applied") options.reporter.update("VERIFYING", "File APPLY recorded");
			else if (stage === "final_verified") {
				options.reporter.update("RESTORING SECRETS", "Managed file verification recorded");
			}
		},
	});
	options.reporter.update("COMPLETE", "Configuration synchronization completed");
	appendResult(options.pi, {
		actionIds: result.receipt.completedActionIds,
		completedAt: new Date().toISOString(),
		kind: "receipt",
		mode: options.mode,
		planId: result.planId,
		publishedCommit: result.publishedCommit,
	});
	options.ctx.ui.notify(result.receipt.text, "info");
	return { resourcesChanged: loadedResourcesChanged(options.prepared.plan) };
}

async function runSyncCommand(options: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	mode: SyncMode;
	suppliedPlanId?: string;
}): Promise<boolean> {
	const resourcesChanged = await runWithProgress({
		ctx: options.ctx,
		operation: async (reporter): Promise<boolean> => {
			const agentDirectory = getActiveAgentDirectory();
			const persistedPlan = options.suppliedPlanId
				? await loadPlanArtifact(agentDirectory, options.suppliedPlanId)
				: undefined;
			if (options.suppliedPlanId && !persistedPlan) throw new Error("The exact stored plan is unavailable.");
			const inputs = await loadPlanInputs({
				pi: options.pi,
				mode: options.mode,
				reporter,
				now: () => new Date().toISOString(),
				createdAt: persistedPlan?.createdAt,
				remoteCheckedAt: persistedPlan?.remoteCheckedAt,
			});
			let fixedDecisions: PlanDecision[] = [...(persistedPlan?.decisions ?? [])];
			let preview = buildPreparedSync(inputs, options.mode, fixedDecisions);
			if (options.ctx.hasUI && !options.suppliedPlanId) {
				const conflicts = buildConflictSummaries({
					plan: preview.plan,
					machineTree: preview.machineTree,
					sharedTree: preview.sharedTree,
				});
				const selected = await collectConflictDecisions({ ctx: options.ctx, conflicts });
				if (conflicts.length > 0 && !selected) return false;
				fixedDecisions = (selected ?? []).map((decision) => ({ ...decision }));
				preview = buildPreparedSync(inputs, options.mode, fixedDecisions);
				if (selected?.some((decision) => decision.choice === "merge_workspace")) {
					const workspace = await createConflictMergeWorkspace({
						agentDirectory: inputs.agentDirectory,
						plan: preview.plan,
						decisions: selected,
						machineTree: preview.machineTree,
						sharedTree: preview.sharedTree,
					});
					options.ctx.ui.notify(`Separate merge workspace: ${workspace.path}. A new plan is required.`, "info");
				}
			}
			reporter.update("REVIEWING", "Reviewing the immutable synchronization plan");
			const requirements = decisionRequirements(preview);
			const review = options.suppliedPlanId
				? ({ status: "plan_only", plan: preview.plan, text: formatPlanText(preview.plan, "final-plan") } as const)
				: await reviewSyncPlan({
						ctx: options.ctx,
						previewPlan: preview.plan,
						decisionRequirements: requirements,
						rebuild: (collected: readonly Readonly<CollectedDecision>[]) =>
							buildPreparedSync(inputs, options.mode, [...fixedDecisions, ...(collected as readonly PlanDecision[])])
								.plan,
					});
			const decisions =
				review.status === "confirmed"
					? review.plan.decisions
					: review.status === "plan_only"
						? preview.plan.decisions
						: [];
			const prepared = buildPreparedSync(inputs, options.mode, decisions);
			await savePlanArtifact(inputs.agentDirectory, prepared.plan);
			if (prepared.blocked) {
				appendResult(options.pi, {
					blockers: prepared.blockers,
					kind: "blocked_plan",
					mode: options.mode,
					planId: prepared.plan.planId,
				});
				options.ctx.ui.notify(
					`${formatPlanText(prepared.plan, "final-plan")}\n${prepared.blockers.join("\n")}`,
					"warning",
				);
				return false;
			}
			let authorization: Readonly<{ planId: string }> | undefined;
			if (review.status === "confirmed") authorization = review.authorization;
			else if (review.status === "plan_only" && options.suppliedPlanId) {
				assertExecutionDecisions(prepared);
				authorization = authorizePlanExecution(prepared.plan, options.suppliedPlanId);
			}
			if (!authorization) {
				appendResult(options.pi, {
					kind: "plan_only",
					mode: options.mode,
					planId: prepared.plan.planId,
					remoteCheckedAt: prepared.plan.remoteCheckedAt,
				});
				if (options.ctx.hasUI && review.status !== "cancelled") {
					options.ctx.ui.notify(formatPlanText(prepared.plan, "final-plan"), "info");
				}
				return false;
			}
			const execution = await executePreparedSync({
				pi: options.pi,
				ctx: options.ctx,
				mode: options.mode,
				decisions,
				prepared,
				authorization,
				reporter,
			});
			return execution.resourcesChanged;
		},
	});
	return shouldReload(options.ctx, resourcesChanged);
}

async function runRestoreCommand(options: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	backupId?: string;
	suppliedPlanId?: string;
}): Promise<boolean> {
	const resourcesChanged = await runWithProgress({
		ctx: options.ctx,
		operation: async (reporter): Promise<boolean> => {
			const agentDirectory = getActiveAgentDirectory();
			const piDirectory = dirname(agentDirectory);
			let backupId = options.backupId;
			if (!backupId) {
				const backups = await listMachineBackups(agentDirectory);
				const validIds = backups.filter((backup) => backup.status === "valid").map((backup) => backup.backupId);
				if (!options.ctx.hasUI) {
					appendResult(options.pi, { backups, kind: "backup_list" });
					return false;
				}
				backupId = await options.ctx.ui.select("Select a verified THIS MACHINE backup", validIds);
				if (!backupId) return false;
			}
			reporter.update("RESTORING", "Building the immutable restore plan");
			const plan = await buildRestorePlan({
				agentDirectory,
				machineRoot: piDirectory,
				backupId,
				createdAt: new Date().toISOString(),
				signal: reporter.signal,
			});
			const review = await reviewRestorePlan({ ctx: options.ctx, plan });
			const authorization =
				review.status === "confirmed"
					? review.authorization
					: review.status === "plan_only" && options.suppliedPlanId
						? { planId: options.suppliedPlanId }
						: undefined;
			if (!authorization) {
				appendResult(options.pi, { backupId, kind: "restore_plan_only", planId: plan.planId });
				return false;
			}
			const result = await executeRestorePlan({
				agentDirectory,
				machineRoot: piDirectory,
				plan,
				authorization,
				signal: reporter.signal,
			});
			appendResult(options.pi, {
				backupId,
				completedAt: new Date().toISOString(),
				kind: "restore_receipt",
				planId: result.planId,
				restoredPathCount: result.restoredPaths.length,
			});
			options.ctx.ui.notify(result.receipt, "info");
			return plan.actions.some((action) => LOADED_RESOURCE_PATTERN.test(action.path));
		},
	});
	return shouldReload(options.ctx, resourcesChanged);
}

async function runDoctor(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const config = await loadConfig(getActiveAgentDirectory());
	if (!config) {
		ctx.ui.notify("Configuration is missing. THIS MACHINE and SHARED REPOSITORY were not changed.", "warning");
		appendResult(pi, { kind: "doctor", status: "configuration_missing" });
		return;
	}
	const inspected = await inspectSetupRepository({
		exec: pi.exec,
		agentDirectory: getActiveAgentDirectory(),
		repository: config.repository,
	});
	ctx.ui.notify(
		`${inspected.empty ? "SHARED REPOSITORY is empty." : "SHARED REPOSITORY manifest is valid."} ${inspected.privacyNotice}`,
		"info",
	);
	appendResult(pi, {
		empty: inspected.empty,
		kind: "doctor",
		sharedCommit: inspected.sharedCommit,
		status: "ready",
	});
}

async function runDiff(pi: ExtensionAPI, ctx: ExtensionCommandContext, path?: string): Promise<void> {
	await runWithProgress({
		ctx,
		operation: async (reporter) => {
			const inputs = await loadPlanInputs({ pi, mode: "reconcile", reporter, now: () => new Date().toISOString() });
			const prepared = buildPreparedSync(inputs, "reconcile", []);
			reporter.update("VALIDATING", "Creating an exact read-only difference candidate");
			const candidate = await createCandidateCommit({
				exec: pi.exec,
				snapshot: prepared.snapshot,
				planId: hash("sha256", `${prepared.plan.planId}:diff:${randomUUID()}`, "hex"),
				currentSharedTree: prepared.sharedTree,
				finalSharedTree: prepared.finalSharedTree,
				validation: { managedPatterns: prepared.plan.effectivePaths, policy: prepared.config.policy },
				signal: reporter.signal,
			});
			const result = await diffFromLastNamedSnapshot({
				exec: pi.exec,
				workspace: candidate.workspace,
				targetCommit: candidate.candidateCommit,
				path,
				signal: reporter.signal,
			});
			appendResult(pi, {
				baseCommit: result.baseCommit,
				differenceBytes: Buffer.byteLength(result.diff),
				kind: "difference",
				path,
			});
			ctx.ui.notify(result.diff ? formatDifferenceOutput(result.diff) : "No reviewed difference.", "info");
		},
	});
}

async function runResumeCommand(options: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	recovery: Readonly<IncompleteJournal>;
}): Promise<boolean> {
	const resourcesChanged = await runWithProgress({
		ctx: options.ctx,
		operation: async (reporter): Promise<boolean> => {
			const agentDirectory = getActiveAgentDirectory();
			const plan = await loadPlanArtifact(agentDirectory, options.recovery.planId);
			if (!plan) throw new Error("The recorded recovery plan is unavailable.");
			const inputs = await loadPlanInputs({
				pi: options.pi,
				mode: plan.mode,
				reporter,
				now: () => new Date().toISOString(),
				createdAt: plan.createdAt,
				remoteCheckedAt: plan.remoteCheckedAt,
			});
			if (options.recovery.publishedCommit && inputs.snapshot.sharedCommit !== options.recovery.publishedCommit) {
				throw new Error("PLAN EXPIRED: SHARED REPOSITORY changed after the interrupted operation.");
			}
			const current = buildPreparedSync(inputs, plan.mode, plan.decisions);
			const prepared = prepareResumeSync(current, plan);
			reporter.update("RECOVERING", `Resuming plan ${plan.shortPlanId} from ${options.recovery.stage}`);
			const execution = await executePreparedSync({
				pi: options.pi,
				ctx: options.ctx,
				mode: plan.mode,
				decisions: plan.decisions,
				prepared,
				authorization: authorizePlanExecution(plan, plan.planId),
				reporter,
				deferPackageSettings: options.recovery.stage === "backup_verified",
			});
			return execution.resourcesChanged;
		},
	});
	return shouldReload(options.ctx, resourcesChanged);
}

async function runRecovery(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const recovery = await detectIncompleteJournal(getActiveAgentDirectory());
	const result = await requestRecoveryDecision({ ctx, recovery });
	if (result.status !== "selected") {
		if (recovery) appendResult(pi, { kind: "recovery_required", planId: recovery.planId, stage: recovery.stage });
		return false;
	}
	if (result.choice === "stop") {
		ctx.ui.notify("STOP WITHOUT CHANGES selected. No recovery ran automatically.", "info");
		return false;
	}
	if (result.choice === "rollback_machine") {
		if (!result.recovery.backupId) throw new Error("The recorded operation has no verified backup to restore.");
		return runRestoreCommand({ pi, ctx, backupId: result.recovery.backupId });
	}
	return runResumeCommand({ pi, ctx, recovery: result.recovery });
}

async function updateFooterStatus(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	isCurrent(): boolean;
}): Promise<FooterStatus> {
	const recovery = await detectIncompleteJournal(getActiveAgentDirectory());
	if (recovery) {
		const status: FooterStatus = { freshness: "fresh", text: "Config sync: recovery required" };
		if (options.isCurrent()) options.ctx.ui.setStatus("config-sync", status.text);
		return status;
	}
	try {
		const controller = new AbortController();
		const reporter: ProgressReporter = { signal: controller.signal, update: () => {} };
		const inputs = await loadPlanInputs({
			pi: options.pi,
			mode: "reconcile",
			reporter,
			now: () => new Date().toISOString(),
		});
		const prepared = buildPreparedSync(inputs, "reconcile", []);
		const status: FooterStatus = {
			freshness: "fresh",
			remoteCheckedAt: prepared.plan.remoteCheckedAt,
			text: deriveFooterStatus(prepared.plan),
		};
		if (options.isCurrent()) options.ctx.ui.setStatus("config-sync", status.text);
		return status;
	} catch {
		const latestRecovery = await detectIncompleteJournal(getActiveAgentDirectory());
		const status: FooterStatus = latestRecovery
			? { freshness: "fresh", text: "Config sync: recovery required" }
			: { freshness: "unknown", text: "Config sync: remote status unknown" };
		if (options.isCurrent()) options.ctx.ui.setStatus("config-sync", status.text);
		return status;
	}
}

export function registerConfigSyncCommands(pi: ExtensionAPI): void {
	let statusGeneration = 0;
	pi.on("session_start", async (_event, ctx) => {
		const currentGeneration = ++statusGeneration;
		const recovery = await detectIncompleteJournal(getActiveAgentDirectory());
		if (recovery) ctx.ui.notify(formatRecoveryNotice(recovery), "warning");
		await updateFooterStatus({
			pi,
			ctx,
			isCurrent: () => statusGeneration === currentGeneration,
		});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		statusGeneration++;
		ctx.ui.setStatus("config-sync", undefined);
		ctx.ui.setStatus("config-sync-progress", undefined);
	});
	pi.registerCommand("config-sync", {
		description: "Synchronize configuration between THIS MACHINE and SHARED REPOSITORY",
		getArgumentCompletions: (prefix) =>
			CONFIG_SYNC_SUBCOMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
				value: command,
				label: command,
			})),
		handler: async (args, ctx) => {
			try {
				const requestedCommand = args.trim().split(/\s+/, 1)[0];
				if (requestedCommand !== "recover" && (await detectIncompleteJournal(getActiveAgentDirectory()))) {
					if (await runRecovery(pi, ctx)) {
						await ctx.reload();
						return;
					}
					return;
				}
				let parsed = parseConfigSyncCommand(args);
				if (args.trim() === "" && ctx.hasUI) {
					const selected = await ctx.ui.select("Configuration synchronization", [...CONFIG_SYNC_SUBCOMMANDS]);
					if (!selected) return;
					parsed = parseConfigSyncCommand(selected);
				}
				switch (parsed.command) {
					case "status": {
						const currentGeneration = ++statusGeneration;
						const status = await updateFooterStatus({
							pi,
							ctx,
							isCurrent: () => statusGeneration === currentGeneration,
						});
						ctx.ui.notify(
							`${status.text} | Freshness: ${status.freshness}${status.remoteCheckedAt ? ` | SHARED REPOSITORY checked at: ${status.remoteCheckedAt}` : ""}`,
							"info",
						);
						appendResult(pi, { kind: "status", ...status });
						return;
					}
					case "publish":
					case "apply":
					case "reconcile":
						if (await runSyncCommand({ pi, ctx, mode: parsed.command, suppliedPlanId: parsed.arguments[0] })) {
							await ctx.reload();
							return;
						}
						return;
					case "diff":
						await runDiff(pi, ctx, parsed.arguments.join(" ") || undefined);
						return;
					case "recover":
						if (await runRecovery(pi, ctx)) {
							await ctx.reload();
							return;
						}
						return;
					case "restore":
						if (
							await runRestoreCommand({
								pi,
								ctx,
								backupId: parsed.arguments[0],
								suppliedPlanId: parsed.arguments[1],
							})
						) {
							await ctx.reload();
							return;
						}
						return;
					case "doctor":
						await runDoctor(pi, ctx);
						return;
				}
			} catch (error) {
				const recovery = await detectIncompleteJournal(getActiveAgentDirectory());
				if (recovery) ctx.ui.setStatus("config-sync", "Config sync: recovery required");
				ctx.ui.notify(error instanceof Error ? error.message : "Configuration synchronization failed.", "error");
				appendResult(pi, {
					kind: "error",
					message: error instanceof Error ? error.message : "Configuration synchronization failed.",
				});
			}
		},
	});
}
