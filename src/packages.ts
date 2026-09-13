import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import stableStringify from "json-stable-stringify";
import npa from "npm-package-arg";
import semver from "semver";
import type { LocalPolicy } from "./types.ts";

export type PackageOperation = "install" | "update" | "remove";
export type PackageActionName = "INSTALL PACKAGE ON THIS MACHINE" | "REMOVE PACKAGE FROM THIS MACHINE";

export interface PackageObjectDeclaration {
	source: string;
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export type PackageDeclaration = string | PackageObjectDeclaration;

export interface ParsedPackageDeclaration {
	declaration: PackageDeclaration;
	exactSource: string;
	normalizedSource: string;
	identity: string;
	scheme: string;
	pinned: boolean;
	machineOnly: boolean;
}

export interface PackageAction {
	action: PackageActionName;
	operation: PackageOperation;
	identity: string;
	exactSource: string;
	normalizedSource: string;
	previousExactSource?: string;
	previousNormalizedSource?: string;
	codeExecution: true;
	reason: string;
	finalResult: string;
}

export interface PackageDecision {
	operation: PackageOperation;
	exactSource: string;
	previousExactSource?: string;
	approved: boolean;
}

export interface DecidedPackageAction extends PackageAction {
	decision: "approved" | "rejected";
}

export interface PackagePlan {
	actions: readonly Readonly<PackageAction>[];
	finalDeclarations: readonly PackageDeclaration[];
	preservedMachineSources: readonly Readonly<Pick<ParsedPackageDeclaration, "exactSource" | "normalizedSource">>[];
}

export interface DecidedPackagePlan extends Omit<PackagePlan, "actions"> {
	actions: readonly Readonly<DecidedPackageAction>[];
	executionApproved: boolean;
	decisionFingerprint: string;
}

const PACKAGE_OBJECT_KEYS = new Set(["source", "autoload", "extensions", "skills", "prompts", "themes"]);
const FILTER_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
const GIT_COMMIT = /^[a-f0-9]{40,64}$/i;

export class PackagePlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackagePlanError";
	}
}

function freezeDeclaration(declaration: PackageDeclaration): PackageDeclaration {
	if (typeof declaration === "string") return declaration;
	const copy: PackageObjectDeclaration = { source: declaration.source };
	if (declaration.autoload !== undefined) copy.autoload = declaration.autoload;
	for (const key of FILTER_KEYS) {
		const values = declaration[key];
		if (values) copy[key] = Object.freeze([...values]) as string[];
	}
	return Object.freeze(copy);
}

function packageSource(declaration: unknown, index: number): { declaration: PackageDeclaration; source: string } {
	if (typeof declaration === "string") {
		if (declaration.length === 0 || declaration.trim() !== declaration) {
			throw new PackagePlanError(`Invalid package declaration at /packages/${index}.`);
		}
		return { declaration, source: declaration };
	}
	if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
		throw new PackagePlanError(`Invalid package declaration at /packages/${index}.`);
	}
	const value = declaration as Record<string, unknown>;
	if (Object.keys(value).some((key) => !PACKAGE_OBJECT_KEYS.has(key)) || typeof value.source !== "string") {
		throw new PackagePlanError(`Invalid package declaration at /packages/${index}.`);
	}
	if (value.source.length === 0 || value.source.trim() !== value.source) {
		throw new PackagePlanError(`Invalid package source at /packages/${index}/source.`);
	}
	if (value.autoload !== undefined && typeof value.autoload !== "boolean") {
		throw new PackagePlanError(`Invalid package autoload value at /packages/${index}/autoload.`);
	}
	const packageObject: PackageObjectDeclaration = { source: value.source };
	if (typeof value.autoload === "boolean") packageObject.autoload = value.autoload;
	for (const key of FILTER_KEYS) {
		const filter = value[key];
		if (filter !== undefined && (!Array.isArray(filter) || filter.some((entry) => typeof entry !== "string"))) {
			throw new PackagePlanError(`Invalid package filter at /packages/${index}/${key}.`);
		}
		if (Array.isArray(filter)) packageObject[key] = [...filter] as string[];
	}
	return { declaration: freezeDeclaration(packageObject), source: value.source };
}

function normalizeUrlBase(base: string): string {
	if (!base.includes("://")) return base.replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		throw new PackagePlanError("Invalid Git package source.");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new PackagePlanError("Git package sources cannot contain credentials, queries, or fragments.");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

function parseGitSource(
	source: string,
	scheme: string,
	body: string,
): Omit<ParsedPackageDeclaration, "declaration" | "machineOnly"> {
	const delimiter = body.lastIndexOf("@");
	const lastRepositorySeparator = Math.max(body.lastIndexOf("/"), body.lastIndexOf(":"));
	const hasRef = delimiter > lastRepositorySeparator;
	const base = normalizeUrlBase(hasRef ? body.slice(0, delimiter) : body);
	const ref = hasRef ? body.slice(delimiter + 1) : undefined;
	if (base.length === 0 || (hasRef && !ref)) throw new PackagePlanError("Invalid Git package source.");
	const pinned = ref !== undefined && (GIT_COMMIT.test(ref) || semver.valid(ref.replace(/^v/, "")) !== null);
	const normalizedBase = source.startsWith(`${scheme}://`) ? base : `${scheme}:${base}`;
	return {
		exactSource: source,
		normalizedSource: `${normalizedBase}${ref ? `@${ref}` : ""}`,
		identity: normalizedBase,
		scheme,
		pinned,
	};
}

function parseSource(source: string): Omit<ParsedPackageDeclaration, "declaration" | "machineOnly"> {
	if (source.startsWith("npm:")) {
		let result: ReturnType<typeof npa>;
		try {
			result = npa(source.slice(4));
		} catch {
			throw new PackagePlanError("Invalid npm package source.");
		}
		if (!result.name || !result.rawSpec) throw new PackagePlanError("Invalid npm package source.");
		const pinned = result.type === "version" && semver.valid(result.rawSpec) !== null;
		return {
			exactSource: source,
			normalizedSource: `npm:${result.name}@${result.rawSpec}`,
			identity: `npm:${result.name}`,
			scheme: "npm",
			pinned,
		};
	}
	if (source.startsWith("git:")) return parseGitSource(source, "git", source.slice(4));
	for (const scheme of ["https", "ssh"] as const) {
		if (source.startsWith(`${scheme}://`)) return parseGitSource(source, scheme, source);
	}
	if (source.startsWith("file:")) {
		const path = source.slice(5).replaceAll("\\", "/");
		if (!path) throw new PackagePlanError("Invalid file package source.");
		return {
			exactSource: source,
			normalizedSource: `file:${path}`,
			identity: `file:${path}`,
			scheme: "file",
			pinned: true,
		};
	}
	if (source.startsWith("./") || source.startsWith("../") || isAbsolute(source) || win32.isAbsolute(source)) {
		const path = source.replaceAll("\\", "/");
		return {
			exactSource: source,
			normalizedSource: `path:${path}`,
			identity: `path:${path}`,
			scheme: "path",
			pinned: true,
		};
	}
	throw new PackagePlanError("Package source scheme is not approved.");
}

export function parsePackageDeclarations(
	declarations: unknown,
	options: { source: "machine" | "shared"; policy: LocalPolicy },
): readonly Readonly<ParsedPackageDeclaration>[] {
	if (declarations === undefined) return Object.freeze([]);
	if (!Array.isArray(declarations)) throw new PackagePlanError("Settings /packages must be an array.");
	const parsed: Readonly<ParsedPackageDeclaration>[] = [];
	const identities = new Set<string>();
	for (const [index, declaration] of declarations.entries()) {
		const extracted = packageSource(declaration, index);
		const source = parseSource(extracted.source);
		const machineOnly =
			source.scheme === "file" ||
			source.scheme === "path" ||
			options.policy.machineOnlyPackageSources.includes(source.exactSource);
		if (options.source === "shared") {
			if (machineOnly || !options.policy.approvedSharedPackageSchemes.includes(source.scheme)) {
				throw new PackagePlanError(`Shared package source scheme is not approved at /packages/${index}.`);
			}
			if (options.policy.requirePinnedSharedPackages && !source.pinned) {
				throw new PackagePlanError(`Shared package source is not pinned at /packages/${index}.`);
			}
		}
		if (identities.has(source.identity)) {
			throw new PackagePlanError(`Duplicate package declaration at /packages/${index}.`);
		}
		identities.add(source.identity);
		parsed.push(Object.freeze({ ...source, declaration: freezeDeclaration(extracted.declaration), machineOnly }));
	}
	return Object.freeze(parsed);
}

function packageAction(
	operation: PackageOperation,
	current: Readonly<ParsedPackageDeclaration> | undefined,
	final: Readonly<ParsedPackageDeclaration> | undefined,
): Readonly<PackageAction> {
	const selected = final ?? current;
	if (!selected) throw new PackagePlanError("Package action has no source.");
	const exactSource = final?.exactSource ?? selected.exactSource;
	const normalizedSource = final?.normalizedSource ?? selected.normalizedSource;
	const action = operation === "remove" ? "REMOVE PACKAGE FROM THIS MACHINE" : "INSTALL PACKAGE ON THIS MACHINE";
	return Object.freeze({
		action,
		operation,
		identity: selected.identity,
		exactSource,
		normalizedSource,
		...(operation === "update"
			? { previousExactSource: current?.exactSource, previousNormalizedSource: current?.normalizedSource }
			: {}),
		codeExecution: true,
		reason:
			operation === "install"
				? "SHARED REPOSITORY requires this package on THIS MACHINE."
				: operation === "update"
					? "SHARED REPOSITORY requires a different exact package source on THIS MACHINE."
					: "SHARED REPOSITORY no longer declares this package for THIS MACHINE.",
		finalResult:
			operation === "remove"
				? "The package declaration will not remain on THIS MACHINE."
				: "THIS MACHINE will use the exact approved package source.",
	});
}

export function planPackageChanges(
	machine: readonly Readonly<ParsedPackageDeclaration>[],
	shared: readonly Readonly<ParsedPackageDeclaration>[],
): Readonly<PackagePlan> {
	const machineByIdentity = new Map(machine.map((entry) => [entry.identity, entry]));
	const finalByIdentity = new Map(shared.map((entry) => [entry.identity, entry]));
	const preservedMachineSources: Array<Readonly<Pick<ParsedPackageDeclaration, "exactSource" | "normalizedSource">>> =
		[];
	for (const entry of machine) {
		if (!entry.machineOnly) continue;
		finalByIdentity.set(entry.identity, entry);
		preservedMachineSources.push(
			Object.freeze({ exactSource: entry.exactSource, normalizedSource: entry.normalizedSource }),
		);
	}

	const actions: Readonly<PackageAction>[] = [];
	const identities = [...new Set([...machineByIdentity.keys(), ...finalByIdentity.keys()])].sort();
	for (const identity of identities) {
		const current = machineByIdentity.get(identity);
		const final = finalByIdentity.get(identity);
		if (!current && final) actions.push(packageAction("install", current, final));
		else if (current && !final) actions.push(packageAction("remove", current, final));
		else if (current && final && current.normalizedSource !== final.normalizedSource) {
			actions.push(packageAction("update", current, final));
		}
	}
	return Object.freeze({
		actions: Object.freeze(actions),
		finalDeclarations: Object.freeze(
			[...finalByIdentity.values()]
				.sort((left, right) => left.identity.localeCompare(right.identity))
				.map((entry) => entry.declaration),
		),
		preservedMachineSources: Object.freeze(
			preservedMachineSources.sort((left, right) => left.normalizedSource.localeCompare(right.normalizedSource)),
		),
	});
}

function decisionIdentity(
	decision: Pick<PackageDecision, "operation" | "exactSource" | "previousExactSource">,
): string {
	return (
		stableStringify({
			operation: decision.operation,
			exactSource: decision.exactSource,
			previousExactSource: decision.previousExactSource ?? null,
		}) ?? ""
	);
}

export function applyPackageDecisions(
	plan: Readonly<PackagePlan>,
	decisions: readonly Readonly<PackageDecision>[],
): Readonly<DecidedPackagePlan> {
	const decisionsByIdentity = new Map<string, Readonly<PackageDecision>>();
	for (const decision of decisions) {
		const identity = decisionIdentity(decision);
		if (decisionsByIdentity.has(identity)) throw new PackagePlanError("Duplicate package decision.");
		decisionsByIdentity.set(identity, decision);
	}
	const decidedActions = plan.actions.map((action) => {
		const identity = decisionIdentity(action);
		const decision = decisionsByIdentity.get(identity);
		if (!decision) throw new PackagePlanError(`Missing exact package decision for ${action.operation}.`);
		decisionsByIdentity.delete(identity);
		return Object.freeze({
			...action,
			decision: decision.approved ? "approved" : "rejected",
		}) as Readonly<DecidedPackageAction>;
	});
	if (decisionsByIdentity.size > 0)
		throw new PackagePlanError("Package decisions do not match the planned exact sources.");
	const serializedDecisions = stableStringify(
		decidedActions.map(({ operation, exactSource, previousExactSource, decision }) => ({
			operation,
			exactSource,
			previousExactSource: previousExactSource ?? null,
			decision,
		})),
	);
	if (serializedDecisions === undefined) throw new PackagePlanError("Cannot fingerprint package decisions.");
	return Object.freeze({
		actions: Object.freeze(decidedActions),
		finalDeclarations: plan.finalDeclarations,
		preservedMachineSources: plan.preservedMachineSources,
		executionApproved: decidedActions.every((action) => action.decision === "approved"),
		decisionFingerprint: createHash("sha256").update(serializedDecisions).digest("hex"),
	});
}
