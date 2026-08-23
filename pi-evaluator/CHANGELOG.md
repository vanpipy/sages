# Changelog

All notable changes to `@sages/pi-evaluator` are documented here. Versions
follow semver; the `coefficients.json` `version` field MUST mirror
`package.json#version`.

## 0.3.0 — 2026-08-22 (GC-2026-063)

**Major: scoring engine + 7 agentic metrics land.** `eval_score()` now returns
real scores instead of all-zero. `computeEvalScore` lazy-cooks via
`scoreWorkflow` when `active_workflow_path` is set.

### Added

- **Engine** (`src/engine/`):
  - `scoring-engine.ts` — `scoreWorkflow(workflowPath, coefficients, cwd)`
    aggregates signals per dim using a norm/direction lookup table.
  - `signal-runner.ts` — `computeSignalValue(name, cfg, ctx)` looks up the
    registered `Metric` by signal name and forwards `with` config.
  - `coefficients-schema.ts` — additive `with?: Record<string, unknown>`
    per signal for opt-in config.
- **Metrics layer** (`src/metrics/`):
  - `types.ts` — `Metric<I>` interface + `MetricResult` / `MetricContext`.
  - `registry.ts` — module-scoped registry + `registerBuiltinMetrics()`
    (idempotent; safe to call from multiple test files).
  - 3 pure heuristic: `step_efficiency`, `argument_correctness`, `plan_adherence`.
  - 2 hybrid heuristic + LLM-stub: `goal_accuracy`, `task_completion`.
  - 2 pure LLM-only: `plan_quality`, `tool_use`.
- **LLM-judge seam** (`src/metrics/llm-judge/`):
  - `seam.ts` — `setJudgeFn`/`getJudgeFn` + `judge()` entry. Missing judge
    returns `data_missing:true` so callers fall back to heuristic.
  - `judge.ts` — `defaultJudgeFn` calls `complete()` from
    `@mariozechner/pi-ai`. Provider/model via `getEnvApiKey`/`getModel`.
  - `prompts.ts` — `JUDGE_SYSTEM_PROMPT` template + `buildJudgeUserMessage`.
  - `parseJudgeReply` — pure helper tolerating 4 reply shapes (strict JSON,
    fenced JSON, bare score regex, empty text).
- **State + tool wiring**:
  - `state.ts` — `EvalState` gains `active_workflow_path?` and
    `active_workflow_id?`.
  - `eval-score.ts` — `computeEvalScore` becomes async; lazy path
    `scoreWorkflow + globalScore` runs when `active_workflow === null` but
    `active_workflow_path` is set. try/catch around the lazy block keeps
    scoring failures non-fatal.
- **Examples** (`examples/evaluator-log/coefficients.json`):
  - `version` bumped to `"0.3.0"`.
  - 7 new signal placeholders (`weight: 0`) appended to existing dim blocks.
  - `_v030_opt_in_examples` block shows how to enable `task_completion`
    with LLM judge.
- **Tests** (`test/`):
  - 13 new test files; +91 tests (was 123 → 214).
  - `metrics/types.test.ts` — interface shape.
  - `metrics/registry.test.ts` — register/get/list/duplicate-throws/builtins.
  - `signals/metric-runner.test.ts` — missing metric + forwarding + with.
  - `engine/scoring-engine.test.ts` — weighted sum + data_missing exclusion.
  - `engine/coefficients-backward-compat.test.ts` — 0.2.0 fixture loads,
    0.3.0 with `with` field loads.
  - `metrics/{step-efficiency,argument-correctness,plan-adherence}.test.ts`
    — 3 pure heuristic, ~15 tests.
  - `metrics/{goal-accuracy,task-completion}.test.ts` — 2 hybrid, ~10 tests.
  - `metrics/llm-judge/judge.test.ts` — parseJudgeReply 4 shapes +
    defaultJudgeFn mocked integration + seam round-trip. 14 tests.
  - `metrics/{plan-quality,tool-use}.test.ts` — 2 LLM-only, 10 tests.
  - `tools/eval-score.test.ts` — extended with 4 lazy-path cases.
  - `integration/scoring-pipeline.test.ts` — 8 end-to-end tests against
    `fixtures/workflow-scoring-1`.
  - `integration/heuristic-benchmark.test.ts` — heuristic path <500ms
    (actually averages 2.3ms, max 3.9ms over 20 runs).
- **Fixtures** (`fixtures/workflow-scoring-1/`):
  - 6 artifact files + `session.jsonl` with 3 task windows (9/0/1 tool
    calls) so each metric produces a deterministic expected score.

### Backward compatibility

- 0.2.0 coefficient files (no `with` field) still parse cleanly via
  `coefficients-backward-compat.test.ts`.
- `eval_score()` and `eval_trend()` output shapes unchanged.
- 5 existing structural signals (`sc_verifiable_pct`, `sc_to_task_coverage_pct`,
  `verification_first_try_rate`, `audit_pass_rate`, `dispatch_success_first_try_rate`,
  etc.) remain in DEFAULT_COEFFICIENTS at their existing weights but have no
  registered Metric yet — the engine returns `data_missing:true` for them
  and excludes from the weighted sum. To use them, register a metric under
  the matching id.

### Defaults unchanged

All 7 new metrics ship at `weight: 0`. `eval_score()` with default
coefficients consumes **zero LLM tokens**. To enable any metric:

1. Override the signal's `weight > 0` in your coefficients file
2. (Hybrid + LLM-only) Set `with.from = 'llm'` AND ensure the provider's
   env var is set (e.g. `ANTHROPIC_API_KEY`)

### Performance

- Heuristic path: `scoreWorkflow` on the scoring-1 fixture averages **2.3ms**
  (max 3.9ms over 20 runs), well under the 500ms ceiling.

### Anti-scope (deferred)

- **Tool Correctness** — `expected_tools[]`-based scoring requires extending
  the task-brief schema (out of scope for GC-2026-063).
- **T1b** — extension.ts tool_call listener for auto-setting
  `active_workflow_path` from orchestrator tool invocations. The lazy path
  is ready; the listener wiring is a separate small surgical edit.
