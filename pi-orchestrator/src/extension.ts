/**
 * @sages/pi-orchestrator — package entry point (default pi extension).
 *
 * Registers the 4-stage DAG orchestrator workflow tools, the
 * orchestrator advisory pipeline, and three session-level hooks that
 * used to live in the now-retired `@sages/pi` conductor:
 *
 *   1. `session_start`        — `pi.setActiveTools([...])` replaces the
 *                               historical `profile.tools` filter;
 *                               `pi.setStatus(...)` shows the
 *                               orchestrator is active.
 *   2. `before_agent_start`   — prepend `templates/SYSTEM.md` (the
 *                               orchestrator constitution) to the LLM's
 *                               system prompt.
 *   3. `tool_call`            — fire a once-per-session soft-mode
 *                               reminder on the first `bash` call,
 *                               nudging the agent toward the 4-stage DAG
 *                               workflow for non-trivial work.
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerGoalContractTool } from "./goal-contract.js";
import { registerDAGSynthesizerTool } from "./dag-synthesizer.js";
import { registerTaskDispatcherTool } from "./task-dispatcher.js";
import { registerOrchestratorAuditTool } from "./orchestrator-audit.js";
import { registerSagesReminderTool } from "./sages-reminder.js";
import { registerSubagentControlTools } from "./subagent-control.js";
import {
	installOrchestratorAdvisoryHandlers,
	type OrchestratorAdvisoryRuntimeDeps,
} from "./orchestrator-advisory.js";

/**
 * Tools always exposed to the main agent when the orchestrator
 * extension is loaded. Replaces the historical `profile.tools`
 * capability filter — the conductor previously blocked unlisted tools
 * via `pi.on("tool_call", { block: true })`, but the cleaner path is
 * to use `pi.setActiveTools(...)` so the LLM never sees disallowed
 * tool schemas in the first place.
 */
const ORCHESTRATOR_TOOLS: readonly string[] = [
	"goal_contract_create",
	"dag_synthesize",
	"task_dispatch",
	"orchestrator_audit",
	"sages_reminder",
];

/**
 * Subagent tools registered by `@sages/pi-subagents` in the same
 * session. They are not registered by the orchestrator itself, but the
 * orchestrator must opt them into the active toolset so the LLM can
 * see and call them.
 */
const SUBAGENT_TOOLS: readonly string[] = [
	"Agent",
	"get_subagent_result",
	"steer_subagent",
];

/**
 * Baseline file-system tools the main agent always needs regardless
 * of profile (the orchestrator itself uses some of these for read-only
 * lookups during verification).
 */
const BASELINE_TOOLS: readonly string[] = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/**
 * Soft-mode reminder text. Fires once per session on the first `bash`
 * tool call to nudge the LLM toward the 4-stage DAG workflow when the
 * active todowrite exceeds 2 items (the historical `dag_threshold`).
 * Lives here, not in a profile, because the recommendation is
 * intrinsic to orchestrator operation — there is no user-facing
 * toggle. Mirrors `templates/SYSTEM.md` § "Soft mode" so a drift
 * check (the soft-mode verifier) can pin both sides byte-identical.
 */
const SOFT_MODE_REMINDER = `> ⚙️ **SOFT MODE — subagent dispatch recommended**
>
> If this is part of a larger workflow (>2 items in your active todowrite,
> i.e. above the **task-count threshold**), consider dispatching via the
> 4-stage DAG workflow: goal → DAG → dispatch → audit. The developer /
> auditor / merger / git-expert pipeline is the recommended approach for
> complex multi-step work. For ≤2 tasks (below the task-count threshold),
> direct handling is acceptable. This is a recommendation — the agent decides.
> No commands are blocked.
`;

/**
 * Path to `templates/SYSTEM.md` — the orchestrator constitution that
 * gets prepended to the LLM's system prompt on every agent start.
 * Module-relative so it works from the repo checkout AND from the
 * installed package at `~/.pi/packages/pi-orchestrator/`.
 */
const SYSTEM_PROMPT_TEMPLATE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"templates",
	"SYSTEM.md",
);

/**
 * Register all orchestrator tools on the pi extension. Idempotent.
 *
 * The optional `runtime` parameter is kept for backward compatibility
 * with older call sites (the conductor used to pass its goal/dag
 * loaders through this hook). New callers can omit it; the advisory
 * handlers will fall back to no-op loaders that simply return `null`
 * for any goal/dag lookup.
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
	// GC-2026-073: programmatic LLM-facing tools for inspecting and
	// controlling subagents — subagent_status / steer / abort / resume.
	registerSubagentControlTools(pi);
	// GC-2026-053: orchestrator tool_call audit wiring (the post-tool
	// history-tracker, pre-tool blocker, tool_result error tracker, and
	// message_end assistant-text tracker).
	installOrchestratorAdvisoryHandlers(pi, runtime);
}

/**
 * Install the three session-level hooks that used to live in the
 * retired `@sages/pi` conductor (GC-2026-073):
 *
 *   1. `session_start`       — setActiveTools + setStatus
 *   2. `before_agent_start`  — prepend templates/SYSTEM.md overlay
 *   3. `tool_call`           — once-per-session soft-mode reminder
 *
 * Exported so tests can assert the wiring without running through the
 * default-export entrypoint.
 */
export function installSessionHooks(pi: ExtensionAPI): void {
	// 1. session_start — replace the profile.tools filter with a single
	//    setActiveTools call. `pi.setStatus(...)` is exposed on the
	//    optional `ui` channel (matches reference ExtensionAPI surface
	//    at @mariozechner/pi-coding-agent src/core/extensions/types.ts).
	pi.on("session_start", () => {
		const tools: string[] = [
			...ORCHESTRATOR_TOOLS,
			...SUBAGENT_TOOLS,
			...BASELINE_TOOLS,
		];
		pi.setActiveTools(tools);
		(pi as unknown as {
			setStatus?: (key: string, text: string) => void;
		}).setStatus?.("sages-orchestrator", "📜 orchestrator active");
	});

	// 2. before_agent_start — prepend the orchestrator constitution
	//    (templates/SYSTEM.md) to the LLM's system prompt. Idempotent
	//    across re-runs (file-read is cheap; the orchestrator only sees
	//    this event once per session).
	pi.on("before_agent_start", (event: any) => {
		if (!existsSync(SYSTEM_PROMPT_TEMPLATE)) return;
		const overlay = readFileSync(SYSTEM_PROMPT_TEMPLATE, "utf-8");
		event.systemPrompt = overlay + "\n\n---\n\n" + (event.systemPrompt ?? "");
	});

	// 3. tool_call — fire the soft-mode reminder once per session on the
	//    first bash call. The reminder is goal-orientation: it nudges
	//    back toward staying aligned with the agent's goal; it does
	//    NOT flag specific write actions as "production code".
	let reminderFired = false;
	pi.on("tool_call", (event: any) => {
		if (reminderFired) return undefined;
		if (event?.toolName !== "bash") return undefined;
		reminderFired = true;
		pi.appendEntry("system", SOFT_MODE_REMINDER);
		return undefined;
	});
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

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 * Registers the orchestrator's 5 tools + advisory pipeline + the three
 * session-level hooks described above.
 */
export default function registerOrchestratorExtension(pi: ExtensionAPI): void {
	registerOrchestratorTools(pi);
	installSessionHooks(pi);
}
