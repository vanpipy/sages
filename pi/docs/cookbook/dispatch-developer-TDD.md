# Dispatching an `implementer` worker with full TDD discipline

> **Pattern:** Spawn an `implementer` (subagent_type `developer`) in a managed worktree with the 4-stage DAG harness around it for any change to production code.
> **When to use:** Any change that touches `src/`, `test/`, `lib/`, `pi/`, any peer `pi-*/` package, build config, CI config, or dependency manifests.

## Problem

Production code lives in shared, mutable surfaces. If the main agent edits
those surfaces directly, four failure modes show up:

1. **File collisions.** A long-running multi-file edit interleaves with a
   sibling worker's commit on an adjacent file and the index becomes a
   three-way Frankenstein that nobody can `git bisect`.
2. **Lost context.** The main session is also where the user is asking
   questions. An in-place production-code edit eats context budget that
   should be spent on integration, review, and answering the user.
3. **No audit trail.** The main agent has no typed artifact, no
   `evidence[]`, no `validation` field. If the change broke something,
   the post-mortem is "I think I edited line 42".
4. **Permission drift.** Red Line #1 in `AGENTS.md` says the main agent
   must not edit production code, but without an enforcement seam the rule
   collapses under deadline pressure ("just this once").

The escape hatches (`explore` for read-only, `plan` for design briefs,
`developer` in `current-workspace` for meta-files) cover everything that
is NOT production code. The remaining shape is the one this cookbook
entry describes.

## Solution

The 4-stage DAG workflow, run by the L3 orchestrator (the main session):

1. **`goal_contract_create`** — declare binary success criteria, each with a
   runnable `verification_cmd`. No criterion, no DAG node.
2. **`dag_synthesize`** — decompose into tasks with disjoint
   `files_touched[]`. Within-batch independence; across-batch acyclic.
3. **`task_dispatch` (per batch)** — spawn each task as an `Agent` call with
   the right `isolation`. Production-code tasks get a managed worktree.
4. **`orchestrator_audit`** — mechanically verify evidence + validation +
   commit chain against `files_touched[]`. PASS gates the merge.

The `implementer` (subagent_type `developer`) is the worker that owns
TDD discipline inside the managed worktree: red test → green impl →
refactor → commit, with one commit per logical change.

## Code

Spawn an `implementer` task with managed-worktree isolation:

```ts
// Inside the L3 orchestrator, batch loop:
Agent({
  subagent_type: "developer",
  isolation: { dag_id: "DAG-2026-051", task_id: "T5.1", mode: "create" },
  prompt: `
    Implement T5.1 of DAG-2026-051.

    Goal: write 3 cookbook entries, 3 postmortems, gc-index.md,
    a gen-gcdb script, and a package.json script entry.

    Files to touch (your allow-list, do not commit anything else):
      - pi/docs/cookbook/*.md
      - pi/docs/postmortem/*.md
      - pi/docs/gc-index.md
      - pi/scripts/gen-gcdb.ts
      - pi/package.json

    Process (TDD-style for docs):
      1. Read reference goal contract at
         .pi/orchestrator/goal-GC-2026-047.yaml
         for shape and field names.
      2. Skeleton each cookbook entry as a stub with all headings
         (verifies the structure).
      3. Fill prose in each section.
      4. Run verification:
           ls docs/cookbook/*.md | wc -l    # ≥3
           ls docs/postmortem/*.md | wc -l  # ≥3
           grep -c 'GC-2026-' docs/gc-index.md   # ≥30
           bun scripts/gen-gcdb.ts
           bun test ./src ./test             # 733/733
      5. Commit: "feat: cookbook + postmortem + gc-index (GC-2026-051, T5.1)"

    Emit typed artifact on completion with status, findings,
    evidence (commit SHA + files_changed), validation verbatim,
    open_questions, confidence, what_i_did_not_check.

    Do NOT install packages. Do NOT touch files outside the allow-list.
    Do NOT skip the verification step.
  `,
  run_in_background: true,
  model: "<worker model>",
  effort: "medium",
})
```

The dispatcher rejects `isolation: undefined` and the legacy
`isolation: "worktree"` string. The three accepted shapes:

| Shape | When |
|---|---|
| `{ dag_id, task_id, mode: "create" }` | Fresh worktree per task (default for production code). |
| `{ dag_id, task_id, mode: "reuse" }` | Serial follow-up in the same worktree across multiple DAG tasks. |
| `"current-workspace"` | Meta-file edits / design-doc writes — opt-out for non-code surfaces. |

## When to use

- Any production-code change **> 2 lines** in `src/`, `test/`, `lib/`, `pi/`, or peer `pi-*/` packages.
- Cross-module refactor touching ≥ 2 files.
- Adding or modifying a public API (function signature, exported type).
- Build / CI / lint / typecheck config changes (anything that gates the suite).
- Dependency manifest edits (`package.json`, lockfiles).
- Test edits (yes, tests are CI-controlled code — same rule).
- Schema or wire-format changes with cross-package impact.

## When NOT to use

- **Doc-only edits** (markdown, design docs, comments). Use
  `isolation: "current-workspace"` + `tdd: "none"` instead — see
  `AGENTS.md` § "Root meta-files use current-workspace dispatch".
- **Questions and explanations.** The user asked a question; answer it
  in the main session. No DAG.
- **Single-line typo fix in a non-production file.** Pre-merge
  amendment commit is fine.
- **Pure exploration.** Use the built-in `Explore` subagent — read-only,
  no commit, no artifact.
- **Work you are about to abort.** Don't spawn to look thorough;
  spawning is overhead. Decide scope first.