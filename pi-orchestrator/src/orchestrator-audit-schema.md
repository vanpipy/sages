# orchestrator_audit Tool Schema Reference

> **Audience**: LLMs (orchestrator and auditors) calling `orchestrator_audit` via MCP.
> **Source of truth**: `pi-orchestrator/src/orchestrator-audit.ts` (TypeBox schemas
> `OrchestratorAuditParams`, `COMPLETE_OBSERVATION`).
> **Status**: GC-2026-coupon-nonhit-block follow-up — pinned to fix the
> "Cannot read properties of undefined (reading 'dag_id')" runtime errors
> that surfaced when the LLM called with the wrong shape.

## Top-level params

| Field | Type | Required | Description |
|---|---|---|---|
| `dag_id` | string | **yes** | The DAG id (e.g. `"DAG-2026-coupon-nonhit-block"`) — must match an existing `dag-{dag_id}.yaml` |
| `task_id` | string | optional | Single-task scope (mutually exclusive with `batch`) |
| `batch` | number | optional | Batch scope (mutually exclusive with `task_id`) |
| `depth` | `"fast" \| "full"` | optional (default `"fast"`) | `fast` = ink/nose/foot; `full` adds castration/death |
| `verbose` | boolean | optional (default `false`) | If `true`, return the full init payload (phase_guidance, tasks_to_audit, etc.) |
| `observation` | object | optional | See below |

## `observation` object

Three mutually-compatible sub-fields:

| Field | Type | Description |
|---|---|---|
| `observation.finding` | Finding | **Single** finding (backward-compat). Prefer `findings` array below. |
| `observation.findings` | Finding[] | **Array** of findings — preferred for batch submission (one tool call, many findings). |
| `observation.complete` | Complete | Mark the audit as done; see schema below. |

**Path selection** (see `executeOrchestratorAudit` in `orchestrator-audit.ts`):

- `observation.complete` present → **Path 1**: Complete (merge any concurrent findings first, then finalize)
- `observation.findings` (or `finding`) present, no `complete` → **Path 2**: Record findings only
- No `observation` → **Path 3**: Init (first call, returns `workflow_summary` + `phase_guidance`)

## Finding schema

```yaml
task_id: "BLOCK-P1"  # optional — which task this finding targets
category: "ink" | "nose" | "foot" | "castration" | "death"  # required
severity: "critical" | "major" | "minor"  # required
issue: "<one-line summary>"  # required
evidence: "<optional supporting output>"  # optional
recommendation: "<optional fix hint>"  # optional
```

## Complete schema

```yaml
verdict: "PASS" | "REVISE" | "REJECT"  # required
score: <number 0-100>  # required (recomputed from findings; final is min(yours, computed))
summary: "<one-line audit conclusion>"  # required
```

`findings_required_min` (returned in `validation`): `1` for `fast`, `3` for `full`.
A clean audit (zero findings) may still PASS — the LLM uses this counter to
plan how many findings to record when defects exist.

## Common errors and fixes

| Error | Cause | Fix |
|---|---|---|
| `Cannot read properties of undefined (reading 'dag_id')` | The runtime passed `params = undefined` (most often when the LLM call shape was rejected by TypeBox validation upstream) | Verify `dag_id` is the first field; ensure all required fields are present; do not nest under `params` |
| `DAG ${dag_id} not found` | `dag_synthesize` was not run for this `dag_id` | Run `dag_synthesize({goal_id})` first, then retry |
| `No tasks match the filter` | `task_id` / `batch` filter selects zero tasks | Verify the id against the DAG YAML |

## Example invocations

### Init (first call)
```ts
orchestrator_audit({ dag_id: "DAG-2026-coupon-nonhit-block" });
// returns: { status: "in_progress", phase: "audit-init", workflow_summary: {...}, validation: {findings_required_min: 1}, ... }
```

### Record a single finding
```ts
orchestrator_audit({
  dag_id: "DAG-2026-coupon-nonhit-block",
  task_id: "BLOCK-P1",
  observation: {
    finding: {
      category: "ink",
      severity: "minor",
      issue: "Test coverage gap in edge case X",
      evidence: "jest output line: 'X is not covered'",
      recommendation: "Add a V-14 test for edge case X"
    }
  }
});
```

### Record multiple findings (preferred)
```ts
orchestrator_audit({
  dag_id: "DAG-2026-coupon-nonhit-block",
  observation: {
    findings: [
      { task_id: "BLOCK-P1", category: "ink", severity: "minor", issue: "..." },
      { task_id: "BLOCK-P2", category: "nose", severity: "major", issue: "..." }
    ]
  }
});
```

### Complete the audit
```ts
orchestrator_audit({
  dag_id: "DAG-2026-coupon-nonhit-block",
  observation: {
    complete: { verdict: "PASS", score: 88, summary: "All tasks green; one minor observation." }
  }
});
```

### Complete with concurrent findings (single call, batch path)
```ts
orchestrator_audit({
  dag_id: "DAG-2026-coupon-nonhit-block",
  observation: {
    findings: [ { task_id: "BLOCK-P1", category: "nose", severity: "minor", issue: "..." } ],
    complete: { verdict: "PASS", score: 95, summary: "Findings recorded; all tasks green." }
  }
});
```

## Cross-references

- `pi-orchestrator/src/orchestrator-audit.ts` — TypeBox schema + execute path
- `pi-orchestrator/src/types.ts` — `taskAuditPath(cwd, dagId, taskId)` returns
  `audit-{dagId}-{taskId}.md` (GC-2026-coupon-nonhit-block namespace fix)
- `pi-orchestrator/src/namespace-ownership.ts` — `AUDITOR_PATTERNS` regex
- `pi-subagents/src/agent-prompts/auditor.ts` — auditor's write target
