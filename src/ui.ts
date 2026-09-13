import { DynamicBorder, type ExtensionCommandContext, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { PlanArtifact } from "./types.ts";

export const PLAN_SECTIONS = [
	"FINAL RESULT",
	"THIS MACHINE → SHARED REPOSITORY",
	"SHARED REPOSITORY → THIS MACHINE",
	"CODE EXECUTION",
	"DELETIONS",
	"CONFLICTS",
	"WILL NOT HAPPEN",
] as const;

export type PlanSection = (typeof PLAN_SECTIONS)[number];
export type PlanView = "final-plan" | "receipt";
export type DecisionCategory = PlanArtifact["decisions"][number]["category"];

export interface FormattedPlanRow {
	section: PlanSection;
	text: string;
	actionKey?: string;
}

export interface DecisionRequirement {
	category: DecisionCategory;
	id: string;
	message: string;
	choices: readonly { id: string; label: string }[];
	exactSource?: string;
	normalizedSource?: string;
}

export interface CollectedDecision {
	category: DecisionCategory;
	id: string;
	choice: string;
	exactSource?: string;
	normalizedSource?: string;
}

export interface PlanExecutionAuthorization {
	planId: string;
}

export type PlanReviewResult =
	| { status: "plan_only"; plan: Readonly<PlanArtifact>; text: string }
	| { status: "cancelled"; plan: Readonly<PlanArtifact> }
	| { status: "id_mismatch"; plan: Readonly<PlanArtifact> }
	| { status: "confirmed"; plan: Readonly<PlanArtifact>; authorization: Readonly<PlanExecutionAuthorization> };

function actionText(action: PlanArtifact["actions"][number]): string {
	return `${action.action}: ${action.path} | Destination: ${action.destination} | Result: ${action.finalResult}`;
}

function sectionRows(section: PlanSection, actions: readonly PlanArtifact["actions"][number][]): FormattedPlanRow[] {
	return actions.length > 0
		? actions.map((action) => ({
				section,
				text: actionText(action),
				actionKey: `${action.action}:${action.path}`,
			}))
		: [{ section, text: "(none)" }];
}

export function formatPlanRows(plan: Readonly<PlanArtifact>, view: PlanView): readonly Readonly<FormattedPlanRow>[] {
	const rows: FormattedPlanRow[] = [
		{
			section: "FINAL RESULT",
			text: `${view === "final-plan" ? "Final immutable plan" : "Completion receipt"} ${plan.planId} (${plan.shortPlanId})`,
		},
		{ section: "FINAL RESULT", text: `Mode: ${plan.mode.toUpperCase()}` },
		{ section: "FINAL RESULT", text: `SHARED REPOSITORY checked at: ${plan.remoteCheckedAt}` },
	];
	const finalResultActions = plan.actions.filter(
		(action) => action.direction === "baseline-only" || action.risk === "policy",
	);
	if (finalResultActions.length > 0) rows.push(...sectionRows("FINAL RESULT", finalResultActions));
	rows.push(
		...sectionRows(
			"THIS MACHINE → SHARED REPOSITORY",
			plan.actions.filter((action) => action.direction === "machine-to-shared" && !action.codeExecution),
		),
		...sectionRows(
			"SHARED REPOSITORY → THIS MACHINE",
			plan.actions.filter((action) => action.direction === "shared-to-machine" && !action.codeExecution),
		),
		...sectionRows(
			"CODE EXECUTION",
			plan.actions.filter((action) => action.codeExecution),
		),
		...sectionRows(
			"DELETIONS",
			plan.actions.filter((action) => action.risk === "deletion"),
		),
		...sectionRows(
			"CONFLICTS",
			plan.actions.filter((action) => action.risk === "conflict"),
		),
	);
	const effects = [...plan.prohibitedEffects, ...plan.noOpEffects];
	rows.push(
		...(effects.length > 0
			? effects.map((effect) => ({
					section: "WILL NOT HAPPEN" as const,
					text: `${effect.description} | Destination: ${effect.destination}${effect.path ? ` | Path: ${effect.path}` : ""}${effect.count !== undefined ? ` | Count: ${effect.count}` : ""}`,
				}))
			: [{ section: "WILL NOT HAPPEN" as const, text: "(none)" }]),
	);
	return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export function formatPlanText(plan: Readonly<PlanArtifact>, view: PlanView): string {
	const rows = formatPlanRows(plan, view);
	return PLAN_SECTIONS.map((section) => {
		const content = rows.filter((row) => row.section === section).map((row) => `- ${row.text}`);
		return `## ${section}\n${content.join("\n")}`;
	}).join("\n\n");
}

export function authorizePlanExecution(
	plan: Readonly<PlanArtifact>,
	suppliedPlanId: string,
): Readonly<PlanExecutionAuthorization> {
	if (suppliedPlanId !== plan.planId) throw new Error("Exact plan ID does not match the immutable plan.");
	return Object.freeze({ planId: plan.planId });
}

async function collectDecisions(
	ctx: ExtensionCommandContext,
	requirements: readonly DecisionRequirement[],
): Promise<readonly Readonly<CollectedDecision>[] | undefined> {
	const decisions: Readonly<CollectedDecision>[] = [];
	for (const requirement of requirements) {
		const labels = requirement.choices.map((choice) => choice.label);
		const selected = await ctx.ui.select(`${requirement.category.toUpperCase()}: ${requirement.message}`, labels);
		if (!selected) return undefined;
		const choice = requirement.choices.find((candidate) => candidate.label === selected);
		if (!choice) return undefined;
		decisions.push(
			Object.freeze({
				category: requirement.category,
				id: requirement.id,
				choice: choice.id,
				...(requirement.exactSource ? { exactSource: requirement.exactSource } : {}),
				...(requirement.normalizedSource ? { normalizedSource: requirement.normalizedSource } : {}),
			}),
		);
	}
	return Object.freeze(decisions);
}

function validateRebuiltDecisions(
	plan: Readonly<PlanArtifact>,
	decisions: readonly Readonly<CollectedDecision>[],
): void {
	for (const decision of decisions) {
		const present = plan.decisions.some(
			(candidate) =>
				candidate.category === decision.category &&
				candidate.id === decision.id &&
				candidate.choice === decision.choice,
		);
		if (!present) throw new Error(`Rebuilt plan does not contain decision ${decision.category}:${decision.id}.`);
	}
}

async function showTuiPlan(ctx: ExtensionCommandContext, text: string, planId: string): Promise<boolean> {
	const result = await ctx.ui.custom<"continue" | "cancel">((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
		container.addChild(new Text(text, 1, 0));
		const items: SelectItem[] = [
			{ value: "continue", label: `Enter exact plan ID ${planId}` },
			{ value: "cancel", label: "Cancel without changes" },
		];
		const list = new SelectList(items, 2, getSelectListTheme());
		list.onSelect = (item) => done(item.value === "continue" ? "continue" : "cancel");
		list.onCancel = () => done("cancel");
		container.addChild(list);
		container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return result === "continue";
}

async function showRpcPlan(ctx: ExtensionCommandContext, text: string): Promise<boolean> {
	const choice = await ctx.ui.select(text, ["Enter exact plan ID", "Cancel without changes"]);
	return choice === "Enter exact plan ID";
}

export async function reviewSyncPlan(options: {
	ctx: ExtensionCommandContext;
	previewPlan: Readonly<PlanArtifact>;
	decisionRequirements: readonly DecisionRequirement[];
	rebuild(decisions: readonly Readonly<CollectedDecision>[]): Readonly<PlanArtifact>;
}): Promise<PlanReviewResult> {
	if (!options.ctx.hasUI) {
		return { status: "plan_only", plan: options.previewPlan, text: formatPlanText(options.previewPlan, "final-plan") };
	}
	const decisions = await collectDecisions(options.ctx, options.decisionRequirements);
	if (!decisions) return { status: "cancelled", plan: options.previewPlan };
	const finalPlan = options.rebuild(decisions);
	validateRebuiltDecisions(finalPlan, decisions);
	const text = formatPlanText(finalPlan, "final-plan");
	const continueReview =
		options.ctx.mode === "tui"
			? await showTuiPlan(options.ctx, text, finalPlan.planId)
			: await showRpcPlan(options.ctx, text);
	if (!continueReview) return { status: "cancelled", plan: finalPlan };
	const suppliedPlanId = await options.ctx.ui.input("Enter exact plan ID", finalPlan.planId);
	if (suppliedPlanId !== finalPlan.planId) return { status: "id_mismatch", plan: finalPlan };
	return {
		status: "confirmed",
		plan: finalPlan,
		authorization: authorizePlanExecution(finalPlan, suppliedPlanId),
	};
}
