/**
 * tools/index.ts — Public registration entry point for minimax tools.
 *
 * After the 2026-07-19 simplification, pi-minimax exposes only TWO tools:
 *   - minimax_auth_status  (L0 — check mmx auth state)
 *   - minimax_search_query  (L2 — web search)
 *
 * All other mmx modalities (text/image/video/speech/music/vision/quota/file)
 * are reached via the `mmx` binary directly, which the LLM learns from the
 * `mmx-cli` skill installed at ~/.pi/agent/skills/mmxc-cli/SKILL.md. The
 * pi-minimax SKILL.md (this extension's bundled skill) points to it.
 *
 * Called from extensions/minimax-extension.ts via registerMinimaxTools(pi).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAuthTool } from "./auth.js";
import { registerSearchTool } from "./search.js";

export function registerMinimaxTools(pi: ExtensionAPI): void {
    registerAuthTool(pi);
    registerSearchTool(pi);
}

export { registerAuthTool, registerSearchTool };
export { runAuthStatusTool } from "./auth.js";
export { runSearchQuery } from "./search.js";
