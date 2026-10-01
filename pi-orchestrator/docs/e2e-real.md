# Real End-to-End Test for `workflow_run`

> **Status:** GC-2026-real-e2e — documentation only. No code in the
> production path changes.

This document is the human/LLM guide for running the **real** e2e
test of `workflow_run`. Unlike `workflow-e2e.test.ts` (which mocks
the subagent layer), this test exercises the entire stack against
real Developer / Reviewer / Merger subagents in a real git worktree,
producing real commits and a real merge.

Use this when:

- You want to validate `workflow_run` end-to-end against actual model
  output (not a script).
- You want to capture evidence (git log, branch state, merge commit)
  for a release / milestone / postmortem.
- You suspect a regression in the live code path that the mocked
  tests can't surface.

---

## Prerequisites

1. **Sages stack installed and active.** `~/.pi/agent/` contains the
   `pi-orchestrator`, `pi-subagents`, and `pi-tasks` packages.
2. **A model configured.** The hardcoded fallback in
   `pi-subagents/src/default-agents.ts` is `minimax-cn/MiniMax-M3`
   (via `subagents.json#defaultModelsByType`). The recommended model
   is whatever your `settings.json#defaultProvider/defaultModel`
   specifies — Sages convention is to inherit unless a per-type override
   is set.
3. **`git` available on PATH.** The merger agent runs `git merge`,
   `git push`, `git worktree remove` in the test repo.
4. **Network access enabled** for the agents. `network_allowed: true`
   on the subagent dispatch (or via the per-type default in
   `pi-subagents/src/run-controller.ts`). Without it, `bun install`
   inside the worktree fails.

## Time budget

- Implement phase: 5-15 min (TDD writes test + impl + commit)
- Review phase: 2-5 min
- Fix iterations: 1-5 min each (up to `max_fix_iterations`)
- Merge phase: 1-3 min
- Total typical run: **10-25 min** with default `max_fix_iterations: 3`.

## What this test produces

A successful run leaves these artifacts in the test repo:

| Artifact | Where |
|---|---|
| Initial commit | `main` (before workflow_run) |
| Implement commit | branch `sages/{goal_id}-implement` |
| Fix commits (if any) | same branch, stacked |
| Merge commit | `main`, `--no-ff` with both parents |
| Worktree | `<repo>/.pi/worktree/{goal_id}/implement/` (cleaned by Merger) |
| Workflow state | `<repo>/.pi/orchestrator/workflow-{goal_id}.yaml` |
| Goal contract | `<repo>/.pi/orchestrator/goal-{goal_id}.yaml` |
| pi-tasks tasks | `<repo>/.pi/tasks/tasks.json` (4 tasks with `metadata.workflow_run_goal_id`) |

## Test goal (recommended starting point)

```yaml
# .pi/orchestrator/goal-GC-e2e-real.yaml
id: GC-e2e-real
title: "Add `src/util/hello.ts` exporting hello(name: string): string"
rationale: |
  Smoke-test the full workflow_run pipeline (Implement → Review → Merge)
  end-to-end against real subagents. The goal must be small enough to
  complete in <30 min, isolated enough to review cleanly, and trivial
  enough to merge without conflicts.
anti_goals:
  - do not modify any file outside the listed scope
  - do not add new dependencies (keep `package.json` untouched)
  - do not change any existing file except as listed in scope
scope:
  include:
    - src/util/hello.ts
    - test/util/hello.test.ts
  exclude:
    - node_modules/
    - package.json
    - bun.lock
constraints:
  typecheck_required: true
  lint_required: false
  must_use_existing_patterns: true
done_definition: |
  `src/util/hello.ts` exports a typed `hello(name: string): string`
  function that returns `"Hello, {name}!"`. A test file at
  `test/util/hello.test.ts` has at least one passing test for the
  default name and at least one for a non-default name. `bun test`
  passes; `bun run typecheck` reports zero errors.
```

This goal is deliberately trivial:

- One new file (impl).
- One new file (test).
- No edits to existing files.
- TDD cycle: write test → run (red) → write impl → run (green) → refactor.
- Review can verify all 5 dimensions easily.
- Merge is a clean `--no-ff` with no conflicts.

## Running the test

#### 1. Create a fresh test repo

```sh
bash pi-orchestrator/scripts/e2e-real.sh setup /tmp/sages-e2e-real
```

The script:

- Creates the directory.
- Runs `git init` with a `main` branch and one empty commit (so
  Merger has something to merge into).
- Writes `.pi/orchestrator/goal-GC-e2e-real.yaml` using the goal
  above.
- Prints the goal path so the next step knows where to point
  workflow_run.

#### 2. Inside a pi session, run workflow_run

```
goal_contract_create: {
  goal_path: "<goal>.yaml"  # if not already written by setup
}

workflow_run: {
  goal_path: "/tmp/sages-e2e-real/.pi/orchestrator/goal-GC-e2e-real.yaml"
  options: {
    max_fix_iterations: 3
  }
}
```

Or, if the goal is already on disk from step 1, skip
`goal_contract_create`.

#### 3. Capture evidence while pipeline runs

In the same (or a parallel) pi session:

```
› TaskList                  # filter by metadata.workflow_run_goal_id = "GC-e2e-real"
› subagent_status           # see live agent record IDs
```

The result of `workflow_run` carries the captured evidence:

```json
{
  "status": "success",
  "goal_id": "GC-e2e-real",
  "iterations_used": 0,
  "tasks": {
    "implement": { "id": "...", "status": "completed", "agent_id": "...", "duration_ms": 4123 },
    "review":    { "id": "...", "status": "completed", "verdict": "CLEAN", "iterations": 1 },
    "merge":     { "id": "...", "status": "completed", "merge_commit": "deadbeef..." }
  },
  "pi_tasks": { "implement": "1", "review": "2", "fix": "3", "merge": "4" },
  "paths": { "worktree": ".pi/worktree/...", "branch": "sages/gc-e2e-real-implement", "merge_commit": "deadbeef..." },
  "summary": "Goal GC-e2e-real completed: 0 fix iteration(s); merged sages/gc-e2e-real-implement → main (deadbeef...)."
}
```

Save the JSON output as the e2e evidence record.

#### 4. Post-run verification (run from the test repo)

```sh
cd /tmp/sages-e2e-real
git log --graph --oneline --all | head -20    # expect: branch + merge commit
git show --stat HEAD~1                          # the merged branch tip
ls .pi/worktree/ 2>/dev/null                    # should be empty (cleaned by Merger)
cat .pi/orchestrator/workflow-GC-e2e-real.yaml  # current_phase: completed
```

The expected git log shape:

```
*   deadbeef  merge(GC-e2e-real): Add `src/util/hello.ts`...
|\
| * abc1234  feat(util): hello function with TDD test
* | fedcba9  (initial commit) —  +
```

#### 6. Cleanup

```sh
rm -rf /tmp/sages-e2e-real
```

---

## Failure-mode cheat sheet

| Symptom | Likely cause | Diagnostic |
|---|---|---|
| `Implement phase failed: ...` | Developer agent crashed or hit budget | `subagent_status`, look at `error` field on `tasks.implement` |
| `Review phase failed: ...` | Reviewer agent crashed | check `tasks.review.error` |
| `Max fix iterations exhausted` | Reviewer keeps finding NEEDS_WORK issues | `result.unresolved_findings` lists them; bump `max_fix_iterations` or rewrite goal to be more atomic |
| `Merge phase failed: push failed` | Network access disabled OR origin rejected | check `network_allowed` on dispatch; if `git push` is intentionally off, change `Merger` prompt to skip push |
| `Blocked at implement: agent record not found` | Registry slot empty (rare; usually a GC-2026-073 issue) | `subagent_status` to see what's actually running |

## Running the same test against different goal shapes

Once the smoke test passes, try:

- **Tight scope** to test anti-goal compliance:
  `scope.include: ["src/util/hello.ts"]` only — Reviewer should FAIL
  any commit that touches `package.json`.
- **Loose done_definition** to test completeness review:
  `done_definition: "world-class hello implementation"` (vague) —
  Reviewer should return NEEDS_WORK with a clarity finding.
- **Cross-package coordination** to test pi-tasks integration:
  modify `done_definition` to require both `pi-subagents/src/util/`
  and `pi-orchestrator/src/util/` — workflow_run alone can't do
  this; the LLM must build a custom pi-tasks graph.

## Why this is documentation, not a script

The unit tests (`workflow-run.test.ts`, `workflow-e2e.test.ts`)
exercise the orchestration logic deterministically. The real e2e
exercises model behavior — there is no assertion stronger than
"the merge_commit exists". That's a judgment call best made by a
human (or LLM) reading the git log + commit messages + reviewer
verdict, not a CI gate.

This document is the canonical reference for that judgment call.