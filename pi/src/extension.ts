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
 * Soft mode (GC-2026-031) replaces the historical two-layer hard gate
 * (Layer 1: positive capability allowlist; Layer 2: bash write-intent
 * gate) with a session-scoped recommendation system:
 *
 *   - The main agent has full tool access (`edit`, `write`, `aft_edit`,
 *     `apply_patch`, unrestricted `bash`). Nothing is stripped from
 *     the active toolset on session_start, and no bash command is
 *     blocked at the `tool_call` layer.
 *
 *   - Subagent dispatch via the 4-stage DAG workflow (goal → DAG →
 *     dispatch → audit) is RECOMMENDED for workflows with >2 items
 *     in the agent's active todowrite. The agent decides whether to
 *     dispatch; no command is blocked.
 *
 *   - Drift from the recommended pattern is auto-steered via a
 *     `pi.appendEntry("system", SOFT_MODE_REMINDER)` once per session
 *     (fired on the first write-intent bash command). The reminder
 *     is goal-orientation — it does NOT mention "you wrote production
 *     code" (per the user's directive). Drift is never blocked.
 *
 *   - The `before_agent_start` listener appends `SOFT_MODE_SYSTEM_PROMPT_SUFFIX`
 *     to the system prompt so the LLM knows the soft-mode policy from
 *     the first turn.
 *
 * Subagent dispatch and lifecycle are owned by `@tintinweb/pi-subagents`
 * (installed separately). The canonical built-in agents are
 * `developer`, `auditor`, `Explore`, `Plan`. The `git-expert` agent
 * is the default cross-workspace git inspection helper.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerOrchestratorTools } from "./tools/orchestrator/index.js";
import { classifyBashCommand } from "./tools/bash-guard.js";
import { SOFT_MODE_REMINDER, SOFT_MODE_SYSTEM_PROMPT_SUFFIX } from "./soft-mode.js";

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 */
export default function registerSagesExtension(pi: ExtensionAPI): void {
	registerOrchestratorTools(pi);

	// ── Session-scoped state ──────────────────────────────────────────
	// Mutable closure: each event handler reads / mutates the same state.
	// pi's extension API is single-threaded (events fire serially), so no
	// lock is needed. The state is reset on every session_start.
	//
	// Under soft mode the only session-scoped flag is the auto-steer
	// throttle: the SOFT_MODE_REMINDER is appended at most once per
	// session to avoid spamming the LLM with duplicate reminders.
	let remindedThisSession = false;

	// ── Session start: reset auto-steer throttle ─────────────────────
	// Soft mode does not touch the active toolset (Layer 1 is gone).
	// The session_start handler only resets the reminder flag so the
	// first write-intent bash command in a new session emits the
	// reminder once. Previous-session state is otherwise irrelevant.
	pi.on("session_start", () => {
		remindedThisSession = false;
	});

	// ── Bash tool_call handler — soft mode ────────────────────────────
	// Soft mode: NEVER block. The handler still classifies each command
	// so it can fire the once-per-session auto-steer reminder on the
	// first write-intent bash call. The reminder is goal-orientation,
	// not "you wrote production code" feedback.
	pi.on("tool_call", (event: any, ctx: any) => {
		if (event.toolName !== "bash") return;
		const command: string = event?.input?.command;
		if (typeof command !== "string" || command.length === 0) return;

		const classification = classifyBashCommand(command);
		if (classification === "write-intent" && !remindedThisSession) {
			remindedThisSession = true;
			pi.appendEntry("system", SOFT_MODE_REMINDER);
		}
		return undefined;
	});

	// ── before_agent_start: surface soft-mode policy in the system prompt ─
	// Every turn, prepend SOFT_MODE_SYSTEM_PROMPT_SUFFIX to the system
	// prompt so the LLM knows the soft-mode policy from the first turn.
	// The suffix describes the recommendation thresholds, the available
	// subagents, and the auto-steer behavior.
	pi.on("before_agent_start", (event: any) => {
		const base: string = event?.systemPrompt ?? "";
		return {
			systemPrompt: `${base}${base ? "\n\n" : ""}${SOFT_MODE_SYSTEM_PROMPT_SUFFIX}`,
		};
	});
}
