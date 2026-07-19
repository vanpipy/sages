/**
 * Sages pi extension — the runtime entrypoint loaded by pi when it
 * resolves the @sages/pi-four-sages package.
 *
 * Architecture (per the AFT-migration design, 2026-07-19):
 *   ┌─ roles/    ─ 4 sage-role tool surfaces (Fuxi / QiaoChui / LuBan / GaoYao)
 *   │             registered through the named exports below.
 *   ├─ wrap/     ─ 9 sages_* semantic tools that talk to AFT via the
 *   │             aft/ details layer. Only wrap/ imports from aft/ —
 *   │             nothing else does.
 *   └─ aft/      ─ the only code that knows AFT's NDJSON-over-stdio
 *                  protocol and tool names. Treat as internal.
 *
 * This file is the single place that wires them all together for
 * pi's ExtensionAPI. It is intentionally tiny:
 *
 *   - call the 4 role registrars
 *   - call registerAllWrappers() from src/tools/wrap/index.ts
 *
 * If you add a new sages_* tool, add a registerSagesX() file under
 * src/tools/wrap/, register it in src/tools/wrap/index.ts's REGISTRARS
 * array — that's it. This file does not need to change.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerFuxiTools } from "./tools/fuxi-tools.js";
import { registerQiaoChuiTools } from "./tools/qiaochui/index.js";
import { registerLubanTools } from "./tools/luban/index.js";
import { registerGaoYaoTools } from "./tools/gaoyao-tools.js";
import { registerAllWrappers } from "./tools/wrap/index.js";
import { __shutdownBridge } from "./tools/aft/bridge.js";

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 *
 * Order matters: role tools register first so the LLM can immediately
 * see them. The sages_* wrappers are registered AFTER the roles so that
 * `getAllTools()` reports them in the same order users read SKILL.md.
 */
export default function registerSagesExtension(pi: ExtensionAPI): void {
	// ── 4 role surfaces ────────────────────────────────────────────
	registerFuxiTools(pi);
	registerQiaoChuiTools(pi);
	registerLubanTools(pi);
	registerGaoYaoTools(pi);

	// ── 9 sages_* semantic wrappers (talk to AFT through aft/) ─────
	registerAllWrappers(pi);

	// ── AFT daemon lifecycle ───────────────────────────────────────
	// Kill the singleton AFT daemon when the pi session ends. Without this
	// the daemon (one long-lived child process per session) keeps running
	// after pi exits, observable as `aft-linux-x64` lingering in `ps aux`.
	// pi's `session_shutdown` event fires for quit / reload / new / resume / fork.
	pi.on("session_shutdown", () => {
		__shutdownBridge();
	});
}