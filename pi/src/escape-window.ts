/**
 * Escape Window — a session-level "主动模式" for the main agent.
 *
 * Background: the Sages main agent normally has no direct write tools
 * (Layer 1 hard threshold: edit/write are stripped from the active
 * toolset). All file changes must go through `Agent` dispatch. This is the
 * brain-vs-limb separation: the L3 main agent decides what should
 * happen; the L2 subagents do the actual work in isolated worktrees.
 *
 * When the main agent gets stuck (e.g. 200+ tool errors in a row, or
 * a user explicitly opts in), it can request an "escape window":
 * - Layer 1 reverses — `edit` / `write` are re-added to the active
 *   toolset, so the main agent can write files directly.
 * - Layer 2 partially relaxes — bash write-intent is allowed to any
 *   path EXCEPT destructive commands (rm / mv / cp), which still
 *   call canMainAgentWrite(). The destructive-command carve-out is
 *   a safety net: the user explicitly asked for an escape, but
 *   `rm -rf` is irreversible and we keep a guardrail on it.
 *
 * The window is sticky for the rest of the session. There is no
 * explicit exit — the user can end the session or let it ride. The
 * visible signal to the user is an `appendEntry` system note the
 * moment the window opens, plus a marker injected into the system
 * prompt on the next `before_agent_start` so the LLM knows it's in
 * 主动模式.
 *
 * Triggers (any one fires the window open):
 *   1. User types the literal string `escape-window` as a chat message
 *      (no slash command, no prefix — a plain message match is enough).
 *   2. Tool error count crosses 200. The counter increments on every
 *      `tool_call` block and on every `tool_execution_end` with
 *      `isError: true`. A retry on the user's part is the
 *      classic "stuck in a loop" signal.
 *
 * Exported for testability — the Sages extension wires these functions
 * to the corresponding `pi.on(...)` events; tests verify the pure
 * state machine in isolation.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
	shouldBlockBashCommand,
} from "./tools/bash-guard.js";

/** Magic text the user types (verbatim) to open the escape window. */
export const ESCAPE_TRIGGER_TEXT = "escape-window";

/** Tool-error / block counter threshold — crossing it opens the window. */
export const ESCAPE_RETRY_THRESHOLD = 200;

/** Marker injected into the system prompt while the window is open. */
export const ESCAPE_SYSTEM_PROMPT_MARKER = `
> ⚠️ **ESCAPE WINDOW OPEN — 主动模式** ⚠️
> The positive capability gate remains enforced: the main agent has no direct
> \`edit\` / \`write\` / \`aft_edit\` / \`apply_patch\` tools, and bash still runs
> through the fail-closed \`shouldBlockBashCommand\` policy. The user explicitly
> opted in (or the retry threshold tripped), but the dispatcher rules do not
> relax. Use this mode to surface a stuck workflow; resolve the underlying
> issue and run the orchestrator tools normally.
`;

/** Internal mutable state. Exported for test reset. */
export interface EscapeState {
	/** True after the window has opened for this session. */
	escapeMode: boolean;
	/** Count of tool errors + tool_call blocks. Resets on each session_start. */
	toolErrorCount: number;
	/** Why the window opened (for the system-note entry). */
	openedBy: "user-trigger" | "retry-threshold" | null;
	/** Epoch ms when the window opened (for the system-note entry). */
	openedAt: number | null;
}

/** Construct a fresh state. */
export function createEscapeState(): EscapeState {
	return {
		escapeMode: false,
		toolErrorCount: 0,
		openedBy: null,
		openedAt: null,
	};
}

/**
 * Open the escape window. Idempotent — re-opening after the window is
 * already open is a no-op (the original `openedBy` reason is preserved so
 * the user sees the first trigger, not whichever retry happened to
 * re-call). Returns the (possibly new) state plus a boolean indicating
 * whether the window JUST opened in this call.
 */
export function openEscapeWindow(
	state: EscapeState,
	openedBy: EscapeState["openedBy"],
): { state: EscapeState; justOpened: boolean } {
	if (state.escapeMode) {
		return { state, justOpened: false };
	}
	return {
		state: {
			...state,
			escapeMode: true,
			openedBy,
			openedAt: Date.now(),
		},
		justOpened: true,
	};
}

/** Exact capabilities available to the L3 coordinator. Unknown tools fail closed. */
export const MAIN_AGENT_CAPABILITY_ALLOWLIST = new Set([
	"read", "grep", "find", "ls", "bash",
	"aft_read", "aft_search", "aft_zoom", "aft_outline", "aft_inspect",
	"codebase_search", "codebase_refs", "codebase_memory_list_projects",
	"codebase_memory_search_graph", "codebase_memory_query_graph",
	"codebase_memory_trace_path", "codebase_memory_get_architecture",
	"graphify_query", "ctx_search", "ctx_expand", "todowrite", "todoread",
	"goal_contract_create", "dag_synthesize", "task_dispatch", "orchestrator_audit",
	"Agent", "get_subagent_result", "steer_subagent",
]);

/**
 * Layer 1 (session_start): positive capability gate.
 *
 * A denylist is insufficient because newly installed mutation tools would be
 * exposed until this package learned their names. Only reviewed coordinator,
 * Agent lifecycle, and read-only capabilities survive.
 */
export function applyLayer1Strip(pi: ExtensionAPI): void {
	pi.setActiveTools(pi.getActiveTools().filter((tool: string) => MAIN_AGENT_CAPABILITY_ALLOWLIST.has(tool)));
}

/**
 * Compatibility hook for the historical escape-window event. The positive
 * capability boundary is non-bypassable, so opening the window reapplies the
 * allowlist rather than restoring mutation tools.
 */
export function applyLayer1EscapeAdd(pi: ExtensionAPI): void {
	applyLayer1Strip(pi);
}

/**
 * Escape-window Layer 2 policy: bash write-intent.
 *
 * In normal mode the bash-guard is fully enforced (path policy + rm/mv/cp
 * + destructive commands). In escape mode the path policy is BYPASSED for
 * non-destructive write-intent (sed -i, tee, redirects, etc.); destructive
 * commands (rm / mv / cp) still call canMainAgentWrite() so production
 * code can't be `rm -rf`'d from the main agent even in escape mode.
 *
 * Returns either `undefined` (allow) or `{ block: true, reason }` (block).
 */
export function evaluateEscapeBash(
	command: string,
	cwd: string,
): { block: true; reason: string } | undefined {
	const decision = shouldBlockBashCommand(command, { cwd });
	return decision.block ? { block: true, reason: decision.reason! } : undefined;
}

/**
 * Decide whether a tool_call block from the bash-guard should count as
 * a retry. Used by the main `tool_call` handler to bump the error
 * counter. The counter itself is maintained by the extension caller;
 * this function only returns the decision (so unit tests can pin it
 * without invoking the full extension flow).
 */
export function isRetryableToolBlock(
	toolName: string,
	_blocked: boolean,
): boolean {
	// We only count bash blocks (the bash-guard is the primary
	// write-intent enforcement). edit/write are NOT in the active
	// toolset under Layer 1 so they cannot be called by the main
	// agent — a "block" for them would indicate an extension bug.
	return toolName === "bash" && _blocked;
}

/** Compose the system-note entry shown to the user when the window opens. */
export function escapeNoteText(state: EscapeState): string {
	const when = new Date(state.openedAt ?? Date.now()).toISOString();
	const by =
		state.openedBy === "user-trigger"
			? `user typed \`${ESCAPE_TRIGGER_TEXT}\``
			: `tool error count crossed ${ESCAPE_RETRY_THRESHOLD}`;
	return (
		`🔓 **ESCAPE WINDOW OPEN** — ${when}\n` +
		`Reason: ${by}.\n` +
		`The positive capability gate remains enforced: no direct mutation tools\n` +
		`are added and bash uses the normal fail-closed policy. The session marker\n` +
		`continues to be appended on subsequent turns. The window persists until the session ends.`
	);
}
