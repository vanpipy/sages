/**
 * Sages pi extension — the runtime entrypoint loaded by pi when it
 * resolves the @sages/pi package.
 *
 * Registers the orchestrator workflow tools (Stage 1-4 of multi-task
 * workflows):
 *   - goal_contract_create
 *   - dag_synthesize
 *   - task_dispatch
 *   - orchestrator_audit
 *
 * Plus the path-gated write tools (Sages meta-files only):
 *   - sages_write(path, content)
 *   - sages_edit(path, oldText, newText)
 *
 * Plus two main-agent gates (GC-2026-001 — brain-vs-limb hard threshold):
 *   - Layer 1 (session_start): drop raw `edit` / `write` from main agent's
 *     active toolset so it cannot bypass the file-gate. The LLM literally
 *     does not see those tools — only `sages_write` / `sages_edit` (which
 *     are already path-gated) and `Agent` (dispatch to subagents).
 *   - Layer 2 (tool_call): block bash commands whose write intent targets
 *     production code paths, via the same `canMainAgentWrite()` policy as
 *     the file-gate. Defense-in-depth — even if some extension re-enables
 *     `edit`/`write`, bash is gated.
 *
 * Subagents (`software-developer`, `software-auditor`) are NOT registered
 * here — they are installed as user-level agents by `pi/scripts/install.sh`
 * and invoked via the Agent tool. See `pi/templates/SUBAGENTS.md` for the
 * 4-stage pipeline (Explore → Plan → software-developer → software-auditor).
 *
 * File operations (read/write/edit/grep/bash) are out of scope here —
 * they come from pi's built-ins (or, for AFT-backed versions, from
 * `@cortexkit/aft-pi`, installed separately by install.sh). The
 * main agent is encouraged (via SYSTEM.md §1) to use `sages_edit` /
 * `sages_write` for meta-file changes and to dispatch a
 * `software-developer` subagent via the Agent tool for production code.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerOrchestratorTools } from "./tools/orchestrator/index.js";
import { registerFileGate } from "./tools/file-gate.js";
import { shouldBlockBashCommand } from "./tools/bash-guard.js";

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 *
 * The orchestrator tool surface replaces the legacy four-sage workflow
 * (Fuxi / QiaoChui / LuBan / GaoYao — those role tools were removed; see
 * `pi/skills/orchestrator/SKILL.md` for the DAG-based workflow that now
 * drives design → decompose → execute → audit).
 */
export default function registerSagesExtension(pi: ExtensionAPI): void {
	registerOrchestratorTools(pi);
	registerFileGate(pi);

	// ── Layer 1: drop raw edit/write from main agent's active tools ───────
	// (brain-vs-limb: main agent has no raw write tool — only sages_* +
	//  dispatch via Agent)
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		pi.setActiveTools(
			active.filter((t: string) => t !== "edit" && t !== "write"),
		);
	});

	// ── Layer 2: bash write-intent gate ────────────────────────────────────
	// (defense-in-depth: even if some extension re-enables edit/write, bash
	//  is gated by the same canMainAgentWrite() policy as the file-gate)
	pi.on("tool_call", (event: any, ctx: any) => {
		if (event.toolName !== "bash") return;
		const decision = shouldBlockBashCommand(event.input.command, {
			cwd: ctx.cwd,
		});
		if (decision.block) {
			return { block: true, reason: decision.reason };
		}
	});
}
