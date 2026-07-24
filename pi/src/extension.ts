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
}