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
	| "RECOVERING"
	| "RESTORING"
	| "COMPLETE";

export interface ProgressState {
	activeOperation: string;
	cancellationState: "running" | "stopping" | "complete";
	elapsedMs: number;
	phase: ProgressPhase | "STOPPING";
}

export interface ProgressReporter {
	readonly signal: AbortSignal;
	update(phase: ProgressPhase, activeOperation: string): void;
	stopping(activeOperation?: string): void;
	state(): Readonly<ProgressState>;
}

function createProgressReporter(options: {
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">;
	controller: AbortController;
	now(): number;
}): ProgressReporter {
	const startedAt = options.now();
	let current: ProgressState = {
		activeOperation: "Preparing configuration synchronization",
		cancellationState: "running",
		elapsedMs: 0,
		phase: "PREPARING",
	};
	const publish = () => {
		if (!options.ctx.hasUI) return;
		options.ctx.ui.setStatus(
			"config-sync-progress",
			`${current.phase}: ${current.activeOperation} | ${current.elapsedMs} ms`,
		);
	};
	publish();
	return {
		get signal() {
			return options.controller.signal;
		},
		update(phase, activeOperation) {
			if (current.cancellationState === "stopping") return;
			current = {
				activeOperation,
				cancellationState: phase === "COMPLETE" ? "complete" : "running",
				elapsedMs: Math.max(0, options.now() - startedAt),
				phase,
			};
			publish();
		},
		stopping(activeOperation = current.activeOperation) {
			if (current.cancellationState !== "running") return;
			current = {
				activeOperation,
				cancellationState: "stopping",
				elapsedMs: Math.max(0, options.now() - startedAt),
				phase: "STOPPING",
			};
			publish();
			options.controller.abort();
		},
		state() {
			return Object.freeze({ ...current });
		},
	};
}

export async function runWithProgress<T>(options: {
	ctx: Pick<ExtensionCommandContext, "hasUI" | "mode" | "ui">;
	operation(reporter: ProgressReporter): Promise<T>;
	now?: () => number;
}): Promise<T> {
	const now = options.now ?? Date.now;
	if (options.ctx.mode === "tui") {
		const outcome = await options.ctx.ui.custom<{ value?: T; error?: unknown }>((tui, theme, _keybindings, done) => {
			const loader = new BorderedLoader(tui, theme, "Configuration synchronization");
			const controller = new AbortController();
			const reporter = createProgressReporter({ ctx: options.ctx, controller, now });
			loader.onAbort = () => reporter.stopping();
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

	const controller = new AbortController();
	const reporter = createProgressReporter({ ctx: options.ctx, controller, now });
	try {
		return await options.operation(reporter);
	} finally {
		if (options.ctx.hasUI) options.ctx.ui.setStatus("config-sync-progress", undefined);
	}
}
