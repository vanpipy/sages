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
import { registerTodowriteTools } from "./todowrite.js";
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
export const ORCHESTRATOR_TOOLS: readonly string[] = [
	"goal_contract_create",
	"dag_synthesize",
	"task_dispatch",
	"orchestrator_audit",
	"sages_reminder",
];

/**
 * Tools registered by `@sages/pi-subagents` (`pi-subagents/src/index.ts`
 * lines 1154, 2040, 2138). `pi-subagents` owns the dispatch surface:
 * spawn an agent (`Agent`), poll its result (`get_subagent_result`),
 * inject a message into a running session (`steer_subagent`).
 *
 * Split out from `SUBAGENT_TOOLS` so the ownership boundary is
 * visible at the type level — anything in this array is added by
 * pi-subagents, anything in `SUBAGENT_CONTROL_TOOLS` is added by
 * the orchestrator. Both arrays are concatenated into `SUBAGENT_TOOLS`
 * for the active toolset.
 */
export const PI_SUBAGENT_TOOLS = [
	"Agent",
	"get_subagent_result",
	"steer_subagent",
] as const;

/**
 * Tools registered by the orchestrator's own `registerSubagentControlTools`
 * (GC-2026-073) and exposed to the orchestrator LLM via
 * `pi.setActiveTools`. These delegate to the same `AgentManager`
 * singleton via the shared globalThis registry key
 * `Symbol.for("pi-subagents:manager")` — there is exactly one manager,
 * shared end-to-end with the `Agent` tool.
 *
 * Surfaced during the orchestrator↔subagents seam audit: the
 * orchestrator forces developer / auditor to background (per the
 * `Agent` tool description), so the LLM needs schema-level access to
 * status / steer / abort / resume to manage its own background
 * dispatches. Hidden-by-default was an incident-response gap.
 */
export const SUBAGENT_CONTROL_TOOLS = [
	"subagent_status",
	"subagent_steer",
	"subagent_abort",
	"subagent_resume",
] as const;

/**
 * Combined subagent toolset passed to `pi.setActiveTools` at
 * `session_start`. Concatenation is the contract — `setActiveTools`
 * is order-agnostic.
 */
export const SUBAGENT_TOOLS: readonly string[] = [
	...PI_SUBAGENT_TOOLS,
	...SUBAGENT_CONTROL_TOOLS,
];

/**
 * Baseline file-system tools the main agent always needs regardless
 * of profile (the orchestrator itself uses some of these for read-only
 * lookups during verification).
 */
export const BASELINE_TOOLS: readonly string[] = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/**
 * Todowrite tools exposed by the orchestrator + pi-magic-context extensions.
 *
 * `todowrite` is registered by `@cortexkit/pi-magic-context` at extension
 * boot (default enabled). `todowrite_compile` + `todowrite_progress` are
 * registered by the orchestrator's `registerTodowriteTools(pi)` (GC-2026-074).
 *
 * The orchestrator's constitution (templates/SYSTEM.md § "Soft mode",
 * § "Tool Reference") repeatedly directs the LLM to use these tools for
 * tracking multi-step work and reconciling DAG↔todo drift. Without this
 * allowlist, `setActiveTools` hides the schemas from the LLM even when
 * registered — empirically surfaced during GC-2026-076 (8-SC / 2-task
 * DAG ran end-to-end with zero todowrite activity).
 *
 * GC-2026-081: expose all three to the main-agent active toolset.
 */
export const TODOWRITE_TOOLS: readonly string[] = [
	"todowrite",
	"todowrite_compile",
	"todowrite_progress",
];

/**
 * AFT (Agentic File Tools) suite registered by `@cortexkit/aft-pi` at
 * extension boot. Eleven tools: structural code-search (`aft_search`),
 * outline / file-tree (`aft_outline`), symbol-level read (`aft_zoom`),
 * code-health diagnostics (`aft_inspect`), call-graph traversal
 * (`aft_callgraph`), conflict detection (`aft_conflicts`), safe
 * deletion / move / import-update (`aft_delete` / `aft_move` /
 * `aft_import`), refactor primitives (`aft_refactor`), and safety /
 * blast-radius (`aft_safety`).
 *
 * The orchestrator's constitution (DEVELOPER_PROMPT tool-preference
 * ladder, AGENTS.md § "Tool preference order") repeatedly directs the
 * LLM to use AFT BEFORE bash `grep` / `rg` / `find` / `cat` — yet
 * prior to GC-2026-086 these tools were registered by the extension
 * but hidden from the LLM by `setActiveTools`. Empirically surfaced
 * during the GC-2026-086 live test round 2:
 * `aft_search` returned "Tool aft_search not found".
 *
 * GC-2026-086: expose all eleven to the main-agent active toolset so
 * the constitution directive ("MUST call `aft_search` /
 * `aft_outline` / `aft_zoom` before any bash `grep` / `rg` / `find`
 * / `cat`") becomes mechanically reachable end-to-end.
 */
export const AFT_TOOLS: readonly string[] = [
	"aft_callgraph",
	"aft_conflicts",
	"aft_delete",
	"aft_import",
	"aft_inspect",
	"aft_move",
	"aft_outline",
	"aft_refactor",
	"aft_safety",
	"aft_search",
	"aft_zoom",
];

/**
 * Magic-context (`ctx_*`) long-term memory tools registered by
 * `@cortexkit/pi-magic-context` at extension boot. Five tools:
 * cross-session recall (`ctx_search` / `ctx_memory`), note capture
 * (`ctx_note`), recall-graph compaction (`ctx_reduce`), and
 * per-result expansion (`ctx_expand`).
 *
 * The orchestrator's constitution (DEVELOPER_PROMPT § "Magic
 * Context", AGENTS.md § "Tool preference order") directs the LLM to
 * reach for `ctx_search` BEFORE re-deriving project knowledge ("did
 * we solve this before", "where does X live", "what did we decide
 * about Y"). pi-magic-context also registers `todowrite` (see
 * `TODOWRITE_TOOLS` above), but `ctx_*` were not added in GC-2026-081
 * — only the todowrite half of the suite was exposed.
 *
 * GC-2026-086: expose all five `ctx_*` tools so the long-term-memory
 * directive ("MUST reach for `ctx_search` before re-deriving project
 * knowledge") becomes reachable, not just the adjacent `todowrite`.
 */
export const CTX_TOOLS: readonly string[] = [
	"ctx_search",
	"ctx_memory",
	"ctx_note",
	"ctx_reduce",
	"ctx_expand",
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
	// GC-2026-074: todowrite view + DAG linkage (todowrite_compile /
	// todowrite_progress). DAG↔todo auto-sync is wired inside task_dispatch.
	registerTodowriteTools(pi);
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
	//
	//    GC-2026-087 SC1: tool ORDER matters for LLM selection bias.
	//    Earlier entries in `setActiveTools` are surfaced more
	//    prominently by the model — empirically validated across 7 days
	//    / 2,424 tool calls where baseline (bash/read/etc.) hit 92.8%
	//    while AFT/ctx/codebase stayed under 2% combined. The new order
	//    surfaces the specialized tools first:
	//
	//      ORCHESTRATOR → SUBAGENT → AFT → CTX → TODOWRITE → BASELINE
	//
	//    BASELINE_TOOLS stays in the active set (reorder, not removal —
	//    see goal contract anti_goals) but its position is demoted so
	//    the LLM sees aft_search / ctx_search / codebase_memory_* first.
	pi.on("session_start", () => {
		const tools: string[] = [
			...ORCHESTRATOR_TOOLS,
			...SUBAGENT_TOOLS,
			...AFT_TOOLS,
			...CTX_TOOLS,
			...TODOWRITE_TOOLS,
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
