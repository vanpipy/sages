---
id: GC-2026-rename-auditor
title: Rename Auditor agent → Reviewer (for workflow_run)
severity: minor
date: 2026-10-01
audit_verdict: PASS
post_hoc: true
---

# GC-2026-rename-auditor — Postmortem (post-hoc reconstruction)

## What happened

`pi-subagents`' Auditor agent was renamed to Reviewer in preparation
for the next GC (`workflow_run`), which needed a per-phase reviewer.
The Auditor role had been designed for DAG-era SC verification (run
`verification_cmd`, output PASS/FAIL) — but the DAG infrastructure
was gone after GC-2026-orchestrator-simplify. The remaining agent
needed to fill the "review the implementation against the goal
contract" role for the path B workflow.

## Root cause

The Auditor agent's `verification_cmd` runner and PASS/FAIL output
shape had no callers after the orchestrator-simplify. Its
`run verification_cmd + parse exit code` prompt template was
DAG-era scaffolding. Workflow_run (the next GC) would dispatch a
subagent per phase and expect a structured verdict
(`CLEAN | NEEDS_WORK` + findings[]) — that's Reviewer-shaped, not
Auditor-shaped.

## Fix

Commit `b6b987b merge(GC-2026-rename-auditor): rename Auditor →
Reviewer agent` brought:

- `da50444 refactor(subagents): rename Auditor agent to Reviewer
  for workflow_run` — agent registry key rename, prompt template
  rewrite, expected output format change.
- `1c8f75e chore(orchestrator): clean up stale DAG/audit comments
  and unused RunEvent enums` — paired cleanup.

The Reviewer prompt now instructs the agent to run a 5-dimension
review (correctness / completeness / scope adherence / anti-goal
compliance / documentation), emit a fenced YAML block with
`verdict: CLEAN | NEEDS_WORK` + `findings: []`, and report per-dimension
results. workflow_run (next GC) reads the verdict via
`parseReviewerVerdict` in `pi-tasks/src/verdict-parser.ts`.

## Verification

After the rename, the agent registry's `Reviewer` key (PascalCase,
per GC-2026-091 convention) is the canonical; `Auditor` is gone. The
prompt template fixture (`subagent-reviewer.md`) matches the new
reviewer role. workflow_run (the next GC) consumes the Reviewer's
verdict output via `pi-tasks/src/verdict-parser.ts`.

Refs: GC-2026-rename-auditor