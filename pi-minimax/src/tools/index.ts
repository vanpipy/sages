/**
 * tools/index.ts — Public registration entry point for all minimax tools.
 *
 * Called from extensions/minimax-extension.ts via registerMinimaxTools(pi).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAuthTool } from "./auth.js";
import { registerExecTool } from "./exec.js";
import { registerSearchTool } from "./search.js";

export function registerMinimaxTools(pi: ExtensionAPI): void {
    registerAuthTool(pi);
    registerExecTool(pi);
    registerSearchTool(pi);
}

export { registerAuthTool, registerExecTool, registerSearchTool };
export { runAuthStatusTool } from "./auth.js";
export { runExecTool } from "./exec.js";
export { runSearchQuery } from "./search.js";
