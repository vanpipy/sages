# GC-2026-verdict-states-and-dynamic-cascade

**Severity**: major
**Date**: 2026-10-04
**Status**: ready-for-review
**Branch**: `main` (committed via direct worktree; original workflow_run dispatch aborted at max_turns)

## What happened

Two structural rigidity issues were found in path B's
Implement → Review ⇆ Fix → Merge workflow. They collapse into one GC
because they share the same surface (workflow-graph.ts +
workflow-handler.ts):

1. **verdict 二态化**:`ReviewerVerdict` only had CLEAN / NEEDS_WORK.
   Real Reviews encounter three structurally-different failure modes
   that need different pipeline dispositions, all squashed into a
   single path:
   - 局部代码 bug → Fix 可以修补（NEEDS_WORK，现有路径）
   - 架构选型错了 → Fix 修不了，需要新 Implement（NEEDS_REDESIGN，
     之前无对应状态，Fix 试图局部修补但根本无法解决）
   - goal 本身定义模糊 → 应该停下来问用户（NEEDS_CLARIFICATION，
     之前无对应状态，Fix 收到错误信号继续空转）

2. **静态图无条件预创建 Fix**:`buildStaticWorkflowGraph` 在
   workflow:start 时一次性创建 max_fix_iterations 个 Fix 任务。
   Review_N=CLEAN 时 Fix_N 仍被 dispatch（发空提交）。一轮干净通过
   浪费了一次 dispatch，且 Fix 的存在让 Review_N+1 的 blockedBy
   指向了一个永远会运行的 Fix（即使该 Fix 是 no-op）。

GC-1+GC-2 已经把 parser / safety / model inheritance 修干净了，
这个 GC 解决流水线本身的两个刚性。

## Root cause

Three structural patterns that drift into rigidity over time:

- **A. "verdict 二态化"是早期 path A 的简化选择。** path A 的实现
  review 用 DAG 工具评估 SC，原 FSMD 模型把"重设计"和"提问"都
  编码为 NEEDS_WORK（让 Fix 任务尽力而为）。 path B 的事件流重写了
  cascade，但 verdict schema 没改 — `ReviewerVerdict` 接口还是 2 态。
- **B. 静态图是 path A state machine 的简化重写。** path A 的循环
  in-process，重写 path B 时为简化 event handler 静态预创建所有
  Fix。CLEAN path 的空 commit 是当时接受的代价。
- **C. state.iterations_used 字段语义错位。** 原意是 Fix dispatch
  计数，实际赋的是 lastReviewIteration。命名的失误，但 pre-existing。

## Fix

6 commits on `main` (post-merge into GC-2026-verdict-states-and-dynamic-cascade):

1. `ef42e37 feat(verdict): 4-state verdict (CLEAN/NEEDS_WORK/
   NEEDS_REDESIGN/NEEDS_CLARIFICATION)` — parser 类型扩展到
   `ReviewerVerdictValue` 4 态 union；新增 `open_question?: string`
   字段；新增 6 个 parser 测试覆盖新状态。
2. `7bbafb1 refactor(workflow-graph): static chain without Fix
   pre-creation + dynamic dispatch` — `buildStaticWorkflowGraph`
   不再预创建 Fix 任务，max_fix_iterations=3 时静态图只有 5 个
   任务（Implement + 3 Reviews + Merge）；新增 `buildFixTaskSpec` +
   `buildRedesignImplementTaskSpec` 两个 helper 给 workflow-handler
   做按需 dispatch。
3. `2f80ff2 feat(workflow-run): 4-state verdict + max_redesigns +
   clarification pause` — `WorkflowRunInput.options.max_redesigns`
   新增；`PhaseCompleteEvent.status` 加 `needs_clarification`；
   `WorkflowState` 加 `redesigns_used`；新增 `buildClarificationOutput`
   helper；新增 NEEDS_REDESIGN / needs_clarification 两种 resolve
   路径。
4. `1bb895a merge(GC-2026-verdict-states-and-dynamic-cascade):
   4-state verdict + dynamic cascade + workflow-run pause path` —
   把 worktree branch 的 verdict-parser / workflow-graph /
   workflow-handler 改动合到 main。
5. `b196977 test+docs: cascade tests + final-verdict-reviewer 4-state
   schema` — `_sections/final-verdict-reviewer.ts` schema 文档化 4
   态 + `open_question` 字段 + 多种 malformed 组合的降级规则；
   `test/workflow-handler.test.ts` 重写（17 个测试覆盖 4 态 dispatch
   + 链 + cap）；`test/workflow-graph.test.ts` 重写（8 个测试覆盖
   5-task 静态图 + buildFixTaskSpec + buildRedesignImplementTaskSpec）；
   `test/path-b-e2e.test.ts` 重写（13 个测试覆盖 all-CLEAN 5-spawn
   + NEEDS_WORK 7-spawn + real-id cascade）。

## Verification

- `bun run typecheck` — green across `pi-orchestrator`,
  `pi-subagents`, `pi-tasks`.
- `bun test test/workflow-handler.test.ts` — 17 pass, 0 fail
  (4-state dispatch + clean cascade + NEEDS_WORK cap + NEEDS_REDESIGN
  cap + NEEDS_CLARIFICATION pause).
- `bun test test/workflow-graph.test.ts` — 8 pass, 0 fail
  (5-task static + dynamic spec builders).
- `bun test test/path-b-e2e.test.ts` — 13 pass, 0 fail
  (all-CLEAN 5-spawn + NEEDS_WORK 7-spawn + real-id cascade).
- `bun test test/verdict-parser.test.ts` — 22 pass, 0 fail
  (4-state verdict + open_question + file-fallback + strict dim).
- `bun test test/sections-drift.test.ts` (pi-subagents) — 11 pass.
- `bun run check:all` (pi-orchestrator pre-commit hook) — 475 pass,
  0 fail.

## Done-definition verification

| # | Item | Status |
|---|---|---|
| 1 | ReviewerVerdict widens to 4-state union | ✓ commit `ef42e37` |
| 2 | verdict-parser correctly parses 4 states; strict dim + file-fallback preserved | ✓ commit `ef42e37` + 22 parser tests |
| 3 | `buildStaticWorkflowGraph` no longer pre-creates Fix — max=3 → 5 tasks (was 7) | ✓ commit `7bbafb1` + 8 graph tests |
| 4 | workflow-handler 4-state cascade (NEEDS_WORK → Fix; NEEDS_REDESIGN → new Implement; NEEDS_CLARIFICATION → pause) with caps | ✓ commit `7bbafb1` + 17 handler tests |
| 5 | workflow-run.ts:resolve accepts 4 verdicts; `lastReviewVerdict === "CLEAN"`; redesigns exhausted → blocked; `last_review_iteration` rename + `redesigns_used` | ✓ commit `2f80ff2` + WorkflowRunInput/Output schema updates |
| 6 | reviewDescription documents 4-state verdict + open_question + when to choose each | ✓ commit `7bbafb1` (workflow-graph.ts:88-148) + commit `b196977` (final-verdict-reviewer.ts:23-86) |
| 7 | Reviewer prompt FINAL_VERDICT_REVIEWER_SECTION schema documents 4 states + NEEDS_CLARIFICATION open_question requirement | ✓ commit `b196977` |
| 8 | Cascade no longer creates redundant Fix tasks: tests cover max=3 + all-CLEAN → 5 spawns (Implement + 3 Reviews + Merge, no Fix) | ✓ commit `b196977` (path-b-e2e.test.ts:138-152) |
| 9 | All tests pass; postmortem + gc-index updated | ✓ this file + `pi/docs/gc-index.md` |

## Pipeline behavior matrix (post-GC)

| Review verdict | Cascade response | Constraint | Phase-complete status |
|---|---|---|---|
| CLEAN | proceed to next phase | — | "completed" |
| NEEDS_WORK | spawn Fix → Review loop | iterations_used < max_fix_iterations | "completed" |
| NEEDS_REDESIGN | spawn new Implement → Review_1 (chain reset) | redesigns_used < max_redesigns (default 1) | "completed" |
| NEEDS_CLARIFICATION | pause workflow, surface open_question | — | "needs_clarification" |
| any + dim_check fail | downgrades to NEEDS_WORK regardless of verdict | — | "completed" |
| NEEDS_WORK iterations exhausted | resolve as blocked | iterations_used >= max_fix_iterations | "completed" |
| NEEDS_REDESIGN redesigns exhausted | resolve as blocked | redesigns_used >= max_redesigns | "completed" |
| subagent failed | revert to pending + lastError, resolve as blocked | — | "failed" |

## Follow-ups (out of scope for this GC)

1. **Merger consume Reviewer evidence** (B7). The Merger still
   doesn't read the Reviewer's structured `evidence` block. With
   the 4-state verdict + open_question, the Merger has a richer
   signal to consume. Belongs in a separate GC.
2. **Iteration-aware review** (B6). Reviewer still doesn't compare
   prior Review's findings to current — no regression / unresolved /
   new grouping. Belongs in a separate GC.
3. **Drift-test concurrency** in `bash-timeout-prompt.test.ts`.
   Pre-existing flaky tests, not introduced by this GC. Still
   tracked from GC-1 follow-ups.
4. **NEEDS_CLARIFICATION resume semantics**. The orchestrator main
   agent has to handle the `needs_clarification` workflow-run output
   by surfacing the `open_question` to the user. The follow-up turn
   (user answers, orchestrator re-dispatches workflow_run with a
   clarified goal) is not yet wired — currently the workflow just
   blocks. Consider a `workflow_run` option `resume_from_state:
   "needs_clarification"` that picks up where the paused run left off.
5. **`agent_overrides.fix` doesn't yet select DEVELOPER_FIX_PROMPT**.
   The DEVELOPER_FIX_PROMPT was added in GC-1 but no dispatch path
   actually uses it; the workflow-handler dispatches "Developer"
   with the full DEVELOPER_PROMPT. Follow-up to wire
   `agent_overrides.fix = "Developer"` → DEVELOPER_FIX_PROMPT selection.

## Lessons learned

- **Verdict schema upgrades touch every layer.** Adding 2 verdict
  states (NEEDS_REDESIGN, NEEDS_CLARIFICATION) required changes in:
  - parser (ReviewerVerdictValue type)
  - workflow-graph (reviewDescription schema documentation)
  - workflow-handler (4-way branch + counter caps)
  - workflow-run (PhaseCompleteEvent status + new resolve paths)
  - WorkflowRunOutput (new fields: redesigns_used, open_question)
  - WorkflowStartPayload (max_redesigns)
  - WorkflowState (redesigns_used)
  - Reviewer prompt (final-verdict-reviewer.ts)
  - tests (parser + handler + graph + e2e + sections-drift)

  Plan for ~30 file touches. The done-definition list got 9 items
  and was right.
- **`void <NAME>;` and "the task will be wired later" are debt
  magnets.** The same pattern from GC-1 (4 void-suppressed sections)
  didn't bite here, but the "static graph pre-creates everything" was
  the same flavor: "good enough for now, dynamic later". The GC made
  it dynamic. Same lesson.
- **Soft-mode contract rescue worked again.** The workflow_run
  dispatch for this GC was aborted by max_turns (Developer agent
  hit the turn cap). The orchestrator-side takeover (per
  soft-mode manual-takeover contract) proceeded on the same
  worktree branch with the abort-Developer as a stand-in for
  context. The full GC landed across 4 commits in one takeover
  session.
- **Tests are the contract.** Updating 3 test files in lockstep
  with the source changes (workflow-handler.test.ts 17 tests,
  workflow-graph.test.ts 8 tests, path-b-e2e.test.ts 13 tests) was
  the only way to catch the cascade shape change. The pre-existing
  `vi.hoisted is not a function` errors in store-scope /
  agent-reattach tests are NOT from this GC — they exist on main
  (pre-existing vitest version mismatch).

Refs: GC-2026-verdict-states-and-dynamic-cascade
