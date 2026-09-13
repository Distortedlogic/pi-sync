import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	detectIncompleteJournal,
	formatRecoveryNotice,
	getActiveAgentDirectory,
	requestRecoveryDecision,
} from "./src/recovery.ts";

async function reportRecovery(ctx: ExtensionContext, offerChoices: boolean): Promise<boolean> {
	const recovery = await detectIncompleteJournal(getActiveAgentDirectory());
	if (!recovery) return false;
	ctx.ui.notify(formatRecoveryNotice(recovery), "warning");
	if (offerChoices) {
		const result = await requestRecoveryDecision({ ctx, recovery });
		if (result.status === "selected") {
			const choice =
				result.choice === "resume"
					? "RESUME"
					: result.choice === "rollback_machine"
						? "ROLL BACK THIS MACHINE"
						: "STOP WITHOUT CHANGES";
			ctx.ui.notify(`${choice} selected. No recovery ran automatically.`, "info");
		}
	}
	return true;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		await reportRecovery(ctx, false);
	});

	pi.registerCommand("config-sync", {
		description: "Review synchronization between THIS MACHINE and SHARED REPOSITORY",
		handler: async (_args, ctx) => {
			if (await reportRecovery(ctx, true)) return;
			ctx.ui.notify("No operation is available yet. THIS MACHINE and SHARED REPOSITORY were not changed.", "info");
		},
	});
}
