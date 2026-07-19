/**
 * Sages pi extension — the runtime entrypoint loaded by pi when it
 * resolves the @sages/pi-four-sages package.
 *
 * Registers the four sage role tool surfaces:
 *   - Fuxi:     fuxi_design
 *   - QiaoChui: qiaochui_review, qiaochui_decompose
 *   - LuBan:    luban_execute_task
 *   - GaoYao:   gaoyao_audit, gaoyao_observe, gaoyao_finalize
 *
 * File operations (read/write/edit/grep/bash) are out of scope here —
 * they come from pi's built-ins (or, for AFT-backed versions, from
 * `@cortexkit/aft-pi`, installed separately by install.sh).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerFuxiTools } from "./tools/fuxi-tools.js";
import { registerQiaoChuiTools } from "./tools/qiaochui/index.js";
import { registerLubanTools } from "./tools/luban/index.js";
import { registerGaoYaoTools } from "./tools/gaoyao-tools.js";

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 *
 * Order: the four role surfaces are registered in design → review →
 * execute → audit order so the LLM sees them in the same order the
 * workflow walks through.
 */
export default function registerSagesExtension(pi: ExtensionAPI): void {
	registerFuxiTools(pi);
	registerQiaoChuiTools(pi);
	registerLubanTools(pi);
	registerGaoYaoTools(pi);
}