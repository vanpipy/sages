/**
 * orchestrator-advisory.ts — GC-2026-053 + GC-2026-059 (orchestrator-simplify)
 *
 * Orchestrator advisory mirror. Audits the orchestrator's tool-call stream
 * for governance issues. Mirrors the subagent advisory pattern from
 * `pi-subagents/src/agent-runner.ts:advisoryFor`.
 *
 * After GC-2026-orchestrator-simplify the orchestrator owns only one
 * tool (`goal_contract_create`), so DAG/audit/dispatch-specific rules
 * (`dag_resynth_loop`, `dispatch_no_audit`, `transition_skip_failed`,
 * `no_progress_no_audit`) are removed — they were tied to the deleted
 * orchestrator tools. Two general-purpose detectors remain:
 *
 *   - repeat_call_chain     — same (tool, args) chain-key seen ≥ N times
 *                              within stuckIntervalMs. General stuck-on-same-call
 *                              detector; mirrors deepseek-harness's
 *                              `repeat-tool-reminder` chain-key semantics.
 *   - goal_drift_detected   — any tool call references paths that fall
 *                              outside the active goal contract's
 *                              scope.include (and not in scope.exclude).
 *
 * Output contract mirrors the subagent advisory exactly:
 *
 *   [orchestrator advisory — N/M] <rule>: <issue>. Fix: <directive>.
 *
 * Filters:
 *   - severity: only major + critical
 *   - dedup: skip rules already in ctx.alreadyAdvisedRules
 *   - cap: at most ADVISORY_MAX_PER_DISPATCH advisories per call
 *   - token cap: per-advisory text is truncated to ADVISORY_MAX_TOKENS
 */

export type OrchestratorAdvisorySeverity = "minor" | "major" | "critical";

import {
	chainKey,
	tallyChainCounts,
	chainCountAtLeast,
	type ChainToolCall,
} from "./chain-key.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	classifyBashCommand,
	isConfigFileRead,
	isStructuralExploration,
} from "./bash-guard.js";

export type OrchestratorAdvisoryRuleId =
	| "goal_drift_detected"
	| "repeat_call_chain";

export interface OrchestratorAdvisoryFinding {
	rule: OrchestratorAdvisoryRuleId;
	severity: OrchestratorAdvisorySeverity;
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

export interface OrchestratorAdvisoryContext {
	/** Rules already advised in this process. Used to fire-once dedup
	 *  per rule ID — the same mistake must not nag the LLM repeatedly. */
	alreadyAdvisedRules: Set<string>;
	/** Per-severity counters — compared against
	 *  DEFAULT_ADVISORY_BUDGET_BY_SEVERITY (or the override passed via
	 *  options.maxAdvisoriesBySeverity). The extension process owns
	 *  this map; orchestratorAdvisoryFor reads it but never mutates it. */
	advisoriesBySeverity: Record<OrchestratorAdvisorySeverity, number>;
}

export interface OrchestratorAdvisoryOptions {
	/** Threshold for repeat_call_chain (default: 3). */
	repeatThreshold?: number;
	/** Stuck-interval ceiling for chain-loop detection (ms). A chain
	 *  is only considered "stuck" if every interval between consecutive
	 *  calls is below this threshold. Defaults to 2000ms — LLM thinking
	 *  time between retries typically exceeds this; genuine stuck loops
	 *  fire sub-second. Use this to suppress false positives where the
	 *  LLM is intentionally retrying with reasoning in between. */
	stuckIntervalMs?: number;
	/** Recent tool-result outcomes keyed by toolCallId. When provided,
	 *  detectors that fire on stuck patterns (repeat_call_chain)
	 *  require every call in the chain to have errored. A successful
	 *  call in the chain means the LLM is intentionally re-running
	 *  for a reason other than failure — typical of retries-with-fix-not-yet-deployed,
	 *  or refresh after state changes. Use this to suppress false
	 *  positives. */
	errorHistory?: OrchestratorToolResult[];
	/** Text of the last assistant message. When provided, detectors
	 *  scan for retry-intent markers (e.g. "retrying", "amending the
	 *  goal") and suppress stuck-loop advisories if the LLM has
	 *  clearly signalled intent to retry with reasoning. Use this to
	 *  suppress false positives on thoughtful retries. */
	lastAssistantMessage?: string;
	/** Loader for the active goal contract (used by goal_drift_detected). */
	loadGoalScope?: (goalId: string) => GoalScopeSnapshot | null;
	/** Per-severity cap override. Merged on top of
	 *  DEFAULT_ADVISORY_BUDGET_BY_SEVERITY. Set a severity to
	 *  `Number.POSITIVE_INFINITY` to disable its cap entirely. */
	maxAdvisoriesBySeverity?: Partial<Record<OrchestratorAdvisorySeverity, number>>;
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
 * - **major** = 4 — bounded to avoid LLM noise.
 * - **minor** = 0 — hard-filtered regardless of override.
 *
 * Overridable via `options.maxAdvisoriesBySeverity`. Set to
 * `Number.POSITIVE_INFINITY` to disable a severity's cap.
 */
export const DEFAULT_ADVISORY_BUDGET_BY_SEVERITY: Record<OrchestratorAdvisorySeverity, number> = {
	critical: Number.POSITIVE_INFINITY,
	major: 4,
	minor: 0,
};

export const ADVISORY_MIN_SEVERITY: OrchestratorAdvisorySeverity = "major";

/** Per-rule actionable fix text. */
export const RULE_FIX_DIRECTIVES: Record<OrchestratorAdvisoryRuleId, string> = {
	goal_drift_detected:
		"Check whether the paths you wrote are inside the active goal contract's scope.include; if they are new files, call goal_contract_create to amend scope.include before continuing",
	repeat_call_chain:
		"You called the same tool with identical args ≥3 times — this indicates you are stuck. Stop, re-read the last result, and decide whether to change approach or conclude. Do not keep repeating the same call",
};

// =============================================================================
// Finding extractors
// =============================================================================

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
 *  `isError=true`. Returns true (eligible) when no
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
		if (!c.callId) continue;
		const outcome = errorByCallId.get(c.callId);
		if (outcome === undefined) continue;
		if (!outcome) return false;
	}
	return true;
}

const RETRY_INTENT_PATTERNS: RegExp[] = [
	/\bretrying\b/i,
	/\bre-?attempt/i,
	/\bamending (?:the )?(?:goal|contract)/i,
	/\bfixing (?:the )?(?:issue|problem|error)/i,
	/\btrying again\b/i,
	/\blet me (?:try|retry|amend|fix)/i,
];

function showsRetryIntent(text: string | undefined): boolean {
	if (!text) return false;
	return RETRY_INTENT_PATTERNS.some((p) => p.test(text));
}

/** Compute the maximum interval (ms) between consecutive calls in a chain. */
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

/** Detect `repeat_call_chain`: same (tool, args) called ≥ threshold times
 *  AND all intervals below `stuckIntervalMs`. */
function detectRepeatCallChain(
	history: OrchestratorToolCall[],
	threshold: number,
	stuckIntervalMs: number,
	errorHistory: OrchestratorToolResult[] | undefined,
	lastAssistantMessage: string | undefined,
): OrchestratorAdvisoryFinding | null {
	const byChain = groupCallsByChainKey(history);

	let top: { chain: OrchestratorToolCall[]; count: number; sample: ChainToolCall } | null = null;
	for (const chain of byChain.values()) {
		if (chain.length < threshold) continue;
		if (maxIntervalInChain(chain) >= stuckIntervalMs) continue;
		if (!chainAllErrored(chain, errorHistory)) continue;
		if (top === null || chain.length > top.count) {
			top = { chain, count: chain.length, sample: { toolName: chain[0]!.toolName, input: chain[0]!.input } };
		}
	}
	if (!top) return null;
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

/** Detect `goal_drift_detected`: any tool call references paths that fall outside
 *  the active goal contract's scope.include (and not in scope.exclude). */
function detectGoalDrift(
	history: OrchestratorToolCall[],
	loadGoalScope: ((goalId: string) => GoalScopeSnapshot | null) | undefined,
): OrchestratorAdvisoryFinding | null {
	if (!loadGoalScope) return null;
	for (const call of history) {
		// Scan tools that carry explicit path-bearing fields. We avoid
		// anchoring on `read`/`bash` because their paths are noisy and
		// most legitimate (e.g. reading AGENTS.md for project context).
		const paths = extractPathsFromInput(call.toolName, call.input);
		if (paths.length === 0) continue;

		const goalId = (call.input.goal_id as string | undefined)
			?? (call.input.id as string | undefined);
		if (typeof goalId !== "string") continue;

		const scope = loadGoalScope(goalId);
		if (!scope) continue;

		const outOfScope: string[] = [];
		for (const p of paths) {
			if (!isPathInScope(p, scope)) outOfScope.push(p);
		}
		if (outOfScope.length > 0) {
			return {
				rule: "goal_drift_detected",
				severity: "major",
				issue: `${outOfScope.length} path(s) reference entries outside goal ${goalId}'s scope.include`,
				evidence: outOfScope.slice(0, 5).join(", "),
				recommendation:
					"either rewrite the action to use in-scope paths, or amend goal_contract scope.include before continuing",
			};
		}
	}
	return null;
}

/** Best-effort path extraction from a tool call's input. Conservative —
 *  only inspects well-known fields. Returns empty array when no path
 *  field is present, so the detector skips the call rather than firing
 *  on noise. */
function extractPathsFromInput(toolName: string, input: Record<string, unknown>): string[] {
	if (toolName === "write" || toolName === "edit" || toolName === "read") {
		const p = (input as { path?: unknown; file_path?: unknown }).path
			?? (input as { file_path?: unknown }).file_path;
		return typeof p === "string" ? [p] : [];
	}
	if (toolName === "write") {
		const p = (input as { file_path?: unknown }).file_path;
		return typeof p === "string" ? [p] : [];
	}
	if (toolName === "bash") {
		// Heuristic: skip bash because path extraction is unreliable and
		// most legitimate bash calls touch many paths. Returning empty
		// here is intentional — the bash-nudge system handles the
		// codebase/ctx promotion path separately.
		return [];
	}
	return [];
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

// =============================================================================
// Family classifier + family-mix reminder (GC-2026-087 SC3)
// =============================================================================

export type ToolFamily =
	| "aft"
	| "codebase"
	| "ctx"
	| "baseline"
	| "subagent_control"
	| "orchestrator"
	| "tasks"
	| "other";

export function familyOfTool(toolName: string): ToolFamily {
	if (toolName.startsWith("aft_")) return "aft";
	if (toolName.startsWith("codebase_memory_")) return "codebase";
	if (toolName.startsWith("ctx_")) return "ctx";
	if (
		toolName === "bash" ||
		toolName === "read" ||
		toolName === "edit" ||
		toolName === "write" ||
		toolName === "grep" ||
		toolName === "find" ||
		toolName === "ls" ||
		toolName === "bash_status" ||
		toolName === "bash_watch" ||
		toolName === "bash_kill" ||
		toolName === "bash_write" ||
		toolName === "ast_grep_search" ||
		toolName === "ast_grep_replace"
	) {
		return "baseline";
	}
	if (
		toolName === "Agent" ||
		toolName === "get_subagent_result" ||
		toolName === "steer_subagent" ||
		toolName === "subagent_status" ||
		toolName === "subagent_steer" ||
		toolName === "subagent_abort" ||
		toolName === "subagent_resume"
	) {
		return "subagent_control";
	}
	// GC-2026-097 M3a: orchestrator tools. The four DAG/audit/dispatch/
	// reminder tools were already removed by GC-2026-orchestrator-simplify.
	// GC-2026-remove-workflow-run-prod: workflow_run removed (100% failure
	// rate on the 10s watchdog across the last 6 GCs); only goal_contract_create
	// + decompose_task remain in the orchestrator family.
	if (toolName === "goal_contract_create" || toolName === "decompose_task") {
		return "orchestrator";
	}
	// GC-2026-097 M3b: the 7 pi-tasks tools form their own family so
	// the family-mix reminder doesn't dilute baseline ratio when an LLM
	// is driving a workflow via TaskCreate / TaskExecute.
	if (
		toolName === "TaskCreate" ||
		toolName === "TaskList" ||
		toolName === "TaskGet" ||
		toolName === "TaskUpdate" ||
		toolName === "TaskOutput" ||
		toolName === "TaskStop" ||
		toolName === "TaskExecute"
	) {
		return "tasks";
	}
	return "other";
}

/** Empty counter initializer. */
export function emptyFamilyCounts(): Record<ToolFamily, number> {
	return {
		aft: 0,
		codebase: 0,
		ctx: 0,
		baseline: 0,
		subagent_control: 0,
		orchestrator: 0,
		tasks: 0,
		other: 0,
	};
}

/** Decide whether the family-mix reminder should fire given the
 *  current family counters. Pure — no side effects. Returns the
 *  reminder text if conditions are met, `null` otherwise. */
export function familyMixReminderText(
	familyCounts: Readonly<Record<ToolFamily, number>>,
): string | null {
	const sumAll =
		familyCounts.aft +
		familyCounts.codebase +
		familyCounts.ctx +
		familyCounts.baseline +
		familyCounts.subagent_control +
		familyCounts.orchestrator +
		familyCounts.tasks +
		familyCounts.other;
	if (sumAll < 10) return null;
	if (sumAll === 0) return null;
	const baselineRatio = familyCounts.baseline / sumAll;
	const specializedRatio =
		(familyCounts.aft + familyCounts.codebase + familyCounts.ctx) / sumAll;
	if (baselineRatio <= 0.8) return null;
	if (specializedRatio >= 0.05) return null;
	const pct = Math.round(baselineRatio * 100);
	return (
		`Tool-mix warning: ${pct}% of your ${sumAll} tool calls so far ` +
		`are baseline (bash/read/edit/write/grep/find/ls). ` +
		`Consider whether aft_search / codebase_memory_search_graph / ctx_search fit here.`
	);
}

// =============================================================================
// Public API
// =============================================================================

export interface OrchestratorAdvisoryEntry {
	text: string;
	rule: OrchestratorAdvisoryRuleId;
	severity: OrchestratorAdvisorySeverity;
}

/** Extract Orchestrator advisory findings from the orchestrator's tool-call history. */
export function extractOrchestratorFindings(
	history: OrchestratorToolCall[],
	options: OrchestratorAdvisoryOptions = {},
): OrchestratorAdvisoryFinding[] {
	const opts = {
		repeatThreshold: options.repeatThreshold ?? 3,
		stuckIntervalMs: options.stuckIntervalMs ?? DEFAULT_STUCK_INTERVAL_MS,
		loadGoalScope: options.loadGoalScope,
	};

	const findings: OrchestratorAdvisoryFinding[] = [];

	const sevRank: Record<OrchestratorAdvisorySeverity, number> = { minor: 0, major: 1, critical: 2 };

	const f1 = detectGoalDrift(history, opts.loadGoalScope);
	if (f1) findings.push(f1);

	const f2 = detectRepeatCallChain(
		history,
		opts.repeatThreshold,
		opts.stuckIntervalMs,
		options.errorHistory,
		options.lastAssistantMessage,
	);
	if (f2) findings.push(f2);

	findings.sort((a, b) => sevRank[b.severity] - sevRank[a.severity]);
	return findings;
}

/** Truncate a string to fit within the token cap. */
function truncateToTokens(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	return text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - 3)) + "...";
}

/** Pre-tool hook decision. Critical findings (currently none — orchestrator
 *  advisory is purely informational after GC-2026-orchestrator-simplify).
 *  Returns undefined to mean "allow". */
export function preToolBlockDecision(
	_upcoming: OrchestratorToolCall,
	_history: OrchestratorToolCall[],
	_options: OrchestratorAdvisoryOptions = {},
): { block: true; reason: string } | undefined {
	return undefined;
}

export function orchestratorAdvisoryFor(
	history: OrchestratorToolCall[],
	ctx: OrchestratorAdvisoryContext = {
		alreadyAdvisedRules: new Set<string>(),
		advisoriesBySeverity: { critical: 0, major: 0, minor: 0 },
	},
	options: OrchestratorAdvisoryOptions = {},
): OrchestratorAdvisoryEntry[] {
	const budget = {
		...DEFAULT_ADVISORY_BUDGET_BY_SEVERITY,
		...options.maxAdvisoriesBySeverity,
	};

	const findings = extractOrchestratorFindings(history, options);

	const projected: Record<OrchestratorAdvisorySeverity, number> = {
		critical: ctx.advisoriesBySeverity.critical ?? 0,
		major: ctx.advisoriesBySeverity.major ?? 0,
		minor: ctx.advisoriesBySeverity.minor ?? 0,
	};
	const eligible: OrchestratorAdvisoryFinding[] = [];
	for (const f of findings) {
		if (ctx.alreadyAdvisedRules.has(f.rule)) continue;
		const cap = budget[f.severity];
		if ((projected[f.severity] ?? 0) >= cap) continue;
		eligible.push(f);
		projected[f.severity] = (projected[f.severity] ?? 0) + 1;
	}

	const out: OrchestratorAdvisoryEntry[] = [];
	for (const f of eligible) {
		const sevCount = ctx.advisoriesBySeverity[f.severity] ?? 0;
		const sevPosition = sevCount + out.filter((e) => e.severity === f.severity).length + 1;
		const cap = budget[f.severity];
		const capLabel = cap === Number.POSITIVE_INFINITY ? "∞" : String(cap);
		const fixText = RULE_FIX_DIRECTIVES[f.rule];
		const text = `[orchestrator advisory — ${f.severity} ${sevPosition}/${capLabel}] ${f.rule}: ${f.issue}. Fix: ${fixText}. Evidence: ${f.evidence}`;
		const capped = truncateToTokens(text, ADVISORY_MAX_TOKENS);
		out.push({ text: capped, rule: f.rule, severity: f.severity });
	}

	return out;
}

// =============================================================================
// Orchestrator advisory wiring (post-tool, pre-tool, tool_result, message_end)
// =============================================================================

export interface OrchestratorAdvisoryRuntimeDeps {
	loadGoalScope?: (goalId: string, cwd: string) => { goal_id: string; scope_include: string[]; scope_exclude: string[] } | null;
}

const NOOP_DEPS: Required<OrchestratorAdvisoryRuntimeDeps> = {
	loadGoalScope: () => null,
};

export function installOrchestratorAdvisoryHandlers(
	pi: ExtensionAPI,
	runtime?: OrchestratorAdvisoryRuntimeDeps,
): {
	alreadyAdvisedRules: ReadonlySet<string>;
	advisoriesBySeverity: Readonly<Record<OrchestratorAdvisorySeverity, number>>;
	historyLength: () => number;
} {
	const deps: Required<OrchestratorAdvisoryRuntimeDeps> = { ...NOOP_DEPS, ...(runtime ?? {}) };
	const ORCHESTRATOR_ADVISORY_HISTORY_CAP = 50;

	const orchestratorHistory: OrchestratorToolCall[] = [];
	const errorHistory: OrchestratorToolResult[] = [];
	let lastAssistantMessage: string | null = null;
	const l1Ctx: OrchestratorAdvisoryContext = {
		alreadyAdvisedRules: new Set<string>(),
		advisoriesBySeverity: { critical: 0, major: 0, minor: 0 },
	};
	const familyCounts: Record<ToolFamily, number> = emptyFamilyCounts();

	const advisoryOptions: OrchestratorAdvisoryOptions = {
		loadGoalScope: (goalId: string) => {
			const cwd = process.cwd();
			return deps.loadGoalScope(goalId, cwd);
		},
	};

	// GC-2026-097 L4: reset all closure-scoped advisory state on each
	// session_start. The orchestrator extension is loaded once per pi
	// process (not per session); without this reset, alreadyAdvisedRules
	// accumulates across sessions in long-lived processes and permanently
	// silences nudges after the first session fires them. Tests pin this
	// behavior at orchestrator-advisory.test.ts#L4-1.
	const resetAdvisoryState = () => {
		orchestratorHistory.length = 0;
		errorHistory.length = 0;
		lastAssistantMessage = null;
		l1Ctx.alreadyAdvisedRules.clear();
		l1Ctx.advisoriesBySeverity.critical = 0;
		l1Ctx.advisoriesBySeverity.major = 0;
		l1Ctx.advisoriesBySeverity.minor = 0;
		for (const key of Object.keys(familyCounts)) {
			(familyCounts as Record<string, number>)[key] = 0;
		}
	};
	pi.on("session_start", () => {
		resetAdvisoryState();
	});

	// Pre-tool blocker (no-op after orchestrator-simplify — no critical
	// orchestrator rules remain; subagent advisory still owns the
	// dispatch / execution side).
	pi.on("tool_call", (event: any, _ctx: any) => {
		const toolName: string = event?.toolName;
		if (typeof toolName !== "string" || toolName.length === 0) return;
		const input =
			event?.input && typeof event.input === "object" ? event.input : {};
		const upcoming: OrchestratorToolCall = {
			toolName,
			input,
			timestamp: Date.now(),
		};

		const decision = preToolBlockDecision(upcoming, orchestratorHistory, {
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

	// Post-tool history-tracker + advisory emitter.
	pi.on("tool_call", (event: any, _ctx: any) => {
		const toolName: string = event?.toolName;
		if (typeof toolName !== "string" || toolName.length === 0) return;
		const input =
			event?.input && typeof event.input === "object" ? event.input : {};
		orchestratorHistory.push({ toolName, input, timestamp: Date.now() });
		if (orchestratorHistory.length > ORCHESTRATOR_ADVISORY_HISTORY_CAP) {
			orchestratorHistory.splice(0, orchestratorHistory.length - ORCHESTRATOR_ADVISORY_HISTORY_CAP);
		}
		familyCounts[familyOfTool(toolName)] += 1;

		const advisories = orchestratorAdvisoryFor(orchestratorHistory, l1Ctx, {
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

		// GC-2026-075: AFT promotion nudge.
		if (toolName === "bash" && !l1Ctx.alreadyAdvisedRules.has("aft-search-nudge")) {
			const command = (input as { command?: unknown }).command;
			if (typeof command === "string" && command.length > 0) {
				const classification = classifyBashCommand(command);
				if (classification === "code-search") {
					pi.appendEntry(
						"system",
						"💡 Read-only code search detected. Consider `aft_search({ query: " +
							'"' + "<your query>" + '"' + " })` for an indexed, ranked single-call replacement.",
					);
					l1Ctx.alreadyAdvisedRules.add("aft-search-nudge");
				}
			}
		}

		// GC-2026-087 SC2: codebase promotion nudge.
		if (toolName === "bash" && !l1Ctx.alreadyAdvisedRules.has("codebase-search-nudge")) {
			const command = (input as { command?: unknown }).command;
			if (typeof command === "string" && command.length > 0) {
				if (isStructuralExploration(command)) {
					pi.appendEntry(
						"system",
						"💡 Structural file-tree exploration detected. Consider `codebase_memory_search_graph({ query: " +
							'"' + "<structural question — e.g. 'modules in src/', 'callers of X'>" + '"' +
							" })` for a graph-aware structural map.",
					);
					l1Ctx.alreadyAdvisedRules.add("codebase-search-nudge");
				}
			}
		}

		// GC-2026-087 SC2: ctx promotion nudge.
		if (toolName === "bash" && !l1Ctx.alreadyAdvisedRules.has("ctx-search-nudge")) {
			const command = (input as { command?: unknown }).command;
			if (typeof command === "string" && command.length > 0) {
				if (isConfigFileRead(command)) {
					pi.appendEntry(
						"system",
						"💡 Project-knowledge file read detected. Consider `ctx_search({ query: " +
							'"' + "<prior decisions / conventions relevant to this file>" + '"' +
							" })` first — prior sessions may have already captured this knowledge.",
					);
					l1Ctx.alreadyAdvisedRules.add("ctx-search-nudge");
				}
			}
		}

		// GC-2026-087 SC3: family-mix reminder.
		if (!l1Ctx.alreadyAdvisedRules.has("tool-mix-nudge")) {
			const reminderText = familyMixReminderText(familyCounts);
			if (reminderText !== null) {
				pi.appendEntry("system", reminderText);
				l1Ctx.alreadyAdvisedRules.add("tool-mix-nudge");
			}
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
		if (errorHistory.length > ORCHESTRATOR_ADVISORY_HISTORY_CAP) errorHistory.shift();
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
		historyLength: () => orchestratorHistory.length,
	};
}
