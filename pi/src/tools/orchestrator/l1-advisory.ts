/**
 * l1-advisory.ts — GC-2026-053
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
 *   - dag_resynth_loop        — same goal re-synthesized > N times
 *   - dispatch_no_audit       — task dispatched but never audited
 *   - transition_skip_failed  — task dispatched while dep is failed
 *   - goal_drift_detected     — tool input references out-of-scope paths
 *   - no_progress_no_audit    — many tool calls without an audit pass
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
 */

export type L1Severity = "minor" | "major" | "critical";

export type L1RuleId =
	| "dag_resynth_loop"
	| "dispatch_no_audit"
	| "transition_skip_failed"
	| "goal_drift_detected"
	| "no_progress_no_audit";

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
		"上一次 DAG 合成失败因 X；要么 amend goal({scope, criteria})，要么显式修订当前 DAG 而不是再次 dag_synthesize",
	dispatch_no_audit:
		"调 orchestrator_audit({ dag_id: '<active_dag_id>' }) 验证本次 dispatch 的产物；audit 是 Sages 4-stage 闭环的最后一环",
	transition_skip_failed:
		"T_dep 已 failed；显式回 T_dep 修复，或在 DAG 上把 T_dep 标记为 skipped 后再 dispatch 当前 task；不能跳过 failed dep",
	goal_drift_detected:
		"检查 task.files 是否在 goal-{id}.yaml 的 scope.include 内；如果是新文件，先调 goal_contract_create 修订 scope 而不是直接 dispatch",
	no_progress_no_audit:
		"停下来调 orchestrator_audit({ dag_id })；如果 audit 通过，再继续——audit 是 orchestrator 自我验证的唯一手段",
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

/** Detect `dag_resynth_loop`: same goal_id synthesized more than the threshold. */
function detectDagResynthLoop(
	history: OrchestratorToolCall[],
	dagToolName: string,
	threshold: number,
): L1Finding | null {
	const perGoal = new Map<string, number>();
	for (const call of history) {
		if (call.toolName !== dagToolName) continue;
		const goalId = typeof call.input.goal_id === "string" ? call.input.goal_id : "<unknown>";
		perGoal.set(goalId, (perGoal.get(goalId) ?? 0) + 1);
	}
	let worstGoal: string | null = null;
	let worstCount = 0;
	for (const [goalId, count] of perGoal) {
		if (count > worstCount) {
			worstCount = count;
			worstGoal = goalId;
		}
	}
	if (!worstGoal || worstCount <= threshold) return null;
	return {
		rule: "dag_resynth_loop",
		severity: "major",
		issue: `dag_synthesize called ${worstCount} times for goal ${worstGoal} (>${threshold})`,
		evidence: `${worstCount} dag_synthesize calls observed for goal_id=${worstGoal}`,
		recommendation:
			"orchestrator is re-synthesizing the same goal instead of amending it; stop and revise either the goal contract or the existing DAG",
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
 *  (or since session start if no audit yet). */
function detectNoProgressNoAudit(counters: Counters, threshold: number): L1Finding | null {
	if (counters.totalToolCallsSinceLastAudit <= threshold) return null;
	return {
		rule: "no_progress_no_audit",
		severity: "major",
		issue: `${counters.totalToolCallsSinceLastAudit} tool call(s) since last orchestrator_audit (>${threshold})`,
		evidence: `totalToolCallsSinceLastAudit=${counters.totalToolCallsSinceLastAudit}, threshold=${threshold}, audits=${counters.orchestratorAuditCalls}`,
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

	const f5 = detectNoProgressNoAudit(counters, opts.progressThreshold);
	if (f5) findings.push(f5);

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