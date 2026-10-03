---
id: GC-2026-pi-tasks-fork
title: Fork @tintinweb/pi-tasks into @sages/pi-tasks
severity: major
date: 2026-09-30
audit_verdict: PASS
post_hoc: true
---

# GC-2026-pi-tasks-fork — Postmortem (post-hoc reconstruction)

## What happened

`@tintinweb/pi-tasks` (Claude Code-style task tracking + coordination
for pi) was forked into the Sages monorepo as `@sages/pi-tasks`. The
fork is the prerequisite for replacing the heavier 4-stage DAG
workflow with pi-tasks's `TaskCreate` + auto-cascade — completed
tasks auto-trigger unblocked dependents through the dependency
graph, which is the implement → review → fix → merge loop the
project had been missing.

## Root cause

Sages' DAG (`dag_synthesize` + `task_dispatch`) was heavyweight
and couldn't model the review-fix-re-review loop without
re-instantiating the DAG. pi-tasks had the right primitives
(dependency graph + auto-cascade via `subagents:completed`) but was
published as a third-party package. Sages needed its own fork so
the orchestrator could ship it as a Sages-native extension, and so
future Sages-specific changes (path B prompt builders, workflow
graph, the `subscribeWorkflow` cascade) could land in dedicated GCs
without forking upstream every time.

## Fix

Commit `8fd2693 feat(pi-tasks): fork @tintinweb/pi-tasks into
@sages/pi-tasks` brought the full upstream source into the monorepo
as `pi-tasks/` with namespace + provenance updates only:

- `package.json#name`: `@tintinweb/pi-tasks` → `@sages/pi-tasks`
- `package.json#author`: `"tintinweb"` → `"vanpipy"`
- `package.json#repository.url`: pi-tasks GitHub → vanpipy/sages
- `package.json#description`: appended "Sages fork — " prefix
- Workspace wiring in root `package.json`

Behavior parity is the contract — RPC protocol, TaskStore semantics,
and the 7 LLM-facing tool shapes are byte-equivalent to upstream.

## Verification

All 8 SCs from the goal contract verified green. `bun run typecheck`
passes, `bun test` (vitest run) passes, biome lint clean. Single
conventional commit on `sages/GC-2026-pi-tasks-fork/T1`. No `.pi/`
files in the commit. Author identity from `git config` (no `--author`
override).

Refs: GC-2026-pi-tasks-fork