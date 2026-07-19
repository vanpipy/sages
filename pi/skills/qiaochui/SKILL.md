---
description: Review draft and create task plan (auto-writes score)
---

# QiaoChui (巧倕) - Technical Expert

## Role

QiaoChui reviews the design draft and decomposes approved designs into tasks. **qiaochui_review auto-writes the score to `state.json`** — no separate `fuxi_update_score` call needed. The LLM uses **sages_*** / **graphify** / **codebase-memory** to actually inspect the draft.

## Mode Indicator

```
**Review Mode** (Read-Only)
- Read draft.md and surrounding code
- Use qiaochui_review (with observation {score, notes?}) to persist assessment
```

## Tools

| Tool | Purpose |
|---|---|
| `qiaochui_review` | Review draft. Two modes: without observation returns heuristic hints + semantic-tool guidance; with observation `{score, notes?}` validates 0-100 and **persists to state.json**. |
| `qiaochui_decompose` | Decompose approved design into `plan.md` + `execution.yaml`. Requires `state.score >= 80`. |

## qiaochui_review

### Two Modes

**Mode 1 — without observation** (LLM is reviewing):

```ts
qiaochui_review { draft_path?: string }
```

Returns `{ status: "in_progress", intent, validation, heuristic_hints }`. The LLM:

1. Reads draft.md via `sages_read_file`
2. Optionally checks project context via `graphify_god_nodes` / `codebase_memory_get_architecture`
3. Assesses against the 5 dimensions (see table below)
4. Calls `qiaochui_review` with `observation: { score, notes? }`

**Mode 2 — with observation** (LLM submits final score):

```ts
qiaochui_review {
  observation: {
    score: 85,        // required, 0-100
    notes: "Looks solid."  // optional
  }
}
```

Returns `{ status: "complete", score, verdict, can_start_plan: true }`. **Persists `state.score` to `state.json`** so `qiaochui_decompose` can validate without a second tool call.

### Score Threshold

| Score | Verdict | `can_start_plan` |
|---|---|---|
| **≥ 80** | `APPROVED` | `true` |
| 50-79 | `REVISE` | `false` |
| < 50 | `REJECTED` | `false` |

### Dimensions (for LLM's assessment)

The rubric adapts to whether the draft declares a Scope section.

#### Legacy rubric (no Scope section) — 5 dimensions, weights sum to 100

| Dimension | Weight | What to check |
|---|---|---|
| completeness | 25 | All 7 MDD planes covered? |
| clarity | 20 | Writing clear? Examples concrete? |
| feasibility | 25 | Technical approach implementable? Dependencies clear? |
| testability | 15 | Success path defined? Error handling concrete? |
| boundaries | 15 | Out-of-scope clear? Limits stated? |

#### Scope-aware rubric (when draft has `## Scope`) — 6 dimensions, weights sum to 100

When the agent declares Tier + in-scope planes, completeness is reframed around
the in-scope subset and a new `scope_justification` dimension is added. The
heuristic also scores only in-scope planes (see `performDeepReview`).

| Dimension | Weight | What to check |
|---|---|---|
| completeness | 20 | In-scope planes (per Scope section) covered with sufficient depth? |
| scope_justification | 10 | Are the scope decisions reasonable for this task? Tier justified? |
| clarity | 20 | Writing clear? Examples concrete? |
| feasibility | 25 | Technical approach implementable? Dependencies clear? |
| testability | 15 | Success path defined? Error handling concrete? |
| boundaries | 10 | Out-of-scope justifications clear? Limits stated? |

**Tip**: when the Scope section exists, the heuristic in `details.heuristic_hints`
already filters out out-of-scope planes — you don't need to manually re-derive the
in-scope list. Just verify the scope choice makes sense for the task.

## qiaochui_decompose

### Prerequisite

`state.score >= 80` (auto-written by `qiaochui_review`). The tool reads `state.json` directly and returns an error if the score is missing or below threshold.

### Creates

- `plan.md` — Task descriptions
- `execution.yaml` — Task config with dependencies, plane, priority, files

### Parameters

| Param | Default | Purpose |
|---|---|---|
| `draft_path` | `draft.md` | Source draft |
| `max_tasks` | 10 | Maximum tasks to generate |
| `use_subagent` | `true` | Subagent execution (kept for compat; semantic-tool path is default) |
| `max_parallel` | 3 | Max concurrent task workers |

### File Conflict Resolution

Tasks editing the same file are sorted by priority and chained with sequential dependencies.

## After Decompose

```
**Plan Mode** (Read-Only + execute.yaml writeable)
- plan.md and execution.yaml are writeable
- Iterate `luban_execute_task` per task; LLM reads execution.yaml directly
```

## Prohibited

- ❌ Decompose without `state.score >= 80`
- ❌ Call `fuxi_update_score` (deprecated — qiaochui_review writes it directly)
- ❌ Skip the dimension assessment (5-dim legacy OR 6-dim scope-aware)

## Example Flow

```
> qiaochui_review { draft_path: "draft.md" }
← { status: "in_progress", intent: "Read draft.md using semantic tools...", validation: { dimensions: [...], pass_threshold: 80 }, heuristic_hints: { ... } }

[LLM uses sages_read_file to read draft.md, checks existing code patterns via graphify_god_nodes, assesses against 5 dimensions → score 85]

> qiaochui_review { observation: { score: 85, notes: "Solid MDD coverage" } }
← { status: "complete", score: 85, verdict: "APPROVED", can_start_plan: true, state_persisted: true }

> qiaochui_decompose
← { success: true, plan_path: ".sages/workspace/plan.md", execution_path: ".sages/workspace/execution.yaml", task_count: 5 }

[LLM reads execution.yaml via semantic tools and iterates luban_execute_task per task]
```