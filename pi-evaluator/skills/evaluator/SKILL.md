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

Weight invariants (enforced on load):
- Σ signal weights = 1.0 per dimension
- Σ dimension_weights = 1.0 globally
- `thresholds.pass_with_gaps < thresholds.pass`

## What this extension does NOT do (anti-scope)

- It does not replace `goal_contract_create` / `dag_synthesize` / `task_dispatch` / `orchestrator_audit`. Those are Stage 1–4 of the Sages workflow; this extension is a passive observer on top.
- It does not run any shell commands. It reads `.pi/orchestrator/` files and surfaces scores; it never writes to orchestrator state.
- It does not provide a CLI (`pi-evaluator run`, etc.). The reward mode is invoked by pi at runtime, not from a shell.
