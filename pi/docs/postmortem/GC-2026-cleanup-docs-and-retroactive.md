# GC-2026-cleanup-docs-and-retroactive — Doc cleanup + cookbook + pi-subagents cosmetic + 5 retroactive postmortems

## What happened

After the 3-GC workflow_run removal (deprecate → prod → tests), the
Sages docs still carried deprecation banners and a historical
narrative about a tool that no longer exists. The pi-subagents
source files still had doc comments mentioning `workflow_run`. 5
historical GCs (076, 081, 085, 086, 094) lacked postmortems, leaving
the `verify:gcdb` institutional coverage gate at 9/10.

This GC is the final cleanup pass: drop the deprecation banners,
drop the workflow_run narrative in 7 doc files + 6 pi-subagents
source files, add a new cookbook entry for the post-removal decision
recipe, and write 5 retroactive postmortems to fill the
`verify:gcdb` gap.

## What changed (20 files, ~600 insertions, ~60 deletions = net +540)

### 7 doc files (deprecation banners + workflow_run narrative removed)

- `pi-orchestrator/skills/orchestrator/SKILL.md` — frontmatter
  description rewritten to mention only `decompose_task` (no
  `workflow_run`). The GC-1 deprecation banner replaced with a
  "Removed in GC-2026-remove-workflow-run-prod" historical note.
- `pi-orchestrator/skills/brainstorming/SKILL.md` — the GC-1
  deprecation banner removed.
- `pi-orchestrator/templates/SYSTEM.md` — the `## Identity` section
  rewritten to describe the post-removal architecture
  (`goal_contract_create` + `decompose_task` only; canonical 4-phase
  shape built via raw `TaskCreate` × N + `TaskExecute`).
- `pi-orchestrator/DEEP-DIVE.md` — top banner rewritten to "Post-GC-2026-remove-workflow-run-prod
  architecture reference". The 3-layer table updated
  (Planning: no more `workflow_run`; Tracking: no more
  `workflow:phase-complete` events). The mermaid diagram nodes for
  `workflow_run` / `workflow:start` / `workflow:phase-complete` marked
  "(REMOVED: ...)" for historical reference. Path A section renamed
  "Path A — workflow_run (REMOVED; historical reference)".
- `AGENTS.md` — the GC-1 deprecation banner replaced with a
  "Removed in GC-2026-remove-workflow-run-prod" note pointing to
  the orchestrator SKILL.md for the post-removal decision recipe.
- `README.md` — the GC-1 deprecation banner removed.
- `pi-codebase-memory/skills/codebase-memory-mcp/SKILL.md` — the
  "Working with orchestrator workflows" section's GC-1 deprecation
  banner replaced with a "post-3-GC" note.

### 6 pi-subagents source files (doc comments updated; runtime unchanged)

- `pi-subagents/src/agent-manager.ts` — the `workflowContext`
  field's JSDoc updated to describe the post-removal usage
  (orchestrator's LLM-driven multi-phase DAG, not workflow_run).
- `pi-subagents/src/run-controller.ts` — 2 comments updated
  (`max_fix_iterations=3 workflow_run doesn't bottom out the budget` →
  `multi-phase DAG with a deep Fix loop doesn't bottom out the budget`;
  `MergerAdvisor handles workflow_run's single-workspace advisory merge`
  → `dispatched by the orchestrator main agent after a CLEAN verdict`).
- `pi-subagents/src/default-agents.ts` — 2 comments updated
  (MergerAdvisor's `MergerAdvisor is the workflow_run Merge-phase agent`
  → `MergerAdvisor is the post-Implement advisory-merge agent`; the
  tool description updated to mention the post-removal dispatch
  mechanism).
- `pi-subagents/src/types.ts` — 2 comments updated (the
  `aborted because the parent signal fired (..., or workflow_run aborted
  the cascade)` and the `workflowContext` JSDoc).
- `pi-subagents/src/ui/agent-widget.ts` — the `workflow_run` mention
  in the workflow badge comment updated to "phase task of a multi-phase DAG".

### 1 new cookbook entry

- `pi/docs/cookbook/decompose_task-vs-raw-taskcreate.md` — the
  post-removal decision recipe. Structured per the cookbook's
  fixed shape: Problem → Solution → Code → When to use → When NOT
  to use → See also. Includes a comparison table (work shape →
  path) and explicit "don'ts" (e.g. "don't use `decompose_task` for
  a 4-phase review pipeline"; "don't add a `Merge` phase to a
  `decompose_task` chain").

### 5 retroactive postmortems

These 5 GCs (076, 081, 085, 086, 094) shipped before `verify:gcdb`
required a postmortem, or were carved out. This GC writes
short postmortems for each (30-80 lines each) following the
institutional fixed shape: frontmatter `gc_id` / `title` /
`severity` + body `What happened → Root cause → Fix → Follow-ups`.

- `GC-2026-076.md` — FIRST tool priorities (P1 orchestrator
  tool-adoption + P2 6-agent FIRST sections). Minor severity.
- `GC-2026-081.md` — Expose `todowrite` + `todowrite_compile` +
  `todowrite_progress` in the orchestrator active toolset. Minor.
- `GC-2026-085.md` — Wrap orchestrator todowrite tool returns in
  ToolResult shape (left out of GC-2026-089). Minor.
- `GC-2026-086.md` — Expose `aft_*` + `ctx_*` tools in the
  orchestrator active toolset. Minor.
- `GC-2026-094.md` — Consume verdict-file fallback in audit gate.
  Minor.

### 1 gc-index update

- 5 retroactive postmortem rows + 1 cleanup-GC row added. The
  previous table had 2 carved-out GCs (097, chat-stream-render) and
  the 5 retroactive postmortems are now formally covered. The
  `Open / no postmortem` section is reduced to just the 2 carved
  GCs (which were always intentional defers).

## What did NOT change

- **No production code logic change** — the 6 pi-subagents source
  file edits are all JSDoc / doc-comment updates + 1 short string
  literal in `default-agents.ts` (the `MergerAdvisor` tool's
  description). The runtime behavior of the 11 built-in subagents
  is identical.
- **No test file change** — the cookbook entry is documentation;
  the 5 retroactive postmortems are documentation; the 6 doc
  comments are documentation. The 0 new test regressions
  invariant is preserved.
- **No new tool / no new function / no new export** — this is a
  pure documentation GC.
- **No `install.sh` / `verify-*.ts` / `package.json` / `catalog`
  change** — already done in GC-2.
- **50 existing postmortem files** in `pi/docs/postmortem/` are
  immutable and not touched.

## TDD evidence

This is a documentation GC. The TDD discipline is "verify the
absence of regressions" rather than "red-then-green a new test".

| Step | State | Detail |
|---|---|---|
| Pre-GC | 7 docs carry GC-1 deprecation banners; 6 pi-subagents source files have workflow_run doc references; 5 GCs lack postmortems; `verify:all` at 9/10. |  |
| Post-doc-cleanup | 7 docs reflect the post-removal architecture. 6 pi-subagents source files have post-removal doc comments. |  |
| Post-retroactive-postmortems | `verify:gcdb` now covers all 5 retroactive GCs + this cleanup GC. |  |
| Full pi-orchestrator suite | 503 pass / 0 fail (unchanged from GC-F) |  |
| Full pi-tasks suite | 9 skip + 2 unique fail (the 2 known-issues from GC-F) + 22 errors (env) | Same as GC-F. |
| Full pi-subagents suite | 8 skip + 2 unique fail (the 2 known-issues) + 8 errors (env) | Same as GC-F. |
| `verify:all` | **10/10** (was 9/10) | The 5 retroactive postmortems are now in `verify:gcdb` coverage. |

## Process notes

- The DEEP-DIVE.md cleanup was the most invasive doc change: the
  mermaid diagram has 3 nodes that are now "(REMOVED: ...)" rather
  than deleted, to preserve the GC timeline visualization. The
  "Path A" section is renamed but its content (describing the
  pre-removal 4-phase pipeline) is kept as historical context.
- The cookbook entry follows the fixed shape from the cookbook
  spec (Problem → Solution → Code → When to use → When NOT to use
  → See also). The "When NOT to use" section is the most
  important — it captures the misuses the LLM is likely to make
  post-removal (e.g. "don't use `decompose_task` for a 4-phase
  review pipeline").
- The 5 retroactive postmortems are intentionally short (30-80
  lines each) per the existing retro-postmortems style
  (`GC-2026-institutional-coverage.md`). They document the
  what/why but not the full implementation details (those are
  available via `git log --follow <goal-yaml>`).
- The `pi-subagents` source-file edits are all comment-only. The
  `default-agents.ts` edit to the `MergerAdvisor` tool description
  is the only "real" change (1 string literal updated). This is
  what the LLM sees in `Agent({ subagent_type: "MergerAdvisor" })`
  invocation, so accuracy matters.

## Follow-ups

- **GC-2026-fix-run-controller-flaky** (future) — track down the
  test pollution that causes `DEFAULT_BUCKET_TIMEOUTS_MS` to fail
  in the full suite. Documented in `GC-2026-cleanup-test-regression.md`.
- **GC-2026-fix-diagnostic-flaky** (future) — track down why
  `pruneOldDiagnostics(dir, 0)` doesn't find the files the test
  wrote. Documented in `GC-2026-cleanup-test-regression.md`.
- **Cookbook expansion** — future GCs may add more cookbook
  entries (e.g. `cookbook/reviewer-verdict-format.md`,
  `cookbook/merger-advisor-vs-merger.md`). The fixed shape
  (Problem → Solution → Code → When to use → When NOT to use)
  is established by this entry.
- **DEEP-DIVE.md full rewrite** — this GC only updated the top
  banner + the 3-layer table + the Path A heading. The
  mid-document content still references the pre-removal
  architecture in places. A future GC could do a full rewrite
  to make the doc a clean post-removal reference.
