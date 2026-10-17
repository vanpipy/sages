# `task_review_pi_orchestrator_detailed` — metadata.result

> Result summary for the dispatched review of the `pi-orchestrator`
> planning layer (`extension.ts`, `orchestrator-tool.ts`,
> `phase-validation.ts`, `verdict.ts`, `brainstorming/*`). Written by
> the `Developer` subagent that landed the three follow-up commits.

## Verdict: CLEAN (no follow-up work needed for F1/F2/F3; F4 deferred)

The detailed review found 3 actionable findings and 1 deferred finding.
All 3 actionable findings are now landed on the worktree branch
`review-pi-orchestrator-detailed` with RED → GREEN → REFACTOR
discipline. Test suite green (300 pass / 0 fail across 16 files);
typecheck clean.

## Commit SHAs

| Finding | Type | SHA       | Subject |
|---------|------|-----------|---------|
| F1      | fix  | `eda5f5e` | `fix(verdict): allow markdown emphasis around verdict tokens` |
| F2      | docs | `b880251` | `docs(orchestrator): remove stale references to the removed \`orchestrate\` tool` |
| F3      | refactor | `dbf4f0f` | `refactor(phase-validation): split validatePlanShape into a primitive Phase[] helper` |

Branch: `review-pi-orchestrator-detailed` (worktree at
`.pi/worktree/review-pi-orchestrator-detailed/`).
Base: `ea90646` (main, post `fix/board-watch-sucked-task-18`).

## Findings

### F1 — REAL BUG: `parseVerdict` rejects markdown-emphasized forms

`pi-orchestrator/src/verdict.ts:parseVerdict` returned `undefined` for
the canonical Reviewer output:
  - `**Verdict:** NEEDS_WORK` (the canonical form, pinned in
    `templates/agent-tool-description.md`)
  - `**CLEAN**` on its own line
  - `verdict:**TOKEN**` (no whitespace between `:` and `**`)

Fix: relax regex from `\*?` to `\*{0,2}`; add `[\s*]*` after the
separator to consume any mix of spaces and asterisks. Tighten with
`\b` anchors to keep `**VERY_CLEAN**` etc. as false-positive guards.
5 new tests; 273 → 278+ across the suite.

### F2 — DEAD DOCSTRINGS: stale references to the removed `orchestrate` tool

4 files (`src/extension.ts` × 3 refs + soft-mode reminder template,
`src/index.ts:6`, `src/brainstorming/index.ts:543`) still reference
the `orchestrate` tool that was retired by the
orchestrator-simplify + remove-goal-contract + iterative-intent-plan
cascade. Fixed by pointing each reference at the actual six shipping
consumer tools (`task_inspect`, `task_consume`, `task_convert_intent`,
`task_plan_intent`, `task_add_phase`, `task_close_intent`) and the
soft-mode reminder at `task_convert_intent` + the iterative trio. 3
files changed, 35 insertions(+), 18 deletions(-).

### F3 — REFACTOR / API smell: `validatePlanShape` required full `PlanShape` but only inspected `.phase`

`task_close_intent` had to synthesise
`{ phase, subject: '_', description: '_' }` placeholders for every
phase in its accumulated `Phase[]` to satisfy the structured
`validatePlanShape(plan: PlanShape)` type. The validator only ever
read `.phase` — the placeholder strings were a type-system-only
workaround. Split into a primitive helper
`validateFinalShape(shape, phases: Phase[], rationale)` plus a 4-line
`validatePlanShape(plan)` wrapper that delegates. Rationale length
delegated to `validateRationale` so the bounds stay in one place.
22 new tests in `test/phase-validation-final-shape.test.ts`;
`task_close_intent` now calls `validateFinalShape` directly.

### F4 — DEFERRED: dead parameters in `brainstorming/index.ts` stub generators

`generateClarifyingQuestions(request, projectContext)`,
`generateApproaches(request, intent, projectContext)`,
`generateDesignSections(request, approach, projectContext)`, and
`processDesigningPhase(stateMachine, request, ...)` accept parameters
they never read. These are intentional stubs for the `/brainstorm`
skill — the runtime uses SKILL.md directly, the in-process helpers
are a public surface for tests. Two reasonable fixes (delete the
surface; or `void` prefix + ESLint disable) but neither is purely
mechanical — both touch the exported API surface and the brainstorming
test file. Filed for follow-up as a separate `chore` GC.

## Verification evidence

```
$ cd pi-orchestrator
$ bun run typecheck        # PASS (tsc --noEmit, no output)
$ bun test ./test          # PASS — 300 tests across 16 files, 715 expect() calls
```

Detailed audit doc: `pi/docs/audits/review-pi-orchestrator-2026-Q1.md`.
