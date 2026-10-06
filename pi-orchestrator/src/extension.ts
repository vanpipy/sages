/**
 * @sages/pi-orchestrator — package entry point (default pi extension).
 *
 * After GC-2026-orchestrator-simplify + GC-2026-workflow-run +
 * GC-2026-path-B-swap the orchestrator owns exactly TWO tools
 * (`goal_contract_create` + `workflow_run`). The DAG, dispatch,
 * audit, and reminder tools were removed. workflow_run is a thin
 * event-driven shim that emits `workflow:start` to pi-tasks and waits
 * for `workflow:phase-complete`; pi-tasks's `subscribeWorkflow` does
 * the cascade.
 *
 * Registers:
 *   - `goal_contract_create` — the intent + lock contract tool
 *   - Orchestrator advisory pipeline (post-tool detector + nudges)
 *
 * GC-2026-boundary-subagent-control: the subagent control tools
 * (subagent_status / steer / abort / resume) used to be registered
 * here. They are now owned by pi-subagents itself — the runtime
 * that owns the AgentManager also owns the tools that operate on it.
 * The orchestrator's `setActiveTools` still gates their visibility
 * via the `SUBAGENT_CONTROL_TOOLS` constant below, so non-orchestrator
 * sessions can opt in or out via `setActiveTools` policy.
 *
 * Three session-level hooks (preserved):
 *   1. `session_start`        — `pi.setActiveTools([...])`
 *   2. `before_agent_start`   — prepend `templates/SYSTEM.md`
 *   3. `tool_call`            — soft-mode reminder (first bash call)
 *
 * Brainstorming is registered separately as a slash command.
 *
 * Peer dependencies:
 *   - @earendil-works/pi-coding-agent  — ExtensionAPI type
 *   - @sages/pi-subagents           — Agent / get_subagent_result / steer_subagent
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGoalContractTool } from "./goal-contract.js";
import { registerWorkflowRunTool } from "./workflow-run-tool.js";
import {
	installOrchestratorAdvisoryHandlers,
	type OrchestratorAdvisoryRuntimeDeps,
} from "./orchestrator-advisory.js";
import { validateFailureCatalogOnBoot } from "./failure-catalog.js";
import { PhaseWidget } from "./ui/phase-widget.js";

/**
 * Tools always exposed to the main agent when the orchestrator
 * extension is loaded. After GC-2026-workflow-run this is two entries:
 * `goal_contract_create` (intent → goal.yaml) and `workflow_run`
 * (one-shot 5-phase pipeline runner). The workflow inside
 * `workflow_run` uses pi-tasks (TaskCreate / TaskExecute / etc.)
 * for live progress visibility — the pi-tasks tools are registered
 * by `@sages/pi-tasks` and exposed via the active toolset.
 */
export const ORCHESTRATOR_TOOLS: readonly string[] = [
	"goal_contract_create",
	"workflow_run",
];

/**
 * Tools registered by `@sages/pi-subagents` (`pi-subagents/src/index.ts`
 * lines 1154, 2040, 2138). `pi-subagents` owns the dispatch surface:
 * spawn an agent (`Agent`), poll its result (`get_subagent_result`),
 * inject a message into a running session (`steer_subagent`).
 */
export const PI_SUBAGENT_TOOLS = [
	"Agent",
	"get_subagent_result",
	"steer_subagent",
] as const;

/**
 * Tools registered by `@sages/pi-subagents` (GC-2026-boundary-subagent-control
 * moved the registration out of the orchestrator). These delegate to
 * the same `AgentManager` singleton via the shared globalThis registry
 * key `Symbol.for("pi-subagents:manager")` — there is exactly one
 * manager, shared end-to-end with the `Agent` tool. The orchestrator's
 * constant is purely for `setActiveTools` filtering; it does NOT
 * register anything.
 */
export const SUBAGENT_CONTROL_TOOLS = [
	"subagent_status",
	"subagent_steer",
	"subagent_abort",
	"subagent_resume",
] as const;

/**
 * Combined subagent toolset passed to `pi.setActiveTools` at
 * `session_start`.
 */
export const SUBAGENT_TOOLS: readonly string[] = [
	...PI_SUBAGENT_TOOLS,
	...SUBAGENT_CONTROL_TOOLS,
];

/**
 * Baseline file-system tools the main agent always needs regardless
 * of profile.
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
 * Pi-tasks tools (registered by `@sages/pi-tasks`). Exposed so the LLM
 * can drive the Implement → Review → optional Fix → Merge pipeline
 * directly via TaskCreate / TaskList / TaskExecute / etc. GC-2 will
 * add `workflow_run` as a one-shot pipeline runner on top of this.
 */
export const PI_TASKS_TOOLS: readonly string[] = [
	"TaskCreate",
	"TaskList",
	"TaskGet",
	"TaskUpdate",
	"TaskOutput",
	"TaskStop",
	"TaskExecute",
];

/**
 * AFT (Agentic File Tools) suite registered by `@cortexkit/aft-pi` at
 * extension boot. Eleven tools.
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
 * Soft-mode reminder text. Fires once per session on the first `bash`
 * tool call to nudge the LLM toward the pi-tasks-driven workflow when
 * the active task list exceeds 2 items (the historical `dag_threshold`).
 */
const SOFT_MODE_REMINDER = `> ⚙️ **SOFT MODE — workflow pipeline recommended**
>
> If this is part of a larger workflow (>2 items in your active task list,
> i.e. above the **task-count threshold**), consider driving it through
> the pi-tasks workflow: \`goal_contract_create\` → \`TaskCreate\` × 4
> (Implement / Review / optional Fix / Merge) → \`TaskExecute\`. For ≤2
> tasks (below the task-count threshold), direct handling is acceptable.
> This is a recommendation — the agent decides. No commands are blocked.
`;

/**
 * Path to `templates/SYSTEM.md` — the orchestrator constitution that
 * gets prepended to the LLM's system prompt on every agent start.
 */
const SYSTEM_PROMPT_TEMPLATE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"templates",
	"SYSTEM.md",
);

/**
 * Register all orchestrator tools on the pi extension. Idempotent.
 */
export function registerOrchestratorTools(
	pi: ExtensionAPI,
	runtime?: OrchestratorAdvisoryRuntimeDeps,
): void {
	registerGoalContractTool(pi);
	// GC-2026-workflow-run: one-shot 5-phase pipeline runner.
	registerWorkflowRunTool(pi);
	// GC-2026-053: orchestrator tool_call audit wiring.
	installOrchestratorAdvisoryHandlers(pi, runtime);
}

/**
 * Install the three session-level hooks.
 */
export function installSessionHooks(pi: ExtensionAPI): void {
	// 1. session_start — setActiveTools + setStatus.
	pi.on("session_start", () => {
		const tools: string[] = [
			...ORCHESTRATOR_TOOLS,
			...PI_TASKS_TOOLS,
			...SUBAGENT_TOOLS,
			...AFT_TOOLS,
			...BASELINE_TOOLS,
		];
		pi.setActiveTools(tools);
		(pi as unknown as {
			setStatus?: (key: string, text: string) => void;
		}).setStatus?.("sages-orchestrator", "📜 orchestrator active");
	});

	// GC-2026-phase-widget: install the phase plan widget. Subscribes to
	// workflow:start / workflow:phase-complete / subagents:completed /
	// subagents:failed events and queries pi-tasks's TaskStore via RPC
	// to render a phase-grouped plan view. Widget is read-only; pi-tasks
	// is the single source of truth for task state.
	//
	// GC-2026-precommit-fixes: only the widget install is gated on
	// `pi.events`. Test mocks (e.g. SMOKE-073) don't expose events but
	// DO expose `pi.on` / `pi.appendEntry`; an early return here used
	// to skip the rest of installSessionHooks, which meant the
	// soft-mode reminder at the bottom of the function was never
	// registered in test environments. The `if (eventsBus)` block
	// keeps the widget install opt-in without affecting the reminder.
	const eventsBus = (pi as { events?: unknown }).events;
	if (eventsBus) {
		const phaseWidget = new PhaseWidget({ bus: eventsBus as ConstructorParameters<typeof PhaseWidget>[0]["bus"] });
		phaseWidget.attach();
		// pi-coding-agent's session_start hook doesn't surface ctx.ui, so we
		// capture ctx on tool_execution_start (same pattern pi-tasks uses at
		// pi-tasks/src/index.ts:557). setWidget is idempotent on the host;
		// re-registering on every tool call would be wasteful, so we guard
		// with `widgetRegistered`.
		let widgetRegistered = false;
		pi.on("tool_execution_start", (_event, ctx) => {
			if (widgetRegistered) return;
			const ui = (ctx as { ui?: unknown }).ui as
				| {
						setWidget?: (
							key: string,
							content: unknown,
							opts?: { placement?: "aboveEditor" | "belowEditor" },
						) => void;
					requestRender?: () => void;
				}
				| undefined;
			if (!ui || typeof ui.setWidget !== "function") return;
			ui.setWidget(
				"workflow-plan",
				(_tui: unknown, _theme: unknown) => ({
					render: () => phaseWidget.render(),
					invalidate: () => {},
				}),
				{ placement: "aboveEditor" },
			);
			widgetRegistered = true;
		});
	}

	// 2. before_agent_start — prepend templates/SYSTEM.md.
	pi.on("before_agent_start", (event: unknown) => {
		if (!existsSync(SYSTEM_PROMPT_TEMPLATE)) return undefined;
		const overlay = readFileSync(SYSTEM_PROMPT_TEMPLATE, "utf-8");
		const systemPrompt =
			typeof event === "object" && event !== null && "systemPrompt" in event
				? (event as { systemPrompt?: string }).systemPrompt
				: undefined;
		return {
			systemPrompt: overlay + "\n\n---\n\n" + (systemPrompt ?? ""),
		};
	});

	// 3. tool_call — fire the soft-mode reminder once per session on the
	// first side-effecting tool call (bash / edit / write). GC-2026-098
	// L3: previously gated on bash only; if the LLM began a workflow
	// with edit/write directly (no bash), the nudge was missed.
	let reminderFired = false;
	pi.on("tool_call", (event: unknown) => {
		if (reminderFired) return undefined;
		const toolName =
			typeof event === "object" && event !== null && "toolName" in event
				? (event as { toolName?: string }).toolName
				: undefined;
		if (toolName !== "bash" && toolName !== "edit" && toolName !== "write") return undefined;
		reminderFired = true;
		pi.appendEntry("system", SOFT_MODE_REMINDER);
		return undefined;
	});
}

/**
  * Default pi extension entrypoint.
 *
 * GC-2026-097 M5: synchronously validate the failure-catalog at boot
 * (NOT on first lookup) so a malformed shipped catalog throws at
 * session_start instead of deep in a workflow 4 tool calls later.
 *
 * GC-2026-098 L8: the previous `registerBrainstormCommand` stub was
 * deleted. The `/brainstorm` slash command is registered via the
 * skill at `skills/brainstorming/SKILL.md` — see that file for the
 * registration mechanism.
 */
export default function registerOrchestratorExtension(pi: ExtensionAPI): void {
	validateFailureCatalogOnBoot();
	registerOrchestratorTools(pi);
	installSessionHooks(pi);
}
