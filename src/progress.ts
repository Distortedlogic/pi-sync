import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type ProgressPhase =
	| "PREPARING"
	| "FETCHING"
	| "PLANNING"
	| "REVIEWING"
	| "VALIDATING"
	| "PUBLISHING"
	| "BACKING UP"
	| "APPLYING FILES"
	| "APPLYING PACKAGES"
	| "VERIFYING"
	| "RESTORING SECRETS"
	| "RECOVERING"
	| "RESTORING"
	| "COMPLETE";

export interface ProgressReporter {
	readonly signal: AbortSignal;
	update(phase: ProgressPhase, activeOperation: string): void;
}

export async function runWithProgress<T>(options: {
	ctx: Pick<ExtensionCommandContext, "hasUI" | "mode" | "ui">;
	operation(reporter: ProgressReporter): Promise<T>;
}): Promise<T> {
	const controller = new AbortController();
	const reporter: ProgressReporter = {
		signal: controller.signal,
		update(phase, activeOperation) {
			if (options.ctx.hasUI) {
				options.ctx.ui.setStatus("config-sync-progress", `${phase}: ${activeOperation}`);
			}
		},
	};
	if (options.ctx.mode === "tui") {
		const outcome = await options.ctx.ui.custom<{ value?: T; error?: unknown }>((tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(tui, theme, "Configuration synchronization");
			loader.onAbort = () => controller.abort();
			void options
				.operation(reporter)
				.then((value) => done({ value }))
				.catch((error: unknown) => done({ error }));
			return loader;
		});
		options.ctx.ui.setStatus("config-sync-progress", undefined);
		if (outcome.error !== undefined) throw outcome.error;
		return outcome.value as T;
	}
	try {
		return await options.operation(reporter);
	} finally {
		if (options.ctx.hasUI) options.ctx.ui.setStatus("config-sync-progress", undefined);
	}
}
