# Sages Reward Mode

## When reward mode is on (`sages.rewardMode: true` in `~/.pi/agent/settings.json`)

You have access to two tools for self-evaluation of the active Sages workflow:

- **`eval_score()`** — current workflow score + 5-dimension breakdown
- **`eval_trend()`** — current workflow vs your historical similar workflows

Both tools take no arguments. They always act on the active Sages workflow.

## When to call

- **After designing the DAG** — call `eval_score()` to see if isolation, cycles, and SC coverage are healthy
- **After writing key task reports** — call `eval_score()` to see whether the implement dimension is reasonable
- **Before finalizing** — call `eval_trend()` to see whether your approach is above or below your historical baseline
- **Whenever a dimension score is low** — read the `evidence` array; each entry points to the specific artifact and location to fix

## Output shape

`eval_score()` returns:

```json
{
  "status": "ok" | "blocked",
  "intent": "…",
  "workflow_id": "GC-…",
  "total_score": 72,
  "dimensions": {
    "goal":         { "score": 95, "evidence": [] },
    "dag":          { "score": 60, "evidence": [{ "artifact": "…", "location": "…", "note": "…" }] },
    "implement":    { "score": 0,  "evidence": [] },
    "audit":        { "score": 0,  "evidence": [] },
    "coordination": { "score": 50, "evidence": [] }
  },
  "coefficients_warning": {
    "file_version": "0.2.0",
    "package_version": "0.3.0",
    "note": "file version \"0.2.0\" differs from pi-evaluator \"0.3.0\". Format may have drifted; review CHANGELOG.md and re-init if needed."
  }
}
```

`coefficients_warning` is present only when the loaded coefficients file's
`version` does not match `pi-evaluator/package.json#version` (see
"Configuring the scoring formula" below). The loader still uses the file —
mismatch is a soft warning, not a rejection.

`eval_trend()` returns:

```json
{
  "status": "ok" | "blocked",
  "intent": "…",
  "workflow_id": "GC-…",
  "sample_size": 7,
  "trend": "UP" | "DOWN" | "STABLE" | "INSUFFICIENT_DATA",
  "trend_delta": 3.2,
  "percentile": {
    "total": 60,
    "by_dimension": {
      "goal": 90, "dag": 50, "implement": 70, "audit": 80, "coordination": 40
    }
  }
}
```

## Score 0 vs no data

- `score: 0, evidence: []` → dimension **has not yet been observed** (the workflow has not reached that stage yet)
- `score: 0, evidence: [{ "note": "…" }]` → dimension **has been scored** and is genuinely 0 (something failed)

Use `evidence.length === 0` to detect "no data yet" vs a real failure.

## The 5 dimensions

| Dim | What it measures | Default contribution |
|---|---|---|
| `goal` | clarity of the goal contract (verifiable SCs, anti-goals, scope discipline) | 20% of total |
| `dag` | DAG well-formedness + agentic plan adherence | 20% |
| `implement` | code-quality + agentic task completion + argument correctness | 30% |
| `audit` | goal accuracy (does the finished work match `done_definition`) | 20% |
| `coordination` | step efficiency + tool usage quality | 10% |

The aggregate `total_score` is the dimension-weighted sum of the 5 per-dim
scores (Σ dimension_weights = 1.0).

## The 7 metrics

`pi-evaluator@0.3.0` ships **7 metrics**. Each metric's `id` matches a signal
name in `coefficients.json` and is dispatched by `computeSignalValue` in
`src/signals/metric-runner.ts`. Default weights are **0** for all 7 — opt in
by overriding the signal's `weight` in your coefficients file.

| Signal name | Dim | Kind | What it measures | Opt-in cost |
|---|---|---|---|---|
| `step_efficiency` | coordination | heuristic | Tool calls per task window (orchestrator tool = window boundary), normalized against `budgetPerTask` (default 30). Lower saturation = better. | 0 LLM tokens |
| `argument_correctness` | implement | heuristic | Per-tool `toolResult.is_error=true` rate across `session.jsonl`. Lower error rate = better. | 0 LLM tokens |
| `plan_adherence` | dag | heuristic | Per-task coverage: each `acceptance.covers[]` SC id must appear in that task's report. Higher coverage = better. | 0 LLM tokens |
| `goal_accuracy` | audit | hybrid | **Heuristic** (default): `workflowReady:true` AND verdict is `**CERTIFIED**`. **LLM branch** (opt-in via `with.from: 'llm'`): judge compares audit findings vs `done_definition`. | 0 / ~$0.001 per call |
| `task_completion` | implement | hybrid | **Heuristic** (default): per-task ratio of `SC<N> PASS` matches in audit findings over `acceptance.covers[]`. **LLM branch**: judge reads each task report and scores per-SC. | 0 / ~$0.003 per task |
| `plan_quality` | dag | llm_judge | DAG structural quality — judge reads `dag-{id}.yaml` + summaries (planes, batches, isolation, coverage). | ~$0.001 per call |
| `tool_use` | coordination | llm_judge | Tool usage quality — judge reads `session.jsonl` per-tool summaries (calls / errors / sequences). | ~$0.001 per call |
| `tool_correctness` | implement | heuristic | Per-task F1 between `expected_tools[]` (DAG) and actual tool invocations (session.jsonl). **Opt-in** — the metric is data_missing when no DAG task declares `expected_tools[]`. Task IDs map to orchestrator tool names (current mapping model). | 0 LLM tokens |

### Cost gate

Hybrid + LLM metrics only invoke the LLM judge when:

1. The signal's `weight` in your coefficients override is `> 0`
2. `with.from` is set to `"llm"` (the `with` field on each signal lets you pass per-signal config)

Default config: all 7 metrics at `weight: 0` → **zero LLM tokens consumed**.
Enabling any hybrid/LLM metric requires (a) weight > 0 AND (b) the provider's
API key env var (e.g. `ANTHROPIC_API_KEY`) to be set. Missing API key throws
inside `defaultJudgeFn` → the seam returns `data_missing: true` → the
engine excludes that signal from the weighted sum.

### Example opt-in coefficients override

```jsonc
{
  "version": "0.3.0",
  "global": { "dimension_weights": { "goal": 0.2, "dag": 0.2, "implement": 0.3, "audit": 0.2, "coordination": 0.1 }, "thresholds": { "pass": 80, "pass_with_gaps": 50 } },
  "dimensions": {
    "implement": {
      "signals": {
        "argument_correctness": { "weight": 1.0, "norm": "ratio_0_1", "direction": "lower_better" }
      }
    },
    "audit": {
      "signals": {
        "goal_accuracy": {
          "weight": 1.0,
          "norm": "ratio_0_1",
          "direction": "higher_better",
          "with": { "from": "llm", "provider": "anthropic", "modelId": "claude-sonnet-4-5" }
        }
      }
    }
  }
}
```

## Reward mode is off (default)

If you call `eval_score` or `eval_trend` and the response is `{ "status": "blocked", "intent": "reward mode is off …" }`, the user has reward mode disabled. Mention this in your summary so the user knows the score is unavailable.

## Where to look as a developer

These files are written by the signal engine when mode is on:

- **`.pi/orchestrator/evals/live-{session_id}.jsonl`** — real-time event stream (append-only)
- **`.pi/orchestrator/evals/report-{session_id}.md`** — human-readable summary at `session_end`
- **`.pi/orchestrator/evals/report-{session_id}.json`** — machine-readable score snapshot (consumed by `eval_trend` for cross-workflow comparison)

To find the current session's live file:

```bash
ls -lt .pi/orchestrator/evals/*.jsonl | head -1
```

## Configuring the scoring formula

The reward formula's weights live at `~/.pi/agent/evaluator-log/coefficients.json`.
The schema is enforced by pi-evaluator; an invalid file (bad shape,
Σ weights ≠ 1.0, etc.) throws on load and pi-evaluator falls back to the
built-in defaults. Start from the annotated template at
`examples/evaluator-log/coefficients.json` in the pi-evaluator source tree.

**The `version` field must mirror `pi-evaluator/package.json#version`.** When
they differ, `eval_score()` output includes a `coefficients_warning` block so
the user knows their coefficients may describe a different release's algorithm.
The loader still loads the file (warn + use-as-is, not reject) so users can
upgrade pi-evaluator without first re-tuning their coefficients.

**v0.3.0 adds** the optional `with` field on every signal — pass per-signal
config (e.g. `with: { from: 'llm', provider: 'anthropic', modelId: '...' }`).
v0.2.0 coefficients files (no `with`) continue to parse without modification
(additive compatibility).

### Expected tools (GC-2026-066)

The `tool_correctness` metric is opt-in: declare `expected_tools: string[]` on
a DAG task and pi-evaluator scores precision (|actual ∩ expected| / |actual|),
recall (|actual ∩ expected| / |expected|), and F1 for that task.

```yaml
# dag-{id}.yaml
tasks:
  - id: goal_contract_create
    expected_tools: [read, grep]   # this task is expected to use only read + grep
  - id: dag_synthesize
    expected_tools: [edit, bash]
```

The metric currently maps session.jsonl windows by orchestrator tool name
(goal_contract_create, dag_synthesize, task_dispatch, orchestrator_audit),
so task IDs in the DAG must use one of those four names for the metric to
match the window. Per-task F1 is averaged into the implement dim score.

To enable scoring, override the default weight:0 in your coefficients:

```jsonc
{
  "dimensions": {
    "implement": {
      "signals": {
        "tool_correctness": { "weight": 0.3, "norm": "ratio_0_1", "direction": "higher_better" }
      }
    }
  }
}
```

Future GC may extend the mapping model to per-DAG-task-id windows (not
gated by orchestrator tool names).

Weight invariants (enforced on load):

- Σ signal weights = 1.0 per dimension (per enabled dimension; data_missing signals are excluded from the weighted sum at runtime, not from this invariant)
- Σ dimension_weights = 1.0 globally
- `thresholds.pass_with_gaps < thresholds.pass`

## What this extension does NOT do (anti-scope)

- It does not replace `goal_contract_create` / `dag_synthesize` / `task_dispatch` / `orchestrator_audit`. Those are Stage 1–4 of the Sages workflow; this extension is a passive observer on top.
- It does not run any shell commands. It reads `.pi/orchestrator/` files and surfaces scores; it never writes to orchestrator state.
- It does not provide a CLI (`pi-evaluator run`, etc.). The reward mode is invoked by pi at runtime, not from a shell.
- **Tool Correctness** (`expected_tools[]`-based scoring) is shipped as `tool_correctness` in v0.4.0 (GC-2026-066). Opt-in only. The metric currently maps windows by orchestrator tool name; per-DAG-task-id windowing is a future GC.
