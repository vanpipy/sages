/**
 * @sages/pi-orchestrator — package entry point.
 *
 * Registers the 4-stage DAG orchestrator workflow tools on the pi
 * extension API. The conductor (in `@sages/pi` → `src/extension.ts`)
 * gates these tools via `profile.tools`; this file unconditionally
 * registers all of them.
 *
 * Tool surface (4 + 1 reminder):
 *   - goal_contract_create — Stage 1 (turn intent into a verifiable contract)
 *   - dag_synthesize       — Stage 2 (decompose into a task DAG)
 *   - task_dispatch        — Stage 3 (build dispatch plan; LLM executes Agent calls)
 *   - orchestrator_audit   — Stage 4 (workflow-level audit rollup)
 *   - sages_reminder       — emit system reminder (one-shot)
 *
 * Brainstorming is registered separately as a slash command (see the
 * brainstorming skill in `skills/brainstorming/`).
 *
 * Peer dependencies:
 *   - @mariozechner/pi-coding-agent  — ExtensionAPI type
 *   - @sages/pi-subagents           — Agent / get_subagent_result / steer_subagent
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerGoalContractTool } from "./goal-contract.js";
import { registerDAGSynthesizerTool } from "./dag-synthesizer.js";
import { registerTaskDispatcherTool } from "./task-dispatcher.js";
import { registerOrchestratorAuditTool } from "./orchestrator-audit.js";
import { registerSagesReminderTool } from "./sages-reminder.js";
import {
	installOrchestratorAdvisoryHandlers,
	type OrchestratorAdvisoryRuntimeDeps,
} from "./orchestrator-advisory.js";

/**
 * Register all orchestrator tools on the pi extension. Idempotent.
 *
 * Pass `runtime` to provide the goal/dag loaders the orchestrator advisory
 * handler needs. The conductor in `@sages/pi` supplies these loaders; tests can
 * stub them.
 */
export function registerOrchestratorTools(
	pi: ExtensionAPI,
	runtime?: OrchestratorAdvisoryRuntimeDeps,
): void {
	registerGoalContractTool(pi);
	registerDAGSynthesizerTool(pi);
	registerTaskDispatcherTool(pi);
	registerOrchestratorAuditTool(pi);
	registerSagesReminderTool(pi);
	// GC-2026-053: orchestrator tool_call audit wiring (the post-tool
	// history-tracker, pre-tool blocker, tool_result error tracker, and
	// message_end assistant-text tracker). Pre-PR-2 these handlers lived
	// in the conductor; the smoke test in `test/smoke/gc-2026-053.test.ts`
	// expects them registered alongside the orchestrator tools.
	installOrchestratorAdvisoryHandlers(pi, runtime);
}

/**
 * Register the `/brainstorm` slash command. Called separately from
 * `registerOrchestratorTools` because the brainstorm flow is an
 * interactive state machine, not an LLM-callable tool.
 */
export function registerBrainstormCommand(pi: ExtensionAPI): void {
	// The brainstorm slash command is registered via the skill in
	// `skills/brainstorming/SKILL.md` — pi loads it as a slash
	// command from the skill metadata. No pi.registerCommand needed here.
}