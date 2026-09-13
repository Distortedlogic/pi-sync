import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConfigSyncCommands } from "./src/commands.ts";

export default function (pi: ExtensionAPI): void {
	registerConfigSyncCommands(pi);
}
