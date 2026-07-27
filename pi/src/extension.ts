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
 * Plus the main-agent gates (GC-2026-001 — brain-vs-limb hard threshold):
 *   - Layer 1 (session_start): drop raw `edit` / `write` from main agent's
 *     active toolset so it cannot bypass any write path. The LLM
 *     literally does not see those tools — only the 4 orchestrator
 *     tools (which write to `.pi/orchestrator/` only) and `Agent`
 *     (dispatch to subagents for any other write).
 *   - Layer 2 (tool_call): block bash commands whose write intent
 *     targets production code paths, via `shouldBlockBashCommand()` from
 *     `pi/src/tools/bash-guard.ts`. The bash-guard is one of two
 *     remaining limb-side write enforcements (the other is the file
 *     gate's path policy; both flow through `canMainAgentWrite`).
 *
 * Escape window (see `escape-window.ts` for the design): a sticky
 * session-level mode that reverses Layer 1 and partially relaxes
 * Layer 2. The user types `escape-window` (or the tool-error counter
 * crosses 200) to open it. Once open, the main agent has direct
 * write tools; rm / mv / cp still require the path to be a meta-file
 * (production code is still protected from `rm -rf`). The window
 * persists until the session ends; there is no in-session exit.
 *
 * Subagent dispatch and lifecycle are owned by `@tintinweb/pi-subagents`
 * (installed separately). The canonical built-in agents are
 * `developer`, `auditor`, `Explore`, `Plan`; the legacy `general-purpose`
 * helper is removed (was a fallback for meta-file edits that the
 * orchestrator can no longer reach — the escape window replaces it).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerOrchestratorTools } from "./tools/orchestrator/index.js";
import { shouldBlockBashCommand } from "./tools/bash-guard.js";
import {
	applyLayer1Strip,
	applyLayer1EscapeAdd,
	createEscapeState,
	escapeNoteText,
	ESCAPE_RETRY_THRESHOLD,
	ESCAPE_SYSTEM_PROMPT_MARKER,
	ESCAPE_TRIGGER_TEXT,
	evaluateEscapeBash,
	isRetryableToolBlock,
	openEscapeWindow,
} from "./escape-window.js";

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 */
export default function registerSagesExtension(pi: ExtensionAPI): void {
	registerOrchestratorTools(pi);

	// ── Session-scoped state ──────────────────────────────────────────
	// Mutable closure: each event handler reads / mutates the same state.
	// pi's extension API is single-threaded (events fire serially), so no
	// lock is needed. The state is reset on every session_start.
	let escape = createEscapeState();

	// ── Layer 1: drop raw edit/write from main agent's active tools ─────
	// (brain-vs-limb: main agent has no raw write tool — only the 4
	//  orchestrator tools + Agent dispatch. Escape reverses this.)
	pi.on("session_start", () => {
		escape = createEscapeState();
		applyLayer1Strip(pi);
	});

	// ── Layer 2: bash write-intent gate ───────────────────────────────────
	// (defense-in-depth: even if some extension re-enables edit/write, bash
	//  is gated by the same canMainAgentWrite() policy as the file-gate.
	//  In escape mode the path whitelist is bypassed for non-destructive
	//  commands; rm / mv / cp still respect the path policy.)
	pi.on("tool_call", (event: any, ctx: any) => {
		if (event.toolName !== "bash") return;
		const command: string = event.input.command;
		const cwd: string = ctx?.cwd ?? process.cwd();

		const decision = escape.escapeMode
			? evaluateEscapeBash(command, cwd)
			: shouldBlockBashCommand(command, { cwd });

		if (decision && decision.block) {
			// Count blocked tool calls toward the retry threshold.
			if (isRetryableToolBlock(event.toolName, true)) {
				escape.toolErrorCount += 1;
				maybeOpenEscapeFromRetries(pi, escape);
			}
			return { block: true, reason: decision.reason };
		}
	});

	// ── Tool error tracking ────────────────────────────────────────────
	// Counts every tool that the runtime reports as `isError: true`. The
	// 200-threshold opens the escape window automatically.
	pi.on("tool_execution_end", (event: any) => {
		if (event?.isError) {
			escape.toolErrorCount += 1;
			maybeOpenEscapeFromRetries(pi, escape);
		}
	});

	// ── User input: literal "escape-window" trigger ──────────────────
	// The user types the trigger as a chat message (no slash command).
	// Match is exact-and-case-insensitive on the trimmed text — any
	// surrounding message containing the trigger does NOT open the
	// window (deliberate: an off-hand mention in a longer message
	// shouldn't arm 主动模式 silently).
	pi.on("input", (event: any) => {
		const text: string = (event?.text ?? "").trim();
		if (text.toLowerCase() !== ESCAPE_TRIGGER_TEXT) return;
		const { state, justOpened } = openEscapeWindow(
			escape,
			"user-trigger",
		);
		escape = state;
		if (justOpened) {
			announceEscape(pi, escape);
		}
	});

	// ── Agent-start: surface escape state in the system prompt ────────
	// Each turn the orchestrator asks for the system prompt, we append
	// the escape marker so the LLM knows it's in 主动 mode. The marker
	// is only appended when the window is open.
	pi.on("before_agent_start", (event: any) => {
		if (!escape.escapeMode) return;
		return {
			systemPrompt: `${event.systemPrompt ?? ""}\n\n${ESCAPE_SYSTEM_PROMPT_MARKER}`,
		};
	});
}

/**
 * Helper: open the escape window if the retry threshold has been crossed
 * and the window is not already open. Idempotent — a re-open with the
 * `retry-threshold` reason after a `user-trigger` reason is a no-op (the
 * original reason is preserved so the user sees the first trigger).
 */
function maybeOpenEscapeFromRetries(
	pi: ExtensionAPI,
	state: ReturnType<typeof createEscapeState>,
): void {
	if (state.escapeMode) return;
	if (state.toolErrorCount <= ESCAPE_RETRY_THRESHOLD) return;
	const result = openEscapeWindow(state, "retry-threshold");
	// Mutate the closure-captured `state` reference (openEscapeWindow
	// returns a new state object; assign back to the local).
	// We can't reassign the closure variable from here, so the caller
	// (tool_call / tool_execution_end handler) reassigns via `escape = state`
	// after this returns. To keep the wiring simple, we accept the
	// mutation via shared object reference: replace fields in place.
	state.escapeMode = result.state.escapeMode;
	state.openedBy = result.state.openedBy;
	state.openedAt = result.state.openedAt;
	if (result.justOpened) {
		announceEscape(pi, state);
	}
}

/**
 * Open the escape window: re-add edit/write to the active toolset
 * (Layer 1 reverse) and emit a system note so the user can see the
 * transition. The marker is also surfaced via `before_agent_start`.
 */
function announceEscape(
	pi: ExtensionAPI,
	state: { openedBy: "user-trigger" | "retry-threshold" | null },
): void {
	applyLayer1EscapeAdd(pi);
	// appendEntry renders into the conversation log so the user sees a
	// visible note ("ESCAPE WINDOW OPEN — reason: ..."). The LLM also
	// picks it up via context.
	pi.appendEntry("system", escapeNoteText(state as never));
}
