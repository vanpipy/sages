/**
 * l1-advisory.ts — GC-2026-053 + GC-2026-059
 *
 * Orchestrator advisory mirror. This mirrors the subagent advisory
 * pattern from `pi-subagents/src/agent-runner.ts:advisoryFor`, applied to
 * the orchestrator's own tool-call history instead of subagent messages.
 *
 * The subagent advisory audits subagent message text for governance
 * compliance (YAML block, checkpoint cadence, ASK propagation, BLOCKED
 * reason). This orchestrator advisory audits the orchestrator's
 * tool-call stream for the same class of problems at the orchestrator's
 * own layer:
 *
 *   - dag_resynth_loop        — same (tool, args) re-synthesized > N times
 *   - dispatch_no_audit       — task dispatched but never audited
 *   - transition_skip_failed  — task dispatched while dep is failed
 *   - goal_drift_detected     — tool input references out-of-scope paths
 *   - no_progress_no_audit    — many tool calls without an audit pass
 *   - repeat_call_chain       — same (tool, args) called N+ times (general
 *                                stuck-on-same-call detector, mirrors dsh
 *                                repeat-tool-reminder chain-key semantics)
 *
 * Output contract mirrors the subagent advisory exactly:
 *
 *   [orchestrator audit advisory — N/M] <rule>: <issue>. Fix: <directive>.
 *
 * Filters:
 *   - severity: only major + critical
 *   - dedup: skip rules already in ctx.alreadyAdvisedRules
 *   - cap: at most ADVISORY_MAX_PER_DISPATCH advisories per call
 *   - token cap: per-advisory text is truncated to ADVISORY_MAX_TOKENS
 *
 * Scope and DAG state are loaded through injected callbacks so the
 * helper stays pure (no fs reads in the helper itself; the runtime
 * registers a thin wrapper in `extension.ts` that supplies real
 * loaders).
 *
 * GC-2026-059: chain-key detection
 * ----------------------------------
 * Pre-GC-2026-059, dag_resynth_loop used `per-goal_id` counter as a
 * partial chain-key. This still produced false positives: a model that
 * legitimately refines a goal (different args on each
 * `dag_synthesize` call) gets flagged after 3 calls. The new
 * implementation uses full `(toolName, canonicalized-args)` chain-keys
 * — mirroring deepseek-harness's `repeat-tool-reminder` design.
 * Same args = stuck. Different args = progress.
 */

export type L1Severity = "minor" | "major" | "critical";

import {
	chainKey,
	tallyChainCounts,
	chainCountAtLeast,
	type ChainToolCall,
} from "./chain-key.js";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type L1RuleId =
	| "dag_resynth_loop"
	| "dispatch_no_audit"
	| "transition_skip_failed"
	| "goal_drift_detected"
	| "no_progress_no_audit"
	| "repeat_call_chain";

export interface L1Finding {
	rule: L1RuleId;
	severity: L1Severity;
	issue: string;
	evidence: string;
	recommendation: string;
}

/** A single orchestrator tool-call entry. Mirrors the shape pi's
 *  `tool_call` event delivers (toolName + input), plus a wall-clock
 *  timestamp for cadence analysis and an optional `callId` for
 *  correlating with `tool_result` events (used by error-aware detectors). */
export interface OrchestratorToolCall {
	toolName: string;
	input: Record<string, unknown>;
	/** Unix ms timestamp. */
	timestamp: number;
	/** Optional pi toolCallId for tool_result correlation. Detectors
	 *  that don't need error tracking can leave this undefined. */
	callId?: string;
}

/** A single orchestrator tool-result record, sourced from pi's
 *  `tool_result` event. Maps `toolCallId` (from the matching tool_call)
 *  to the outcome. */
export interface OrchestratorToolResult {
	toolCallId: string;
	/** True if the tool returned an error (e.g. validation failure,
	 *  execution exception). False on success. */
	isError: boolean;
}

/** Snapshot of the active goal contract used by goal_drift_detected. */
export interface GoalScopeSnapshot {
	goal_id: string;
	scope_include: string[];
	scope_exclude: string[];
}

/** Snapshot of the active DAG plan used by transition_skip_failed. */
export interface DagPlanSnapshot {
	tasks: Array<{
		id: string;
		status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
		depends_on: string[];
	}>;
}

export interface OrchestratorAdvisoryContext {
	/** Rules already advised in this process. Used to fire-once dedup
	 *  per rule ID — the same mistake must not nag the LLM repeatedly. */
	alreadyAdvisedRules: Set<string>;
	/** Per-severity counters — compared against
	 *  DEFAULT_ADVISORY_BUDGET_BY_SEVERITY (or the override passed via
	 *  options.maxAdvisoriesBySeverity). The extension process owns
	 *  this map; orchestratorAdvisoryFor reads it but never mutates it. */
	advisoriesBySeverity: Record<L1Severity, number>;
}

export interface OrchestratorAdvisoryOptions {
	/** Tool name for dag_synthesize (default: "dag_synthesize"). */
	dagSynthesizeToolName?: string;
	/** Tool name for task_dispatch (default: "task_dispatch"). */
	taskDispatchToolName?: string;
	/** Tool name for orchestrator_audit (default: "orchestrator_audit"). */
	orchestratorAuditToolName?: string;
	/** Threshold for dag_resynth_loop (default: 2 — fires after 3+ calls). */
	resynthThreshold?: number;
	/** Threshold for repeat_call_chain (default: 3). */
	repeatThreshold?: number;
	/** Threshold for no_progress_no_audit (default: 10). */
	progressThreshold?: number;
	/** Stuck-interval ceiling for chain-loop detection (ms). A chain
	 *  is only considered "stuck" if every interval between consecutive
	 *  calls is below this threshold. Defaults to 2000ms — LLM thinking
	 *  time between retries typically exceeds this; genuine stuck loops
	 *  fire sub-second. Use this to suppress false positives where the
	 *  LLM is intentionally retrying with reasoning in between. */
	stuckIntervalMs?: number;
	/** Recent tool-result outcomes keyed by toolCallId. When provided,
	 *  detectors that fire on stuck patterns (dag_resynth_loop,
	 *  repeat_call_chain) require every call in the chain to have
	 *  errored. A successful call in the chain means the LLM is
	 *  intentionally re-running for a reason other than failure —
	 *  typical of retries-with-fix-not-yet-deployed, or refresh after
	 *  state changes. Use this to suppress false positives. */
	errorHistory?: OrchestratorToolResult[];
	/** Text of the last assistant message. When provided, detectors
	 *  scan for retry-intent markers (e.g. "retrying", "amending the
	 *  goal") and suppress stuck-loop advisories if the LLM has
	 *  clearly signalled intent to retry with reasoning. Use this to
	 *  suppress false positives on thoughtful retries. */
	lastAssistantMessage?: string;
	/** Loader for the active goal contract (used by goal_drift_detected). */
	loadGoalScope?: (goalId: string) => GoalScopeSnapshot | null;
	/** Loader for the active DAG plan (used by transition_skip_failed). */
	loadDagPlan?: (dagId: string) => DagPlanSnapshot | null;
	/** Per-severity cap override. Merged on top of
	 *  DEFAULT_ADVISORY_BUDGET_BY_SEVERITY. Set a severity to
	 *  `Number.POSITIVE_INFINITY` to disable its cap entirely. */
	maxAdvisoriesBySeverity?: Partial<Record<L1Severity, number>>;
}

// =============================================================================
// Caps — per-severity, dynamic.
// =============================================================================

/** Per-advisory token cap. Mirrors subagent advisory's
 *  ADVISORY_MAX_TOKENS so the two layers are formatted identically. */
export const ADVISORY_MAX_TOKENS = 200;

/**
 * Default advisory budget per severity, per process.
 *
 * - **critical** = ∞ — critical mistakes must always surface. The
 *   dedup set (`alreadyAdvisedRules`) prevents the same rule from
 *   firing twice, but distinct critical rules fire freely.
 *   Rationale: a real governance violation (e.g. dispatching without
 *   audit, transitioning past a failed dep) is the advisory's main
 *   value. Silencing it after a fixed budget defeats the design.
 *
 * - **major** = 4 — bounded to avoid LLM noise. Major findings
 *   (dag_resynth_loop, goal_drift, no_progress, repeat_call_chain)
 *   are common enough that an unbounded budget would spam the LLM.
 *
 * - **minor** = 0 — hard-filtered regardless of override. The
 *   current detector set has no minor rules; this field exists so
 *   a future minor rule doesn't silently flood the LLM.
 *
 * Overridable via `options.maxAdvisoriesBySeverity`. Set to
 * `Number.POSITIVE_INFINITY` to disable a severity's cap.
 */
export const DEFAULT_ADVISORY_BUDGET_BY_SEVERITY: Record<L1Severity, number> = {
	critical: Number.POSITIVE_INFINITY,
	major: 4,
	minor: 0,
};

export const ADVISORY_MIN_SEVERITY: L1Severity = "major";

/** Per-rule actionable fix text. Mirrors subagent advisory's `RULE_FIX_DIRECTIVES`
 *  shape so both layers are introspectable in the same way. */
export const RULE_FIX_DIRECTIVES: Record<L1RuleId, string> = {
	dag_resynth_loop:
		"The previous DAG synthesis failed due to X; either amend goal({scope, criteria}), or explicitly revise the current DAG instead of calling dag_synthesize again (if args are identical each time)",
	dispatch_no_audit:
		"Call orchestrator_audit({ dag_id: '<active_dag_id>' }) to verify this dispatch's output; audit is the final step of the Sages 4-stage loop",
	transition_skip_failed:
		"T_dep is failed; explicitly go back and fix T_dep, or mark T_dep as skipped in the DAG before dispatching the current task; you cannot skip a failed dependency",
	goal_drift_detected:
		"Check whether task.files are inside goal-{id}.yaml's scope.include; if they are new files, first call goal_contract_create to amend the scope instead of dispatching directly",
	no_progress_no_audit:
		"Stop and call orchestrator_audit({ dag_id }); if the audit passes, continue — audit is the orchestrator's only means of self-verification",
	repeat_call_chain:
		"You called the same tool with identical args ≥3 times — this indicates you are stuck. Stop, re-read the last result, and decide whether to change approach or conclude. Do not keep repeating the same call",
};

// =============================================================================
// Finding extractors
// =============================================================================

interface Counters {
	dagSynthesizeCalls: number;
	taskDispatchCalls: number;
	orchestratorAuditCalls: number;
	totalToolCallsSinceLastAudit: number;
	lastAuditIndex: number;
}

function tallyCounters(
	history: OrchestratorToolCall[],
	opts: Required<Pick<OrchestratorAdvisoryOptions, "dagSynthesizeToolName" | "taskDispatchToolName" | "orchestratorAuditToolName">>,
): Counters {
	const c: Counters = {
		dagSynthesizeCalls: 0,
		taskDispatchCalls: 0,
		orchestratorAuditCalls: 0,
		totalToolCallsSinceLastAudit: 0,
		lastAuditIndex: -1,
	};
	for (const call of history) {
		if (call.toolName === opts.dagSynthesizeToolName) {
			c.dagSynthesizeCalls += 1;
			c.totalToolCallsSinceLastAudit += 1;
		} else if (call.toolName === opts.taskDispatchToolName) {
			c.taskDispatchCalls += 1;
			c.totalToolCallsSinceLastAudit += 1;
		} else if (call.toolName === opts.orchestratorAuditToolName) {
			c.orchestratorAuditCalls += 1;
			c.lastAuditIndex = history.indexOf(call);
			c.totalToolCallsSinceLastAudit = 0;
		} else {
			c.totalToolCallsSinceLastAudit += 1;
		}
	}
	return c;
}

/** Default stuck-interval ceiling (ms). LLM thinking time between
 *  intentional retries typically exceeds this; genuine stuck loops
 *  fire sub-second. Tunable via `OrchestratorAdvisoryOptions.stuckIntervalMs`. */
export const DEFAULT_STUCK_INTERVAL_MS = 2000;

/** Group timed calls by chain-key, preserving call order. Used by
 *  detectors that need per-chain interval analysis (not just count). */
function groupCallsByChainKey(
	calls: OrchestratorToolCall[],
): Map<string, OrchestratorToolCall[]> {
	const byChain = new Map<string, OrchestratorToolCall[]>();
	for (const call of calls) {
		const key = chainKey(call.toolName, call.input);
		const bucket = byChain.get(key);
		if (bucket) bucket.push(call);
		else byChain.set(key, [call]);
	}
	return byChain;
}

/** True if every call in `chain` has a matching tool_result with
 *  `isError=true`. Used to gate "stuck on retries" detectors — a
 *  successful call in the chain means the LLM is intentionally
 *  re-running, not stuck. Returns true (eligible) when no
 *  errorHistory is provided (back-compat) or when no matching results
 *  exist for the chain. */
function chainAllErrored(
	chain: OrchestratorToolCall[],
	errorHistory: OrchestratorToolResult[] | undefined,
): boolean {
	if (!errorHistory) return true;
	const errorByCallId = new Map<string, boolean>();
	for (const r of errorHistory) errorByCallId.set(r.toolCallId, r.isError);
	for (const c of chain) {
		if (!c.callId) continue; // no correlation possible → don't gate
		const outcome = errorByCallId.get(c.callId);
		if (outcome === undefined) continue; // no result yet → don't gate
		if (!outcome) return false; // at least one call succeeded → not stuck
	}
	return true;
}

/** Patterns indicating the LLM has explicitly signalled retry intent in
 *  its last assistant message. Matched against the last assistant
 *  message text provided via `options.lastAssistantMessage`. When any
 *  pattern matches, stuck-loop detectors are suppressed — the LLM is
 *  intentionally retrying with reasoning, not stuck.
 *
 *  Patterns are deliberately narrow to avoid false positives on
 *  casual use of "retry" / "amend" in non-stuck contexts (e.g. "I'll
 *  retry that later" with no follow-up). */
const RETRY_INTENT_PATTERNS: RegExp[] = [
	/\bretrying\b/i,
	/\bre-?attempt/i,
	/\bamending (?:the )?(?:goal|contract|dag)/i,
	/\bfixing (?:the )?(?:issue|problem|error)/i,
	/\btrying again\b/i,
	/\blet me (?:try|retry|amend|fix)/i,
];

function showsRetryIntent(text: string | undefined): boolean {
	if (!text) return false;
	return RETRY_INTENT_PATTERNS.some((p) => p.test(text));
}

/** Compute the maximum interval (ms) between consecutive calls in a chain.
 *  Returns 0 for chains of length ≤ 1 (no intervals to measure). */
function maxIntervalInChain(chain: OrchestratorToolCall[]): number {
	if (chain.length <= 1) return 0;
	let max = 0;
	for (let i = 1; i < chain.length; i++) {
		const prev = chain[i - 1];
		const curr = chain[i];
		if (!prev || !curr) continue;
		const interval = curr.timestamp - prev.timestamp;
		if (interval > max) max = interval;
	}
	return max;
}

/** Detect `dag_resynth_loop`: same (tool, args) chain-key for dag_synthesize
 *  seen more than the threshold AND all intervals below `stuckIntervalMs`.
 *  The interval gate distinguishes true stuck loops (sub-second retries)
 *  from intentional retry-with-reasoning patterns (8-12s between attempts). */
function detectDagResynthLoop(
	history: OrchestratorToolCall[],
	dagToolName: string,
	threshold: number,
	stuckIntervalMs: number,
	errorHistory: OrchestratorToolResult[] | undefined,
	lastAssistantMessage: string | undefined,
): L1Finding | null {
	const dagCalls = history.filter((c) => c.toolName === dagToolName);
	const byChain = groupCallsByChainKey(dagCalls);

	let top: { chain: OrchestratorToolCall[]; count: number } | null = null;
	for (const chain of byChain.values()) {
		if (chain.length <= threshold) continue;
		if (maxIntervalInChain(chain) >= stuckIntervalMs) continue;
		if (!chainAllErrored(chain, errorHistory)) continue;
		if (top === null || chain.length > top.count) {
			top = { chain, count: chain.length };
		}
	}
	if (!top) return null;
	// Last gate: if the LLM has explicitly signalled retry intent in its
	// last assistant message, suppress — the retries are deliberate.
	if (showsRetryIntent(lastAssistantMessage)) return null;
	const sample = top.chain[0]!;
	return {
		rule: "dag_resynth_loop",
		severity: "major",
		issue: `dag_synthesize called ${top.count} times with identical args (>${threshold}) within <${stuckIntervalMs}ms intervals, all errored`,
		evidence: `chain ${sample.toolName}(${JSON.stringify(sample.input).slice(0, 80)}) × ${top.count}`,
		recommendation:
			"orchestrator is re-synthesizing the same DAG with identical arguments in rapid succession; stop and revise either the goal contract or the existing DAG",
	};
}

/** Detect `repeat_call_chain`: same (tool, args) called ≥ threshold times
 *  AND all intervals below `stuckIntervalMs`. General stuck-on-same-call
 *  detector — interval gate prevents false positives on retries-with-thinking. */
function detectRepeatCallChain(
	history: OrchestratorToolCall[],
	threshold: number,
	stuckIntervalMs: number,
	errorHistory: OrchestratorToolResult[] | undefined,
	lastAssistantMessage: string | undefined,
): L1Finding | null {
	const byChain = groupCallsByChainKey(history);

	let top: { chain: OrchestratorToolCall[]; count: number; sample: ChainToolCall } | null = null;
	for (const chain of byChain.values()) {
		if (chain.length < threshold) continue;
		// Suppress dag_synthesize chains — covered by dag_resynth_loop.
		if (chain[0]?.toolName === "dag_synthesize") continue;
		if (maxIntervalInChain(chain) >= stuckIntervalMs) continue;
		if (!chainAllErrored(chain, errorHistory)) continue;
		if (top === null || chain.length > top.count) {
			top = { chain, count: chain.length, sample: { toolName: chain[0]!.toolName, input: chain[0]!.input } };
		}
	}
	if (!top) return null;
	// Same retry-intent gate as dag_resynth_loop.
	if (showsRetryIntent(lastAssistantMessage)) return null;
	return {
		rule: "repeat_call_chain",
		severity: "major",
		issue: `${top.count} identical calls to ${top.sample.toolName} with the same args (>=${threshold}) within <${stuckIntervalMs}ms intervals, all errored`,
		evidence: `chain ${top.sample.toolName}(${JSON.stringify(top.sample.input).slice(0, 80)}) × ${top.count}`,
		recommendation:
			"orchestrator is calling the same tool with identical arguments in rapid succession; this suggests it is stuck. Re-read the last result, change approach, or conclude",
	};
}

/** Detect `dispatch_no_audit`: task_dispatch called but no orchestrator_audit observed
 *  in the entire history (or no audit observed AFTER the last dispatch). */
function detectDispatchNoAudit(counters: Counters): L1Finding | null {
	if (counters.taskDispatchCalls === 0) return null;
	// The simplest correct rule: there has been at least one dispatch,
	// and no audit has been observed. This covers the most common
	// failure mode (orchestrator forgets Stage 4 entirely). The more
	// refined rule (audit-after-last-dispatch) is checked separately
	// below when counters.orchestratorAuditCalls > 0.
	if (counters.orchestratorAuditCalls === 0) {
		return {
			rule: "dispatch_no_audit",
			severity: "critical",
			issue: `task_dispatch called ${counters.taskDispatchCalls} time(s) but no orchestrator_audit observed`,
			evidence: `${counters.taskDispatchCalls} dispatches, 0 audits`,
			recommendation:
				"call orchestrator_audit to verify the dispatched task before declaring PASS",
		};
	}
	return null;
}

/** Detect `transition_skip_failed`: most recent task_dispatch lifecycle transition
 *  moves a task to in_progress while one of its deps is in `failed` state. */
function detectTransitionSkipFailed(
	history: OrchestratorToolCall[],
	taskDispatchToolName: string,
	loadDagPlan: ((dagId: string) => DagPlanSnapshot | null) | undefined,
): L1Finding | null {
	if (!loadDagPlan) return null;
	// Walk history in reverse to find the most recent task_dispatch that
	// includes a transition block. If its task has any failed dep, fire.
	for (let i = history.length - 1; i >= 0; i--) {
		const call = history[i]!;
		if (call.toolName !== taskDispatchToolName) continue;
		const transition = call.input.transition as
			| { task_id?: string; status?: string }
			| undefined;
		const dagId = typeof call.input.dag_id === "string" ? call.input.dag_id : null;
		if (!transition?.task_id || transition.status !== "in_progress" || !dagId) {
			continue;
		}
		const plan = loadDagPlan(dagId);
		if (!plan) continue;
		const task = plan.tasks.find((t) => t.id === transition.task_id);
		if (!task) continue;
		const failedDeps = task.depends_on.filter((depId) => {
			const dep = plan.tasks.find((t) => t.id === depId);
			return dep?.status === "failed";
		});
		if (failedDeps.length > 0) {
			return {
				rule: "transition_skip_failed",
				severity: "critical",
				issue: `task ${transition.task_id} moved to in_progress but dep(s) ${failedDeps.join(", ")} are in failed state`,
				evidence: `deps ${failedDeps.join(", ")} status=failed in dag ${dagId}`,
				recommendation:
					"re-dispatch the failed dep first or mark it skipped in the DAG, then retry",
			};
		}
		// Only inspect the most recent dispatch-with-transition.
		return null;
	}
	return null;
}

/** Detect `goal_drift_detected`: any tool call references paths that fall outside
 *  the active goal contract's scope.include (and not in scope.exclude). */
function detectGoalDrift(
	history: OrchestratorToolCall[],
	loadGoalScope: ((goalId: string) => GoalScopeSnapshot | null) | undefined,
): L1Finding | null {
	if (!loadGoalScope) return null;
	// Gather (goalId, paths) pairs from the history. We only consider
	// tools that explicitly carry file references (dag_synthesize with
	// tasks[].files). Other tools (read/write/bash) carry implicit paths
	// that are too noisy to anchor drift detection on.
	for (const call of history) {
		if (call.toolName !== "dag_synthesize") continue;
		const goalId = typeof call.input.goal_id === "string" ? call.input.goal_id : null;
		if (!goalId) continue;
		const scope = loadGoalScope(goalId);
		if (!scope) continue;
		const tasks = Array.isArray(call.input.tasks) ? call.input.tasks : [];
		const outOfScope: string[] = [];
		for (const t of tasks) {
			const files = (t as { files?: unknown })?.files;
			if (!Array.isArray(files)) continue;
			for (const f of files) {
				if (typeof f !== "string") continue;
				if (!isPathInScope(f, scope)) outOfScope.push(f);
			}
		}
		if (outOfScope.length > 0) {
			return {
				rule: "goal_drift_detected",
				severity: "major",
				issue: `${outOfScope.length} file(s) reference paths outside goal ${goalId}'s scope.include`,
				evidence: outOfScope.slice(0, 5).join(", "),
				recommendation:
					"either rewrite the task to use in-scope files, or amend goal_contract scope.include before dispatching",
			};
		}
	}
	return null;
}

/** A path is "in scope" if it is prefixed by any scope_include entry
 *  AND not prefixed by any scope_exclude entry. Empty scope.include
 *  means nothing is constrained (no drift detected). Empty scope.exclude
 *  means nothing is forbidden. */
function isPathInScope(path: string, scope: GoalScopeSnapshot): boolean {
	if (scope.scope_include.length === 0) return true;
	const included = scope.scope_include.some((prefix) => path.startsWith(prefix));
	const excluded = scope.scope_exclude.some((prefix) => path.startsWith(prefix));
	return included && !excluded;
}

/** Detect `no_progress_no_audit`: many tool calls observed since the last audit
 *  (or since session start if no audit yet). GC-2026-059 tightened
 *  this to require at least one chain at length ≥ 3 (otherwise the
 *  rule would fire on any 10+ tool calls regardless of pattern). */
function detectNoProgressNoAudit(
	counters: Counters,
	history: OrchestratorToolCall[],
	threshold: number,
	chainKeyThreshold: number = 3,
): L1Finding | null {
	if (counters.totalToolCallsSinceLastAudit <= threshold) return null;
	// Tighten: also require at least one chain at length ≥ chainKeyThreshold.
	// This means the rule fires when the LLM is genuinely stuck on a
	// pattern (e.g. re-reading the same file 3+ times) AND has gone
	// many calls without an audit. Without the chain-key, the rule
	// would fire on any 10+ calls regardless of repetition.
	const counts = tallyChainCounts(
		history.map((c) => ({ toolName: c.toolName, input: c.input })),
	);
	if (!chainCountAtLeast(counts, chainKeyThreshold)) return null;
	return {
		rule: "no_progress_no_audit",
		severity: "major",
		issue: `${counters.totalToolCallsSinceLastAudit} tool call(s) since last orchestrator_audit (>${threshold}), with at least one chain at length ≥${chainKeyThreshold}`,
		evidence: `totalToolCallsSinceLastAudit=${counters.totalToolCallsSinceLastAudit}, threshold=${threshold}, audits=${counters.orchestratorAuditCalls}, maxChainCount=${Math.max(0, ...Array.from(counts.values()).map((c) => c.count))}`,
		recommendation:
			"stop and call orchestrator_audit to verify the current state before making more changes",
	};
}

// =============================================================================
// Public API
// =============================================================================

/**
 * One advisory entry — the wire string for `pi.appendEntry("system", ...)`
 * plus the structured fields the caller needs to update its dedup /
 * per-severity budget counters without re-parsing the text.
 */
export interface L1AdvisoryEntry {
	/** Formatted string with the same shape the subagent advisory emits, prefixed with severity. */
	text: string;
	/** Rule ID — caller adds this to `alreadyAdvisedRules`. */
	rule: L1RuleId;
	/** Severity — caller increments `advisoriesBySeverity[severity]`. */
	severity: L1Severity;
}

/** Extract L1 findings from the orchestrator's tool-call history. */
export function extractOrchestratorFindings(
	history: OrchestratorToolCall[],
	options: OrchestratorAdvisoryOptions = {},
): L1Finding[] {
	const opts = {
		dagSynthesizeToolName: options.dagSynthesizeToolName ?? "dag_synthesize",
		taskDispatchToolName: options.taskDispatchToolName ?? "task_dispatch",
		orchestratorAuditToolName: options.orchestratorAuditToolName ?? "orchestrator_audit",
		resynthThreshold: options.resynthThreshold ?? 2,
		repeatThreshold: options.repeatThreshold ?? 3,
		progressThreshold: options.progressThreshold ?? 10,
		stuckIntervalMs: options.stuckIntervalMs ?? DEFAULT_STUCK_INTERVAL_MS,
		loadGoalScope: options.loadGoalScope,
		loadDagPlan: options.loadDagPlan,
	};

	const findings: L1Finding[] = [];

	const counters = tallyCounters(history, opts);
	const sevRank: Record<L1Severity, number> = { minor: 0, major: 1, critical: 2 };

	const f1 = detectDagResynthLoop(
		history,
		opts.dagSynthesizeToolName,
		opts.resynthThreshold,
		opts.stuckIntervalMs,
		options.errorHistory,
		options.lastAssistantMessage,
	);
	if (f1) findings.push(f1);

	const f2 = detectDispatchNoAudit(counters);
	if (f2) findings.push(f2);

	const f3 = detectTransitionSkipFailed(history, opts.taskDispatchToolName, opts.loadDagPlan);
	if (f3) findings.push(f3);

	const f4 = detectGoalDrift(history, opts.loadGoalScope);
	if (f4) findings.push(f4);

	const f5 = detectNoProgressNoAudit(counters, history, opts.progressThreshold);
	if (f5) findings.push(f5);

	// GC-2026-059: general "stuck on same call" detector. Fires when any
	// (tool, args) chain-key is at length ≥ repeatThreshold. Mirror of
	// dsh's `repeat-tool-reminder`. Threshold defaults to 3 (matching
	// dsh's first-level nudge). Can be lower than the dag_resynth_loop
	// threshold because this is the more general rule. The interval gate
	// (stuckIntervalMs) prevents false positives on retries-with-thinking.
	const f6 = detectRepeatCallChain(history, opts.repeatThreshold, opts.stuckIntervalMs, options.errorHistory, options.lastAssistantMessage);
	if (f6) findings.push(f6);

	// Sort by severity (critical > major > minor).
	findings.sort((a, b) => sevRank[b.severity] - sevRank[a.severity]);
	return findings;
}

/** Truncate a string to fit within the token cap. Adds "..." when truncated.
 *  Approximate 4 chars/token heuristic — exact counts are not needed for
 *  advisory text. */
function truncateToTokens(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	return text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - 3)) + "...";
}

/**
 * Format advisory entries for the orchestrator. Mirrors subagent advisory's
 *  `advisoryFor`: severity filter + dedup + per-severity budget + per-token
 *  cap, but operating on tool-call history instead of message text.
 *
 *  Returns 0..N structured entries (text + rule + severity). Each is capped
 *  at ADVISORY_MAX_TOKENS tokens. The format includes the severity and a
 *  per-severity N/M counter so the LLM knows which budget slot this is.
 *
 *  The function does NOT mutate `ctx` — the caller increments
 *  `ctx.alreadyAdvisedRules` and `ctx.advisoriesBySeverity[severity]` for
 *  each returned entry. This keeps the function pure and lets tests
 *  assert on the returned entries without state surprises.
 */
/**
 * Pre-tool hook decision. Projects `upcoming` onto `history` and runs
 * the detector pipeline. If a CRITICAL finding would fire as a result of
 * the upcoming call, return `{ block: true, reason: ... }` so the
 * extension's tool_call handler can prevent execution. Major findings
 * are NOT pre-blocked — they emit advisory text after the call, not
 * before. The block is the strongest possible gate: critical mistakes
 * must not happen at all.
 */
export function preToolBlockDecision(
	upcoming: OrchestratorToolCall,
	history: OrchestratorToolCall[],
	options: OrchestratorAdvisoryOptions = {},
): { block: true; reason: string } | undefined {
	const projected = [...history, upcoming];
	const findings = extractOrchestratorFindings(projected, options);
	const critical = findings.find((f) => f.severity === "critical");
	if (!critical) return undefined;
	const fixText = RULE_FIX_DIRECTIVES[critical.rule];
	const reason = `[orchestrator audit advisory — critical] [pre-tool block] ${critical.rule}: ${critical.issue}. Fix: ${fixText}. Evidence: ${critical.evidence}`;
	return { block: true, reason };
}

export function orchestratorAdvisoryFor(
	history: OrchestratorToolCall[],
	ctx: OrchestratorAdvisoryContext = {
		alreadyAdvisedRules: new Set<string>(),
		advisoriesBySeverity: { critical: 0, major: 0, minor: 0 },
	},
	options: OrchestratorAdvisoryOptions = {},
): L1AdvisoryEntry[] {
	const budget = {
		...DEFAULT_ADVISORY_BUDGET_BY_SEVERITY,
		...options.maxAdvisoriesBySeverity,
	};

	const findings = extractOrchestratorFindings(history, options);

	// Project the per-severity counts as we add to `eligible`. This way we
	// stop accepting findings of a severity once the budget is consumed,
	// even when several findings of the same severity fire in one call.
	const projected: Record<L1Severity, number> = {
		critical: ctx.advisoriesBySeverity.critical ?? 0,
		major: ctx.advisoriesBySeverity.major ?? 0,
		minor: ctx.advisoriesBySeverity.minor ?? 0,
	};
	const eligible: L1Finding[] = [];
	for (const f of findings) {
		if (ctx.alreadyAdvisedRules.has(f.rule)) continue;
		const cap = budget[f.severity];
		if ((projected[f.severity] ?? 0) >= cap) continue;
		eligible.push(f);
		projected[f.severity] = (projected[f.severity] ?? 0) + 1;
	}

	const out: L1AdvisoryEntry[] = [];
	for (const f of eligible) {
		const sevCount = ctx.advisoriesBySeverity[f.severity] ?? 0;
		const sevPosition = sevCount + out.filter((e) => e.severity === f.severity).length + 1;
		const cap = budget[f.severity];
		const capLabel = cap === Number.POSITIVE_INFINITY ? "∞" : String(cap);
		const fixText = RULE_FIX_DIRECTIVES[f.rule];
		const text = `[orchestrator audit advisory — ${f.severity} ${sevPosition}/${capLabel}] ${f.rule}: ${f.issue}. Fix: ${fixText}. Evidence: ${f.evidence}`;
		const capped = truncateToTokens(text, ADVISORY_MAX_TOKENS);
		out.push({ text: capped, rule: f.rule, severity: f.severity });
	}

	return out;
}
// =============================================================================
// L1 Advisory wiring (post-tool, pre-tool, tool_result, message_end)
// =============================================================================

/**
 * External loaders the L1 detector consults to enrich its advisory context
 * (goal scope, dag plan status). The conductor in `@sages/pi` supplies the
 * real ones; tests can stub them.
 */
export interface L1AdvisoryRuntimeDeps {
	loadGoalScope?: (goalId: string, cwd: string) => { goal_id: string; scope_include: string[]; scope_exclude: string[] } | null;
	loadDagPlan?: (dagId: string, cwd: string) => DagPlanSnapshot | null;
}

/** No-op loaders used when no runtime deps are provided (e.g. isolated unit tests). */
const NOOP_DEPS: Required<L1AdvisoryRuntimeDeps> = {
	loadGoalScope: () => null,
	loadDagPlan: () => null,
};

/**
 * Install the four event listeners that drive the L1 orchestrator advisory
 * pipeline (GC-2026-053). Returns a handle the caller can use to inspect
 * advisory state (alreadyAdvisedRules, per-severity budget counters,
 * rolling history length) for assertions.
 *
 * Listeners registered (in order, registration order matters because pi's
 * pre-tool short-circuit applies handlers left-to-right):
 *   1. tool_call  pre-tool blocker  — `preToolBlockDecision` returns
 *                                    `{ block, reason }` on critical findings
 *   2. tool_call  post-call history  — pushes to `l1History`, calls
 *                                    `orchestratorAdvisoryFor`, fires
 *                                    `pi.appendEntry("system", ...)` for each
 *   3. tool_result error tracker     — populates `errorHistory` keyed by
 *                                    toolCallId
 *   4. message_end assistant-text    — captures `lastAssistantMessage` for
 *                                    retry-intent detection
 *
 * L1_HISTORY_CAP = 50 (≈5× the longest chain-detection threshold). LRU
 * eviction; only the most recent calls matter for repeat / resynth-loop
 * detection.
 */
export function installL1AdvisoryHandlers(
	pi: ExtensionAPI,
	runtime?: L1AdvisoryRuntimeDeps,
): {
	alreadyAdvisedRules: ReadonlySet<string>;
	advisoriesBySeverity: Readonly<Record<L1Severity, number>>;
	historyLength: () => number;
} {
	const deps: Required<L1AdvisoryRuntimeDeps> = { ...NOOP_DEPS, ...(runtime ?? {}) };
	const L1_HISTORY_CAP = 50;

	const l1History: OrchestratorToolCall[] = [];
	const errorHistory: OrchestratorToolResult[] = [];
	let lastAssistantMessage: string | null = null;
	const l1Ctx: OrchestratorAdvisoryContext = {
		alreadyAdvisedRules: new Set<string>(),
		advisoriesBySeverity: { critical: 0, major: 0, minor: 0 },
	};

	const advisoryOptions: OrchestratorAdvisoryOptions = {
		loadGoalScope: (goalId: string) => {
			const cwd = process.cwd();
			return deps.loadGoalScope(goalId, cwd);
		},
		loadDagPlan: (dagId: string) => {
			const cwd = process.cwd();
			return deps.loadDagPlan(dagId, cwd);
		},
	};

	// 1. Pre-tool blocker (must run before the post-tool history-tracker
	//    so a critical block short-circuits pi's tool_call loop without
	//    polluting the history with a call that never executed).
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

		const decision = preToolBlockDecision(upcoming, l1History, {
			...advisoryOptions,
			errorHistory,
			lastAssistantMessage: lastAssistantMessage ?? undefined,
		});
		if (decision) {
			const ruleMatch = decision.reason.match(/pre-tool block\] (\w+)/);
			const ruleId = ruleMatch?.[1];
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

	// 2. Post-tool history-tracker + advisory emitter.
	pi.on("tool_call", (event: any, _ctx: any) => {
		const toolName: string = event?.toolName;
		if (typeof toolName !== "string" || toolName.length === 0) return;
		const input =
			event?.input && typeof event.input === "object" ? event.input : {};
		l1History.push({ toolName, input, timestamp: Date.now() });
		if (l1History.length > L1_HISTORY_CAP) {
			l1History.splice(0, l1History.length - L1_HISTORY_CAP);
		}

		const advisories = orchestratorAdvisoryFor(l1History, l1Ctx, {
			...advisoryOptions,
			errorHistory,
			lastAssistantMessage: lastAssistantMessage ?? undefined,
		});
		for (const advisory of advisories) {
			pi.appendEntry("system", advisory.text);
			l1Ctx.alreadyAdvisedRules.add(advisory.rule);
			l1Ctx.advisoriesBySeverity[advisory.severity] =
				(l1Ctx.advisoriesBySeverity[advisory.severity] ?? 0) + 1;
		}
		return undefined;
	});

	// 3. tool_result error tracker.
	pi.on("tool_result", (event: any) => {
		const toolCallId: string | undefined =
			typeof event?.toolCallId === "string" ? event.toolCallId : undefined;
		const isError: boolean = event?.isError === true;
		if (!toolCallId) return;
		errorHistory.push({ toolCallId, isError });
		if (errorHistory.length > L1_HISTORY_CAP) errorHistory.shift();
	});

	// 4. message_end assistant-text capture.
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

	return {
		alreadyAdvisedRules: l1Ctx.alreadyAdvisedRules,
		advisoriesBySeverity: l1Ctx.advisoriesBySeverity,
		historyLength: () => l1History.length,
	};
}
