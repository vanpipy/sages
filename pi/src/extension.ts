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
 * Plus two main-agent gates (GC-2026-001 — brain-vs-limb hard threshold):
 *   - Layer 1 (session_start): drop raw `edit` / `write` from main agent's
 *     active toolset so it cannot bypass any write path. The LLM
 *     literally does not see those tools — only the 4 orchestrator
 *     tools (which write to `.pi/orchestrator/` only) and `Agent`
 *     (dispatch to subagents for any other write).
 *   - Layer 2 (tool_call): block bash commands whose write intent
 *     targets production code paths, via `canMainAgentWrite()` from
 *     `pi/src/tools/file-gate.ts`. The bash-guard is the ONLY remaining
 *     limb-side write enforcement — direct write tools are gone
 *     (2026-07-26 retirement of `sages_write`/`sages_edit`).
 *
 * Subagents (`developer`, `software-auditor`, `general-purpose`) are NOT
 * registered here — they are installed as user-level agents by
 * `pi/scripts/install.sh` and invoked via the Agent tool. See
 * `pi/templates/SUBAGENTS.md` for the 4-stage pipeline
 * (Explore → Plan → developer → software-auditor) and the
 * `general-purpose` fallback helper model.
 *
 * File operations (read/write/edit/grep/bash) are out of scope here —
 * they come from pi's built-ins (or, for AFT-backed versions, from
 * `@cortexkit/aft-pi`, installed separately by install.sh). The
 * main agent dispatches `Agent({subagent_type: "general-purpose"})`
 * (no isolation) for meta-file edits and
 * `Agent({subagent_type: "developer", isolation: {...}})` (managed
 * worktree) for production code.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerOrchestratorTools } from "./tools/orchestrator/index.js";
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

	// ── Layer 1: drop raw edit/write from main agent's active tools ───────
	// (brain-vs-limb: main agent has no raw write tool — only the 4
	//  orchestrator tools + Agent dispatch. As of 2026-07-26 the
	//  `sages_write`/`sages_edit` tools are retired too.)
	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		pi.setActiveTools(
			active.filter((t: string) => t !== "edit" && t !== "write"),
		);
	});

	// ── Layer 2: bash write-intent gate ────────────────────────────────────
	// (defense-in-depth: even if some extension re-enables edit/write, bash
	//  is gated by the same canMainAgentWrite() policy as the file-gate.
	//  This is the ONLY remaining limb-side write enforcement.)
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
