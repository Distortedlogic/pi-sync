import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("config-sync", {
		description: "Review synchronization between THIS MACHINE and SHARED REPOSITORY",
		handler: async (_args, ctx) => {
			ctx.ui.notify("No operation is available yet. THIS MACHINE and SHARED REPOSITORY were not changed.", "info");
		},
	});
}
