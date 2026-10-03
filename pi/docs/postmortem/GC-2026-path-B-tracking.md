---
id: GC-2026-path-B-tracking
title: Path B tracking layer: static graph + verdict parser + workflow:start listener in pi-tasks
severity: major
date: 2026-10-01
audit_verdict: PASS
post_hoc: true
---

# GC-2026-path-B-tracking — Postmortem (post-hoc reconstruction)

## What happened

The path B tracking layer landed in pi-tasks: the static workflow
graph builder (Implement + N Reviews + (N-1) Fixes + Merge), the
Reviewer verdict parser, the 4 phase prompt builders, and the
`workflow:start` / `subagents:completed` event handlers that drive
the cascade. This is the layer that runs the orchestration loop;
GC-2026-path-B-swap (the next GC) refactors the orchestrator to be a
thin shim that emits `workflow:start` and waits for
`workflow:phase-complete`.

## Root cause

After GC-2026-orchestrator-simplify removed the DAG, the
orchestrator needed a replacement. The new model: pi-tasks owns the
task graph + cascade; the orchestrator is a planning facade. But
pi-tasks didn't have the build-graph / parse-verdict / drive-cascade
primitives yet — those were still in path A's `workflow-run.ts`
state machine.

## Fix

Commit `381ee8f merge(GC-2026-path-B-tracking): path B tracking
layer in pi-tasks` brought 5 commits:

- `608ef27 feat(pi-tasks): subscribeWorkflow event handler green +
  simple-git devDep` — the core cascade engine.
- `e962f09 feat(pi-tasks): emit workflow:phase-complete for all
  phases` — extended path B's event contract (all 4 phase
  categories).
- `8fd2693 feat(pi-tasks): fork @tintinweb/pi-tasks into @sages/pi-tasks`
  — the prerequisite fork.
- `25b6f0d feat(pi-tasks): wire subscribeWorkflow into extension
  factory` — production wire-up.
- `6a8ad81 feat(subagents): add Fix Phase Behavior section to
  developer prompt` — cascade-spawned Fix agents handle CLEAN
  (empty commit) vs NEEDS_WORK (address findings).

## Verification

The 4 phase prompt builders (`implementPrompt`, `reviewPrompt`,
`fixPrompt`, `mergePrompt`) live in `pi-tasks/src/phase-prompts.ts`
as the canonical source. (Note: GC-2026-path-B-swap superseded these
with inline builders in `workflow-graph.ts`; the standalone file
was later deleted by GC-2026-boundary-subagent-control.)

`buildStaticWorkflowGraph` (the pure function that produces the
7-task graph for `max_fix_iterations=3`) was tested independently of
the cascade engine. `parseReviewerVerdict` parses the LLM's final
message's fenced YAML block into a structured verdict with findings.

Refs: GC-2026-path-B-tracking