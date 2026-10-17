# Detailed review of `pi-orchestrator/` (planning layer) — 2026 Q1

> **Phase:** Reviewer side of `task_review_pi_orchestrator_detailed` (intent
> for the detailed audit pass on the orchestrator planning layer).
> **Branch:** `review-pi-orchestrator-detailed`
> **Base:** `ea90646` (`main`)
> **Date:** 2026 Q1
> **Scope:** `pi-orchestrator/src/{extension.ts, orchestrator-tool.ts,
> phase-validation.ts, verdict.ts, brainstorming/*}` — the planning layer.
> **TDD discipline:** RED → GREEN → REFACTOR per finding; each finding
> has a failing test that drove its fix.

## 1. Method

Manual source read of every file in scope, plus a callgraph pass via
`grep -rn` from each LLM-facing tool to its consumers. Findings are
grouped into four categories:

  1. **Real correctness bugs** (F1)
  2. **Stale docstrings** (F2)
  3. **Type-system / API smell** (F3)
  4. **Dead stub parameters** (F4 — identified but out of scope for
     this review's TDD pass; documented below for follow-up)

## 2. Findings + fix commits

### F1 — `parseVerdict` regex fails on markdown-emphasized forms (REAL BUG)

`pi-orchestrator/src/verdict.ts:parseVerdict` returned `undefined` for
the canonical Reviewer output forms:

  - `**Verdict:** NEEDS_WORK` — the `**` between `:` and `NEEDS_WORK`
    wasn't consumed because `\s*` doesn't match `*`. The regex used
    `\*?\` (zero or one asterisk) at each side of the token, so only
    one of the two asterisks was consumed; the second one aborted the
    match.
  - `**CLEAN**` on its own line — the trailing `**` wasn't consumed
    before the line-end `$` anchor.

The Reviewer's standard output is plain text plus markdown emphasis
(SKILL.md / agent-tool-description both pin "**Verdict:** STATE" as
the canonical form). The bug silently drops the verdict on the most
common output shapes, so `task_consume` never reports `verdict` to the
LLM and the LLM never gets the verdict-tailored `follow_up_suggestion`.

**RED:** 3 failing tests in `test/verdict.test.ts` — `**Verdict:**
NEEDS_WORK`, `**CLEAN**` standalone, **`verdict:**TOKEN**` tight form,
plus a false-positive guard (`**important**`, `**VERY_CLEAN**` must
NOT match).

**GREEN (commit `eda5f5e`):** relax the regex from `\*?` to `\*{0,2}`
at every position, switch the post-separator block from `\s*` to
`[\s*]*`, and tighten the anchors with `\b` on both `verdict` and the
trailing token. Rule order in `validateRationale` / `validatePlanShape`
unchanged.

**Tests:** 5 new tests added; 273 → 278 → 300+ tests across the
suite, no regressions.

### F2 — Stale `orchestrate` tool references (DEAD DOCSTRINGS)

The `orchestrate` tool was retired by the
`orchestrator-simplify + remove-goal-contract + iterative-intent-plan`
cascade, but four files still reference it:

  - `pi-orchestrator/src/extension.ts:7,22,24,156` — package-level
    docstring (3 refs) + soft-mode reminder template + the
    `SOFT_MODE_REMINDER` user-visible text
  - `pi-orchestrator/src/index.ts:6` — public-surface docstring
  - `pi-orchestrator/src/brainstorming/index.ts:543` — `finalizeDesign`
    next-steps hint

Updated each to point at the six shipping consumer tools
(`task_inspect`, `task_consume`, `task_convert_intent`,
`task_plan_intent`, `task_add_phase`, `task_close_intent`). The
soft-mode reminder now suggests `task_convert_intent` (atomic) and
the iterative trio (multi-phase / multi-track /
investigate-then-fix), matching the actual tool surface and the
post-cascade test (`test/smoke/gc-2026-073.test.ts`) that asserts no
`orchestrate` tool exists.

**GREEN (commit `b880251`):** 3 files changed, 35 insertions(+),
18 deletions(-). No tests added (docstring-only); existing suite
unchanged (278 → 278 tests + the 22 from F3).

### F3 — `validatePlanShape` requires full `PlanShape` but only inspects `.phase` (REFACTOR)

`task_close_intent` runs the same shape-validation rules as
`task_convert_intent` but holds only a primitive `Phase[]` (the running
list from `metadata.planning.phases`) plus the rationale stamped at
`task_plan_intent` time. The structured `validatePlanShape(plan:
PlanShape)` requires a full `PlanShape` with `subject` / `description`
per phase, so the close path synthesised dummy values to satisfy the
type system:

```ts
// Before:
accumulatedPhases.map((p) => ({
  phase: p,
  subject: "_",
  description: "_",
}));
validatePlanShape({ intent_shape: …, rationale: …, phases: […synthesized…] });
```

The validator only inspects `.phase` — the placeholders exist purely
to satisfy TypeScript's type checker. This is a code smell: callers
that hold real phase arrays have to lie about shape content.

**RED:** 22 new tests in `test/phase-validation-final-shape.test.ts` —
one per rule per shape, plus rationale delegation, plus a primitive
acceptance test capturing the surface change.

**GREEN (commit `dbf4f0f`):** split the validator into a primitive
helper `validateFinalShape(shape, phases: Phase[], rationale)` plus a
4-line `validatePlanShape(plan)` wrapper that delegates. Rationale
length delegated to `validateRationale` so `RATIONALE_MIN_LENGTH` /
`RATIONALE_MAX_LENGTH` stay the single source of truth.

`task_close_intent` now calls `validateFinalShape` directly with the
primitive data it already has:

```ts
// After:
validateFinalShape(planning.shape, accumulatedPhases, planning.rationale);
```

Public API unchanged: callers using `validatePlanShape` continue to
work; the new helper is available to anywhere that holds primitive
phase data (in case any future caller wants it).

**Tests:** 22 new unit tests added; existing
`iterative-intent-plan.test.ts` close-time shape violation test still
passes (same error path, same message). 300 pass, 0 fail across the
full suite.

## 3. Identified but not addressed (F4 — out of TDD scope)

### F4 — Dead parameters in `brainstorming/index.ts` stub generators

Three of the brainstorming stub generators accept `request` (and
sometimes `intent`) but never read it:

  - `generateClarifyingQuestions(request, projectContext)` — `request`
    unused (line 153)
  - `generateApproaches(request, intent, projectContext)` — both
    `request` and `intent` unused (line 218)
  - `generateDesignSections(request, approach, projectContext)` —
    `request` unused (line 291)
  - `processDesigningPhase(stateMachine, request, ...)` — both
    `stateMachine` and `request` unused (line 508)

These are intentionally stub functions for the `/brainstorm` skill —
the SKILL.md drives the LLM to do the actual questioning through the
standard chat loop; the in-process helpers exist as a public surface
for tests (`test/tools/brainstorming/brainstorming-types.test.ts`).
Two reasonable directions:

  - **Delete the stubs entirely** — the public surface is unused by
    the runtime, so removing it removes dead parameters automatically.
    Risky because the surface is exported (`src/index.ts` re-exports
    `generateClarifyingQuestions`, etc.) and consumed by the test
    file. Would need a test-rewrite.
  - **Replace with `void` prefix + ESLint disable** — minimal change
    that preserves the surface.

Not in the TDD pass because:

  - The functions are explicitly *stubs* awaiting real implementation;
    pinning their current "ignores inputs and returns canned output"
    behavior as a test would institutionalize a placeholder.
  - Fixing them properly means either implementing them as
    project-context-aware generators (large scope) or deleting them
    (risk of breaking the public surface or tests).

Filed for follow-up as a separate `chore` GC.

## 4. Verification

```
$ cd pi-orchestrator
$ bun run typecheck        # PASS (tsc --noEmit, no output)
$ bun test ./test          # PASS — 300 tests, 0 fail across 16 files
```

## 5. Commit SHAs (worktree branch `review-pi-orchestrator-detailed`)

| Finding | SHA | Title |
|---|---|---|
| F1 (bug)  | `eda5f5e` | `fix(verdict): allow markdown emphasis around verdict tokens` |
| F2 (docs) | `b880251` | `docs(orchestrator): remove stale references to the removed \`orchestrate\` tool` |
| F3 (refactor) | `dbf4f0f` | `refactor(phase-validation): split validatePlanShape into a primitive Phase[] helper` |

Base SHA: `ea90646` (post `fix/board-watch-sucked-task-18` merge into
`main`).

## 6. Risks + follow-ups

  - **F3** keeps `validatePlanShape` as a backwards-compatible wrapper
    so no caller in `pi-orchestrator`/`pi-subagents`/`pi-tasks` needs
    updating. If a future caller wants to use `validateFinalShape`
    directly, the surface is public.
  - **F4** (dead stub parameters) should be a separate `chore` GC to
    either implement the brainstorming generators or delete the dead
    public surface.
  - **Brainstorming approval message** still references "Create MDD
    draft" (`brainstorming/index.ts:618`), a vestige of the removed
    `decompose_task` tool. Surface-only change, would need a test
    update to drive it correctly. Filer for follow-up.
