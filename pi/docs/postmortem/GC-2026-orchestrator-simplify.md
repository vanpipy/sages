---
id: GC-2026-orchestrator-simplify
title: Drop DAG/audit/dispatch/reminder; simplify goal schema
severity: major
date: 2026-10-01
audit_verdict: PASS
post_hoc: true
---

# GC-2026-orchestrator-simplify — Postmortem (post-hoc reconstruction)

## What happened

The orchestrator shed 4 tools (`dag_synthesize`, `task_dispatch`,
`orchestrator_audit`, `sages_reminder`) and the entire DAG / audit
infrastructure. Goal schema simplified to: `id / title / rationale /
anti_goals / scope / constraints / done_definition` (no more
`success_criteria[]` or `verification_cmd`). This is the foundation
for the `workflow_run` model (added in the next GC, GC-2026-workflow-run).

## Root cause

The orchestrator's DAG-centric surface was 4-stage-heavy:
`dag_synthesize` produced a multi-stage plan, `task_dispatch` ran
the DAG, `orchestrator_audit` verified each task, `sages_reminder`
nudged the LLM toward the DAG workflow. The DAG itself was
1,061 lines (`workflow-run.ts`), and the supporting infrastructure
(dag-synthesizer 701, task-dispatcher 558, orchestrator-audit 1196,
sages-reminder 286) added another ~2,800 lines. The `success_criteria`
+ `verification_cmd` schema was rigid: every goal had to spell out
SC tests as a list, with bash verification_cmds.

The model also broke at scale — the DAG stage loop couldn't express
"review → fix → re-review" cleanly because each Fix stage was a
distinct DAG node, not a graph re-entry.

## Fix

Commit `af4a47c refactor(orchestrator): drop DAG/audit/dispatch/
reminder; simplify goal schema` removed:

- 4 tools (and their tests, templates, prompts)
- `src/dag-synthesizer.ts` (701 lines)
- `src/task-dispatcher.ts` (558 lines)
- `src/orchestrator-audit.ts` (1196 lines)
- `src/sages-reminder.ts` (286 lines)
- `success_criteria[]` + `verification_cmd` from goal schema
- `events.json` / `dag-*.yaml` / `todo-*.yaml` namespace ownership

Replaced with: a 2-tool orchestrator (`goal_contract_create` +
`workflow_run`), a static task graph (path B), and an event-driven
orchestrator (GC-2026-path-B-swap).

## Verification

`pi-orchestrator` line count dropped from 6,500 to ~3,900 (a 40%
contraction). The 4 deleted tools' tests (most of which were DAG
fixtures) deleted. The soft-mode reminder refocused on pi-tasks
workflow (not the DAG workflow). All 8 verify gates green post-merge.

Refs: GC-2026-orchestrator-simplify