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
 * Subagents (`software-developer`, `software-auditor`) are NOT registered
 * here — they are installed as user-level agents by `pi/scripts/install.sh`
 * and invoked via the Agent tool. See `pi/templates/SUBAGENTS.md` for the
 * 4-stage pipeline (Explore → Plan → software-developer → software-auditor).
 *
 * File operations (read/write/edit/grep/bash) are out of scope here —
 * they come from pi's built-ins (or, for AFT-backed versions, from
 * `@cortexkit/aft-pi`, installed separately by install.sh).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerOrchestratorTools } from "./tools/orchestrator/index.js";

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
}