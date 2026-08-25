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
 *     the active toolset, and no bash command is blocked at the
 *     `tool_call` layer.
 *
 *   - Subagent dispatch via the 4-stage DAG workflow (goal → DAG →
 *     dispatch → audit) is RECOMMENDED for workflows whose todowrite
 *     item count exceeds the active profile's `dag_threshold`. The
 *     agent decides whether to dispatch; no command is blocked.
 *
 *   - Drift from the recommended pattern is auto-steered via a
 *     `pi.appendEntry("system", softModeReminder(profile))` once per
 *     process (fired on the first write-intent bash command). The
 *     reminder is goal-orientation — it does NOT mention "you wrote
 *     production code" (per the user's directive). Drift is never
 *     blocked.
 *
 * As of GC-2026-049, the reminder is sourced from the active profile
 * (loaded once at module load via `loadProfile()`). The profile is
 * also the source of truth for `subagents` (whitelist),
 * `isolation_default`, `dag_threshold`, and `gate_suite`.
 *
 * Subagent dispatch and lifecycle are owned by `@tintinweb/pi-subagents`
 * (installed separately). The canonical built-in agents are
 * `developer`, `auditor`, `Explore`, `Plan`. The `git-expert` agent
 * is the default cross-workspace git inspection helper.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { registerOrchestratorTools } from "./tools/orchestrator/index.js";
import { classifyBashCommand } from "./tools/bash-guard.js";
import { softModeReminder } from "./soft-mode.js";
import { loadProfile } from "./profile/loader.js";
import { applyProfile } from "./profile/applier.js";
import {
	orchestratorAdvisoryFor,
	preToolBlockDecision,
	type OrchestratorToolCall,
	type OrchestratorToolResult,
	type OrchestratorAdvisoryContext,
} from "./tools/orchestrator/l1-advisory.js";
import { loadGoalContract, loadPlan } from "./tools/orchestrator/dag-synthesizer.js";
import { ORCHESTRATOR_DIR } from "./tools/orchestrator/types.js";
import {
	RunEvent,
	emitRunEvent,
} from "./observability/index.js";

// Load the active profile once at module load. Resolution order is
// documented in `profile.ts`; falls back to the `standard` built-in
// when no user override is present.
const PROFILE = loadProfile();

/**
 * Apply the 4-segment profile via the conductor's three pi hooks.
 *
 *   1. installCapabilityFilter — block tools not in profile.tools
 *   2. installPromptComposer  — prepend profile-driven system prompt
 *   3. installReminderInjector — fire soft-mode reminder once on first bash
 *
 * The conductor does NOT register tools, write state, or install files.
 * It only configures how the LLM interacts with the existing tool surface
 * + system prompt. PR 1 (GC-2026-069) — additive alongside the existing
 * orchestrator / bash-guard / l1-advisory wiring; the old behaviour stays
 * intact until PR 3 guts it.
 */
export function registerConductorOnly(pi: ExtensionAPI): void {
	const profile = loadProfile();
	applyProfile(pi, profile);
}

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 */
export default function registerSagesExtension(pi: ExtensionAPI): void {
	registerConductorOnly(pi);
	registerOrchestratorTools(pi);
	// GC-2026-060: the `sages_todo` tool was removed (GC-2026-068 reversal).
	// The LLM-facing todo tool is now Magic Context's `todowrite`, mirrored
	// into the Sages store by the tool_call listener below.

	// ── Session-scoped state ──────────────────────────────────────────
	// Mutable closure: each event handler reads / mutates the same state.
	// pi's extension API is single-threaded (events fire serially), so no
	// lock is needed. State persists for the lifetime of the registered
	// extension process — it is NOT reset per session.
	//
	// `remindedThisSession` is the auto-steer throttle: the soft-mode
	// reminder is appended at most once per process on the first
	// write-intent bash command. In a long-running pi process with
	// multiple sessions, only the first session sees the reminder.
	let remindedThisSession = false;

// Cap on the rolling `l1History` ring. The longest chain-detection
// rule threshold (`repeatCallChain` with default 5) needs ~5 entries
// to fire reliably; 50 leaves ~10× headroom for cross-tool chains
// without letting a long-running session grow the array unbounded.
const L1_HISTORY_CAP = 50;

	// ── L1 orchestrator advisory state (GC-2026-053) ─────────────────────
	// Mirror of L2's `AdvisoryContext` but lifted to the root agent so
	// the orchestrator's own tool-call stream is audited. The dedup set
	// + dispatch counter suppress repeat advisories for the same rule
	// across the same session, matching the L2 dedup/cap contract
	// exactly. Like `remindedThisSession`, this state is process-scoped.
	let l1History: OrchestratorToolCall[] = [];
	const l1Ctx: OrchestratorAdvisoryContext = {
		alreadyAdvisedRules: new Set<string>(),
		advisoriesBySeverity: { critical: 0, major: 0, minor: 0 },
	};
	// ── L1 error + assistant-message context (Items 2 & 3) ───────────────
	// errorHistory is populated by the `tool_result` listener below and
	// passed to detectors via `OrchestratorAdvisoryOptions.errorHistory`.
	// It gates stuck-loop advisories: a successful call in the chain
	// means the LLM is intentionally re-running, not stuck.
	const errorHistory: OrchestratorToolResult[] = [];
	// lastAssistantMessage is populated by the `message_end` listener
	// below. Detectors scan it for retry-intent markers (e.g. "retrying",
	// "amending the goal") to suppress stuck-loop advisories when the
	// LLM has explicitly signalled intent to retry with reasoning.
	let lastAssistantMessage: string | null = null;
	// ── L1 pre-tool blocker (Item 4) ─────────────────────────────────────
	// Pre-tool blockers run BEFORE the tool executes. When the upcoming
	// call would create a CRITICAL finding, return `{ block: true }` so
	// pi's tool_call loop returns the block without invoking the tool.
	// This is the strongest gate — critical mistakes must not happen at
	// all. Major findings still post-call advise but don't pre-block.

	// ── Bash reminder is now handled by the conductor ────────────────
	// GC-2026-069 PR 1: the historical write-intent-bash reminder
	// (removed) is replaced by `installReminderInjector` in
	// `profile/applier.ts`, called from `registerConductorOnly` above.
	// The new injector fires on the first bash call regardless of
	// classification — simpler, faster feedback to the LLM.

	// ── L1 orchestrator tool_call handler (GC-2026-053) ─────────────────
	// Separate handler so L1 logic stays isolated from the soft-mode
	// bash classifier. Runs on every orchestrator tool call, not just
	// bash; appends the call to history then asks `orchestratorAdvisoryFor`
	// for any advisories that should fire. Caps + dedup mirror L2.
	pi.on("tool_call", (event: any, ctx: any) => {
		const toolName: string = event?.toolName;
		if (typeof toolName !== "string" || toolName.length === 0) return;
		const input =
			event?.input && typeof event.input === "object" ? event.input : {};
		l1History.push({ toolName, input, timestamp: Date.now() });
		// Cap the rolling history at the longest chain threshold
		// (50 ≈ 5× the longest detect threshold) so the chain-detection
		// counter has enough signal without unbounded growth across a
		// long-running pi session. LRU eviction is fine — only the most
		// recent calls matter for repeat / resynth-loop detection.
		if (l1History.length > L1_HISTORY_CAP) l1History.splice(0, l1History.length - L1_HISTORY_CAP);

		const cwd: string = ctx?.cwd ?? process.cwd();
		const advisories = orchestratorAdvisoryFor(l1History, l1Ctx, {
			loadGoalScope: (goalId) => {
				const goal = loadGoalContract(cwd, goalId);
				if (!goal) return null;
				return {
					goal_id: goal.id,
					scope_include: goal.scope?.include ?? [],
					scope_exclude: goal.scope?.exclude ?? [],
				};
			},
			loadDagPlan: (dagId) => {
				const plan = loadPlan(cwd, dagId);
				if (!plan) return null;
				return {
					tasks: plan.tasks.map((t) => ({
						id: t.id,
						status: t.status,
						depends_on: t.depends_on ?? [],
					})),
				};
			},
		});
		for (const advisory of advisories) {
			pi.appendEntry("system", advisory.text);
			// Per-severity budget — critical fires freely (cap = ∞), major
			// capped at 4. Dedup via alreadyAdvisedRules prevents the same
			// rule from re-firing; the budget prevents noise from distinct
			// major findings.
			l1Ctx.alreadyAdvisedRules.add(advisory.rule);
			l1Ctx.advisoriesBySeverity[advisory.severity] =
				(l1Ctx.advisoriesBySeverity[advisory.severity] ?? 0) + 1;
		}
		return undefined;
	});

	// L1 pre-tool blocker (Item 4) — runs BEFORE the tool executes.
	// Critically, this handler returns `{ block: true, reason }` if the
	// upcoming call would create a critical advisory. When `block: true`
	// is returned, pi's tool_call loop short-circuits without invoking
	// the tool AND without running subsequent tool_call handlers for
	// this event. Therefore this handler must run BEFORE the L1
	// history-tracker below — registration order matters.
	pi.on("tool_call", (event: any, ctx: any) => {
		const toolName: string = event?.toolName;
		if (typeof toolName !== "string" || toolName.length === 0) return;
		const toolCallId: string | undefined =
			typeof event?.toolCallId === "string" ? event.toolCallId : undefined;
		const input =
			event?.input && typeof event.input === "object" ? event.input : {};
		const upcoming: OrchestratorToolCall = {
			toolName,
			input,
			timestamp: Date.now(),
			callId: toolCallId,
		};

		const cwd: string = ctx?.cwd ?? process.cwd();
		const decision = preToolBlockDecision(upcoming, l1History, {
			errorHistory,
			lastAssistantMessage: lastAssistantMessage ?? undefined,
			loadGoalScope: (goalId) => {
				const goal = loadGoalContract(cwd, goalId);
				if (!goal) return null;
				return {
					goal_id: goal.id,
					scope_include: goal.scope?.include ?? [],
					scope_exclude: goal.scope?.exclude ?? [],
				};
			},
			loadDagPlan: (dagId) => {
				const plan = loadPlan(cwd, dagId);
				if (!plan) return null;
				return {
					tasks: plan.tasks.map((t) => ({
						id: t.id,
						status: t.status,
						depends_on: t.depends_on ?? [],
					})),
				};
			},
		});
		if (decision) {
			const ruleMatch = decision.reason.match(/pre-tool block\] (\w+)/);
			const ruleId = ruleMatch?.[1];
			// Dedup at the block level: emit the rationale only once per
			// rule (matching post-tool advisory dedup). The block itself
			// always returns so the critical mistake is always prevented,
			// but the conversation stream isn't spammed with repeats.
			if (ruleId && !l1Ctx.alreadyAdvisedRules.has(ruleId)) {
				pi.appendEntry("system", decision.reason);
				l1Ctx.alreadyAdvisedRules.add(ruleId);
				l1Ctx.advisoriesBySeverity.critical =
					(l1Ctx.advisoriesBySeverity.critical ?? 0) + 1;
			} else if (ruleId) {
				l1Ctx.alreadyAdvisedRules.add(ruleId);
			}
		}
		return decision;
	});

	// L1 tool_result listener (Item 2) — error tracking.
	// Populates errorHistory keyed by toolCallId. Detectors compare each
	// call in a chain against this map: if any call succeeded, the chain
	// is not "stuck" and the corresponding advisory is suppressed.
	pi.on("tool_result", (event: any) => {
		const toolCallId: string | undefined =
			typeof event?.toolCallId === "string" ? event.toolCallId : undefined;
		const isError: boolean = event?.isError === true;
		if (!toolCallId) return;
		errorHistory.push({ toolCallId, isError });
		// Bound the array to match L1_HISTORY_CAP. Old entries age out.
		if (errorHistory.length > L1_HISTORY_CAP) errorHistory.shift();
	});

	// L1 message_end listener (Item 3) — assistant-message context.
	// Captures the last assistant message text. Detectors scan it for
	// retry-intent markers ("retrying", "amending the goal", "fixing
	// the issue") so stuck-loop advisories don't fire when the LLM has
	// explicitly signalled intent to retry with reasoning.
	pi.on("message_end", (event: any) => {
		const msg = event?.message;
		if (!msg || msg.role !== "assistant") return;
		const content = Array.isArray(msg.content) ? msg.content : [];
		const text = content
			.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join(" ");
		if (text.length > 0) lastAssistantMessage = text;
	});
}

// Exported for tests that want to assert which profile the extension
// booted under. Production code should treat PROFILE as immutable.
export { PROFILE };
