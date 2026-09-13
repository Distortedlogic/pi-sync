import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SetupRepositoryInspection } from "./git.ts";
import type { SyncMode } from "./plan.ts";
import type { PlanArtifact, SharedManifest } from "./types.ts";

export type FirstSyncMode = "publish" | "apply" | "reconcile";

export const FIRST_SYNC_MODE_OPTIONS = Object.freeze([
	{
		label: "PUBLISH THIS MACHINE into an empty SHARED REPOSITORY",
		mode: "publish" as const,
	},
	{
		label: "APPLY an existing SHARED REPOSITORY to THIS MACHINE",
		mode: "apply" as const,
	},
	{
		label: "RECONCILE existing content on THIS MACHINE and in SHARED REPOSITORY",
		mode: "reconcile" as const,
	},
]);

export type FirstSyncResult =
	| { status: "cancelled" }
	| {
			status: "planned";
			mode: FirstSyncMode;
			plan: Readonly<PlanArtifact>;
			privacyNotice: SetupRepositoryInspection["privacyNotice"];
	  };

export async function selectFirstSyncMode(
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
): Promise<FirstSyncMode | undefined> {
	if (!ctx.hasUI) return undefined;
	const selected = await ctx.ui.select(
		"Select one first synchronization mode",
		FIRST_SYNC_MODE_OPTIONS.map((option) => option.label),
	);
	return FIRST_SYNC_MODE_OPTIONS.find((option) => option.label === selected)?.mode;
}

function validateRepositoryMode(mode: FirstSyncMode, inspection: Readonly<SetupRepositoryInspection>): void {
	if (mode === "publish" && !inspection.empty) {
		throw new Error("PUBLISH first synchronization requires an empty SHARED REPOSITORY.");
	}
	if (mode !== "publish" && inspection.empty) {
		throw new Error(`${mode.toUpperCase()} first synchronization requires an existing SHARED REPOSITORY.`);
	}
	if (!inspection.empty && !inspection.manifest) {
		throw new Error("The non-empty SHARED REPOSITORY has no valid manifest.");
	}
}

function validateFirstSyncPlan(
	plan: Readonly<PlanArtifact>,
	mode: SyncMode,
	inspection: Readonly<SetupRepositoryInspection>,
): void {
	if (plan.mode !== mode || plan.baselineCommit !== null || plan.sharedCommit !== inspection.sharedCommit) {
		throw new Error("The first synchronization plan does not match the explicit setup inputs.");
	}
	if (
		plan.actions.some(
			(action) =>
				action.risk === "deletion" ||
				action.action === "DELETE FROM THIS MACHINE" ||
				action.action === "DELETE FROM SHARED REPOSITORY",
		)
	) {
		throw new Error("First synchronization cannot delete a file.");
	}
}

export async function prepareFirstSync(options: {
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">;
	mode?: FirstSyncMode;
	inspectRepository(options: {
		mode: FirstSyncMode;
		signal?: AbortSignal;
	}): Promise<Readonly<SetupRepositoryInspection>>;
	generatePlan(options: {
		mode: SyncMode;
		baseline: null;
		sharedCommit: string | null;
		manifest: Readonly<SharedManifest> | null;
		signal?: AbortSignal;
	}): Promise<Readonly<PlanArtifact>>;
	signal?: AbortSignal;
}): Promise<FirstSyncResult> {
	const mode = options.mode ?? (await selectFirstSyncMode(options.ctx));
	if (!mode) return { status: "cancelled" };
	options.signal?.throwIfAborted();
	const inspection = await options.inspectRepository({ mode, signal: options.signal });
	validateRepositoryMode(mode, inspection);
	options.signal?.throwIfAborted();
	const plan = await options.generatePlan({
		mode,
		baseline: null,
		sharedCommit: inspection.sharedCommit,
		manifest: inspection.manifest,
		signal: options.signal,
	});
	validateFirstSyncPlan(plan, mode, inspection);
	return {
		status: "planned",
		mode,
		plan,
		privacyNotice: inspection.privacyNotice,
	};
}
