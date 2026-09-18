import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConfigSyncCommands } from "./commands.ts";

export default function (pi: ExtensionAPI): void {
	registerConfigSyncCommands(pi);
}
