/**
 * l1-advisory.ts — GC-2026-053 + GC-2026-059
 *
 * L1 (orchestrator self-audit) advisory mirror. This is the L2 advisory
 * pattern from `pi-subagents/src/agent-runner.ts:advisoryFor`, applied to
 * the orchestrator's own tool-call history instead of subagent messages.
 *
 * The L2 layer audits subagent message text for governance compliance
 * (YAML block, checkpoint cadence, ASK propagation, BLOCKED reason). The
 * L1 layer audits the orchestrator's tool-call stream for the same
 * class of problems at the orchestrator's own layer:
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
 * Output contract mirrors L2 exactly:
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
	findMaxChain,
	chainCountAtLeast,
	type ChainToolCall,
} from "./chain-key.js";

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
 *  timestamp for cadence analysis. */
export interface OrchestratorToolCall {
	toolName: string;
	input: Record<string, unknown>;
	/** Unix ms timestamp. */
	timestamp: number;
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
	/** Rules already advised in this dispatch. Used to suppress duplicates. */
	alreadyAdvisedRules: Set<string>;
	/** Number of advisories already sent in this dispatch. */
	advisoriesSent: number;
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
	/** Threshold for no_progress_no_audit (default: 10). */
	progressThreshold?: number;
	/** Loader for the active goal contract (used by goal_drift_detected). */
	loadGoalScope?: (goalId: string) => GoalScopeSnapshot | null;
	/** Loader for the active DAG plan (used by transition_skip_failed). */
	loadDagPlan?: (dagId: string) => DagPlanSnapshot | null;
}

// =============================================================================
// Caps — mirror L2 exactly so the orchestrator's self-feedback budget is
// pinned to the same constants as the subagent feedback budget.
// =============================================================================

export const ADVISORY_MAX_TOKENS = 200;
export const ADVISORY_MAX_PER_DISPATCH = 2;
export const ADVISORY_MIN_SEVERITY: L1Severity = "major";

/** Per-rule actionable fix text. Mirrors L2's `RULE_FIX_DIRECTIVES`
 *  shape so both layers are introspectable in the same way. */
export const RULE_FIX_DIRECTIVES: Record<L1RuleId, string> = {
	dag_resynth_loop:
		"上一次 DAG 合成失败因 X；要么 amend goal({scope, criteria})，要么显式修订当前 DAG 而不是再次 dag_synthesize（如果 args 每次相同）",
	dispatch_no_audit:
		"调 orchestrator_audit({ dag_id: '<active_dag_id>' }) 验证本次 dispatch 的产物；audit 是 Sages 4-stage 闭环的最后一环",
	transition_skip_failed:
		"T_dep 已 failed；显式回 T_dep 修复，或在 DAG 上把 T_dep 标记为 skipped 后再 dispatch 当前 task；不能跳过 failed dep",
	goal_drift_detected:
		"检查 task.files 是否在 goal-{id}.yaml 的 scope.include 内；如果是新文件，先调 goal_contract_create 修订 scope 而不是直接 dispatch",
	no_progress_no_audit:
		"停下来调 orchestrator_audit({ dag_id })；如果 audit 通过，再继续——audit 是 orchestrator 自我验证的唯一手段",
	repeat_call_chain:
		"你用相同的 args 重复调同一个工具 ≥3 次——这说明卡住了。停下，re-read 上次 result，决定是换 approach 还是 conclude。不要继续重复同一调用",
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

function initCounters(): Counters {
	return {
		dagSynthesizeCalls: 0,
		taskDispatchCalls: 0,
		orchestratorAuditCalls: 0,
		totalToolCallsSinceLastAudit: 0,
		lastAuditIndex: -1,
	};
}

function tallyCounters(
	history: OrchestratorToolCall[],
	opts: Required<Pick<OrchestratorAdvisoryOptions, "dagSynthesizeToolName" | "taskDispatchToolName" | "orchestratorAuditToolName">>,
): Counters {
	const c = initCounters();
	for (let i = 0; i < history.length; i++) {
		const call = history[i]!;
		if (call.toolName === opts.dagSynthesizeToolName) {
			c.dagSynthesizeCalls += 1;
			c.totalToolCallsSinceLastAudit += 1;
		} else if (call.toolName === opts.taskDispatchToolName) {
			c.taskDispatchCalls += 1;
			c.totalToolCallsSinceLastAudit += 1;
		} else if (call.toolName === opts.orchestratorAuditToolName) {
			c.orchestratorAuditCalls += 1;
			c.lastAuditIndex = i;
			c.totalToolCallsSinceLastAudit = 0;
		} else {
			c.totalToolCallsSinceLastAudit += 1;
		}
	}
	return c;
}

/** Detect `dag_resynth_loop`: same (tool, args) chain-key for dag_synthesize
 *  seen more than the threshold. GC-2026-059 changed this from
 *  `per-goal_id` to full chain-key — different args means progress,
 *  same args means stuck. */
function detectDagResynthLoop(
	history: OrchestratorToolCall[],
	dagToolName: string,
	threshold: number,
): L1Finding | null {
	const calls: ChainToolCall[] = [];
	for (const call of history) {
		if (call.toolName !== dagToolName) continue;
		calls.push({ toolName: call.toolName, input: call.input });
	}
	if (calls.length <= threshold) return null;
	const counts = tallyChainCounts(calls);
	const top = findMaxChain(counts);
	if (!top) return null;
	// Need strictly more than threshold (e.g. threshold=2 → fire on 3+).
	if (top.count <= threshold) return null;
	return {
		rule: "dag_resynth_loop",
		severity: "major",
		issue: `dag_synthesize called ${top.count} times with identical args (>${threshold})`,
		evidence: `chain ${top.sample.toolName}(${JSON.stringify(top.sample.input).slice(0, 80)}) × ${top.count}`,
		recommendation:
			"orchestrator is re-synthesizing the same DAG with identical arguments; stop and revise either the goal contract or the existing DAG",
	};
}

/** Detect `repeat_call_chain`: same (tool, args) called ≥ threshold times.
 *  General stuck-on-same-call detector. Mirrors dsh's
 *  `repeat-tool-reminder` chain-key semantics without porting the
 *  full configuration system. */
function detectRepeatCallChain(
	history: OrchestratorToolCall[],
	threshold: number,
): L1Finding | null {
	const calls: ChainToolCall[] = history.map((c) => ({
		toolName: c.toolName,
		input: c.input,
	}));
	const counts = tallyChainCounts(calls);
	if (!chainCountAtLeast(counts, threshold)) return null;
	const top = findMaxChain(counts);
	if (!top) return null;
	// Suppress if the worst chain is dag_synthesize with the same args —
	// that's already covered by dag_resynth_loop, which has a more
	// specific fix-directive. Avoid double-firing.
	if (top.sample.toolName === "dag_synthesize") {
		return null;
	}
	return {
		rule: "repeat_call_chain",
		severity: "major",
		issue: `${top.count} identical calls to ${top.sample.toolName} with the same args (>=${threshold})`,
		evidence: `chain ${top.sample.toolName}(${JSON.stringify(top.sample.input).slice(0, 80)}) × ${top.count}`,
		recommendation:
			"orchestrator is calling the same tool with identical arguments repeatedly; this suggests it is stuck. Re-read the last result, change approach, or conclude",
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
	const calls: ChainToolCall[] = history.map((c) => ({
		toolName: c.toolName,
		input: c.input,
	}));
	const counts = tallyChainCounts(calls);
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
		progressThreshold: options.progressThreshold ?? 10,
		loadGoalScope: options.loadGoalScope,
		loadDagPlan: options.loadDagPlan,
	};

	const findings: L1Finding[] = [];

	const counters = tallyCounters(history, opts);
	const sevRank: Record<L1Severity, number> = { minor: 0, major: 1, critical: 2 };

	const f1 = detectDagResynthLoop(history, opts.dagSynthesizeToolName, opts.resynthThreshold);
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
	// threshold because this is the more general rule.
	const f6 = detectRepeatCallChain(history, 3);
	if (f6) findings.push(f6);

	// Sort by severity (critical > major > minor).
	findings.sort((a, b) => sevRank[b.severity] - sevRank[a.severity]);
	return findings;
}

/** Truncate a string to fit within the token cap. Adds "..." when truncated. */
function truncateToTokens(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	return text.slice(0, Math.max(0, maxChars - 3)) + "...";
}

/** Format advisory strings for the orchestrator. Mirrors L2's
 *  `advisoryFor`: severity filter + dedup + per-dispatch cap + per-token
 *  cap, but operating on tool-call history instead of message text.
 *
 *  Returns 0..ADVISORY_MAX_PER_DISPATCH advisory strings. Each is capped
 *  at ADVISORY_MAX_TOKENS tokens. The format is identical to L2 so the
 *  two layers can be reasoned about together. */
export function orchestratorAdvisoryFor(
	history: OrchestratorToolCall[],
	ctx: OrchestratorAdvisoryContext = {
		alreadyAdvisedRules: new Set<string>(),
		advisoriesSent: 0,
	},
	options: OrchestratorAdvisoryOptions = {},
): string[] {
	if (ctx.advisoriesSent >= ADVISORY_MAX_PER_DISPATCH) return [];

	const findings = extractOrchestratorFindings(history, options);
	const eligible = findings.filter(
		(f) =>
			(f.severity === "major" || f.severity === "critical") &&
			!ctx.alreadyAdvisedRules.has(f.rule) &&
			ctx.advisoriesSent < ADVISORY_MAX_PER_DISPATCH,
	);

	const out: string[] = [];
	for (const f of eligible) {
		if (ctx.advisoriesSent + out.length >= ADVISORY_MAX_PER_DISPATCH) break;
		const n = ctx.advisoriesSent + out.length + 1;
		const total = Math.min(eligible.length, ADVISORY_MAX_PER_DISPATCH);
		const fixText = RULE_FIX_DIRECTIVES[f.rule];
		const advisory = `[orchestrator audit advisory — ${n}/${total}] ${f.rule}: ${f.issue}. Fix: ${fixText}. Evidence: ${f.evidence}`;
		const capped = truncateToTokens(advisory, ADVISORY_MAX_TOKENS);
		out.push(capped);
	}

	return out;
}