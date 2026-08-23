/**
 * pi-evaluator/src/engine/coefficients-defaults.ts
 *
 * Built-in default coefficients. Used when the user's
 * `~/.pi/agent/evaluator-log/coefficients.json` does not exist (first run
 * with reward mode enabled).
 *
 * Two important invariants:
 *   1. `version` is set from `PI_EVALUATOR_VERSION` at module-load time —
 *      so defaults always match the running pi-evaluator release.
 *   2. All weights satisfy the Σ = 1.0 invariants checked by
 *      `validateInvariants()`. Any default change that breaks this will
 *      cause the loader to throw on first run — that's intentional (fail
 *      loud, not silent).
 *
 * v0.3.0 change: 7 disabled (weight=0) signal-name placeholders added — one
 * per metric that T2-T4 ship. Users opt-in by setting `weight > 0` in their
 * override file. The default scoring is byte-identical to v0.2.0 because
 * weight=0 placeholders contribute 0 to the weighted sum.
 *
 * To tune: copy `examples/evaluator-log/coefficients.json` to
 * `~/.pi/agent/evaluator-log/coefficients.json` and edit. The file path
 * the loader looks at is documented in `src/engine/coefficients.ts`.
 */
import { PI_EVALUATOR_VERSION } from "./package-version.ts";
import type { CoefficientsConfig } from "./coefficients-schema.ts";

/**
 * Built-in v0.3.0 defaults. Σ weights per dimension = 1.0 (placeholders
 * contribute 0); Σ dimension_weights = 1.0; thresholds: pass ≥ 80,
 * pass_with_gaps ≥ 50.
 *
 * What each signal represents is documented in SKILL.md §"Signal catalog".
 */
export const DEFAULT_COEFFICIENTS: CoefficientsConfig = {
	version: PI_EVALUATOR_VERSION,

	global: {
		dimension_weights: {
			goal: 0.20,
			dag: 0.20,
			implement: 0.30,
			audit: 0.20,
			coordination: 0.10,
		},
		thresholds: {
			pass: 80,
			pass_with_gaps: 50,
		},
	},

	dimensions: {
		goal: {
			signals: {
				// ratio of SCs that have a runnable verification_cmd (cmd is non-empty + parses)
				sc_verifiable_pct: {
					weight: 0.40,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// 1 if anti_goals list is non-empty, else 0 — anti-goals are a sign the
				// author thought about non-goals (a quality marker, not a defect signal).
				anti_goals_present: {
					weight: 0.20,
					norm: "boolean",
					direction: "higher_better",
				},
				// log_count of scope.include dirs — penalize very broad scopes (focus) and
				// very narrow ones (premature lockdown); inverted so "moderate breadth" scores high.
				scope_breadth: {
					weight: 0.20,
					norm: "invert_log_count",
					direction: "lower_better",
				},
				// SC count via log_count — penalize both too-few (under-decomposed) and
				// too-many (over-decomposed); the natural optimum is a moderate number.
				sc_count_norm: {
					weight: 0.20,
					norm: "log_count",
					direction: "higher_better",
				},
			},
		},

		dag: {
			signals: {
				// ratio of SCs covered by at least one task (sc → task traceability)
				sc_to_task_coverage_pct: {
					weight: 0.35,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// ratio of batches that are parallel_safe (batch size <= global cap)
				batch_parallelism_ratio: {
					weight: 0.20,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// 0 if no cycles, decays to 0 as cycle count grows. Critical structural quality.
				acyclic: {
					weight: 0.25,
					norm: "boolean",
					direction: "higher_better",
				},
				// within-batch independence: 1 if no task in the same batch depends on another
				within_batch_independence_pct: {
					weight: 0.20,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// DISABLED placeholder (T2 ships the metric; opt-in via override).
				// Heuristic: n-gram match between task report text and DAG's acceptance.covers[].
				plan_adherence: {
					weight: 0,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// DISABLED placeholder (T4 ships the metric; opt-in via override).
				// LLM-only: subjective quality of the DAG plan itself.
				plan_quality: {
					weight: 0,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
			},
		},

		implement: {
			signals: {
				// ratio of tasks that pass their verification_cmd on first try (proxy for
				// TDD discipline + code quality)
				verification_first_try_rate: {
					weight: 0.40,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// ratio of tasks that adhere to the managed-worktree isolation policy
				isolation_adherence_pct: {
					weight: 0.30,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// log-scaled task count per SC — penalize both under-split and over-split
				tasks_per_sc_norm: {
					weight: 0.30,
					norm: "log_count",
					direction: "higher_better",
				},
				// DISABLED placeholder (T2 ships the metric; opt-in via override).
				// Heuristic: tool calls where toolResult.isError === true, by tool name.
				argument_correctness: {
					weight: 0,
					norm: "ratio_0_1",
					direction: "lower_better",
				},
				// DISABLED placeholder (T3/T4 ship the metric; opt-in via override).
				// Heuristic+LLM hybrid: covers[] fully verified by audit (heuristic branch).
				task_completion: {
					weight: 0,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// DISABLED placeholder (T4 ships the metric; opt-in via override).
				// LLM-only: quality of tool usage (judges intent + correctness together).
				tool_use: {
					weight: 0,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// DISABLED placeholder (GC-2026-066 ships the metric; opt-in via override).
				// Heuristic: per-task F1 between expected_tools[] (DAG) and actual
				// tool invocations (session.jsonl). Opt-in — only scores if a task
				// declares expected_tools[].
				tool_correctness: {
					weight: 0,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
			},
		},

		audit: {
			signals: {
				// ratio of audits with verdict = PASS
				audit_pass_rate: {
					weight: 0.40,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// 0 critical findings = 1.0; 1+ critical = 0.0 (binary cliff; critical means
				// the workflow should not be considered passing regardless of other signals)
				no_critical_findings: {
					weight: 0.30,
					norm: "boolean",
					direction: "higher_better",
				},
				// ratio of audit reports that include evidence pointers
				evidence_pointers_present_pct: {
					weight: 0.20,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// ratio of audits that re-ran verification_cmd (the auditor's contract)
				verification_rerun_rate: {
					weight: 0.10,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// DISABLED placeholder (T3/T4 ship the metric; opt-in via override).
				// Heuristic+LLM hybrid: workflowReady binary from audit-state + LLM branch.
				goal_accuracy: {
					weight: 0,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
			},
		},

		coordination: {
			signals: {
				// ratio of dispatches that succeeded without needing a steer
				dispatch_success_first_try_rate: {
					weight: 0.30,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// average ratio of slots used vs cap (across peak windows) — penalize both
				// under-utilization (wasted fan-out) and over-utilization (queue starvation)
				concurrency_utilization_norm: {
					weight: 0.20,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// 0 if no agent exceeded its per-type cap (queueing happened cleanly); 1 if
				// at least one cap was hit. Penalized because cap-exhaustion usually means
				// the DAG was over-fanned.
				cap_violations: {
					weight: 0.25,
					norm: "boolean",
					direction: "lower_better",
				},
				// ratio of subagent sessions that completed with the expected isolation mode
				isolation_compliance_pct: {
					weight: 0.25,
					norm: "ratio_0_1",
					direction: "higher_better",
				},
				// DISABLED placeholder (T2 ships the metric; opt-in via override).
				// Heuristic: tool calls per task normalized to a soft budget.
				step_efficiency: {
					weight: 0,
					norm: "ratio_0_1",
					direction: "lower_better",
				},
			},
		},
	},
};
