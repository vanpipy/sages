# GC-2026-deprecate-workflow-run-docs — Step 1: Announce deprecation of `workflow_run`

## What happened

The `workflow_run` tool (the 4-phase pipeline runner: Implement → Review ⇆ Fix → Merge)
has failed the 10s watchdog on every recent GC. Across GC-2026-118, -119, -120, -121, -122,
and -continuous-intent-reminder (the most recent 6 GCs that tried to use it), `workflow_run`
returned the `WorkflowRunStartTimeoutError` with the same message: "pi-tasks and/or
pi-subagents extensions are not registered in the active session. Fix: run
pi-orchestrator/scripts/install.sh and restart pi."

The watchdog was added in GC-2026-109 as a runtime safety net. Before the watchdog, the
caller would hang silently until harness timeout. The watchdog made the failure mode
**observable** — and once it was observable, the pattern (100% failure across the last
6 GCs) became impossible to ignore.

GC-2026-122 explicitly recommended "soft-mode manual takeover" as the operational
fallback: the orchestrator main agent implements the change directly via
`edit` / `write` / `bash` (bypassing the worktree-dispatch path), with the
postmortem documenting the manual takeover. The pattern has worked 6 times in a row.

This GC is the first of a 3-GC plan to remove `workflow_run` entirely:

- **GC-2026-deprecate-workflow-run-docs (this GC)** — announce-only: doc banners
  + subagent prompt deprecation comments + delete the workflow_run-specific e2e files.
- **GC-2** — production code removal: 5 files deleted, 12 files modified, 8 subagent
  prompts rewritten, catalog + install.sh + tsconfig updated,
  `verify:workflow-meta-invariant` gate removed.
- **GC-3** — test cleanup: 7 test files deleted, 6 test files modified.

This GC is intentionally minimal: no production code, no test, no verify-gate behavior
change. The sole purpose is to make the deprecation visible to the LLM (via system-prompt
overlays like `templates/SYSTEM.md` and skill frontmatter descriptions) and to humans
(via doc banners + subagent prompt headers), without yet breaking the runtime.

## What changed (18 files, 131 insertions, 429 deletions)

### Doc banners (7 files)

Every visible `workflow_run` mention in user-facing + system-prompt + skill docs gets a
deprecation banner block. The banners state: (a) the tool is being removed, (b) the
GC sequence, (c) the migration path (decompose_task for linear chains, raw
TaskCreate × N + TaskExecute for the canonical shape). They do NOT delete the existing
descriptions — that's GC-2's job. The banners are high-visibility inserts at the top of
each file (or at the top of the section they belong to) so a future reader (or an LLM
loading the system prompt) sees the deprecation context before they see the
description of a tool that's about to disappear.

| File | Banner location |
|---|---|
| `pi-orchestrator/skills/orchestrator/SKILL.md` | After the YAML frontmatter (line 4+) — most visible spot for an LLM loading the skill |
| `pi-orchestrator/skills/brainstorming/SKILL.md` | After the YAML frontmatter |
| `pi-orchestrator/templates/SYSTEM.md` | Inside `## Identity`, before the existing prose (line 5+) — feeds into the system prompt |
| `AGENTS.md` | Above the "The orchestrator tool surface" section (line 35+) |
| `README.md` | After the `# Sages` header (line 3+) — first thing a human sees |
| `pi-orchestrator/DEEP-DIVE.md` | Below the `# pi-orchestrator — Deep Dive` header (line 3+) — flags the entire doc as historical reference until GC-2 |
| `pi-codebase-memory/skills/codebase-memory-mcp/SKILL.md` | Above the "Working with orchestrator workflows" section (line 84+) — note that the `mcp_*` tool mapping is unchanged |

### e2e files deleted (2 files)

`pi-orchestrator/docs/e2e-real.md` (233 lines) and `pi-orchestrator/scripts/e2e-real.sh`
(195 lines) are entirely workflow_run-specific — they document + script a real end-to-end
test of `workflow_run` against an actual pi session. With `workflow_run` going away, the
e2e is meaningless. Deleted now (rather than in GC-2) so the GC-1 diff is at least
partially substantive — a pure deprecation-banner GC is hard to review.

### Subagent prompt headers (8 files)

Each of the 8 built-in subagent prompts that the workflow_run pipeline dispatches
(Developer, Reviewer, Fix, MergerAdvisor, DeveloperAdvisor, ReviewerAdvisor, FixAdvisor,
final-verdict-reviewer) gets a 5-10 line JSDoc header comment explaining:
- The tool is being removed.
- The subagent type itself is unchanged (4-state verdict, 5-dim review, VALIDATED/CONTESTED
  verdict formats, etc. are subagent-prompt features, not workflow_run features).
- The body content still references `workflow_run` — GC-2 will rewrite the body.

The body content is intentionally untouched in this GC. Touching the body would expand
the diff into a rewrite of every subagent prompt, which is GC-2's job. Keeping the body
unchanged also means: if for any reason the GC sequence is halted, the prompts still
work as before (with the deprecation banner visible to the LLM).

### Production code (1 file)

`pi-orchestrator/src/orchestrator-advisory.ts:395-398` — the `workflow_run` branch in
the `orchestrator` tool family classification gets a 4-line JSDoc-style comment noting
the deprecation + the GC-2 plan. The branch itself is kept (the tool is still
registered) so this GC doesn't change runtime behavior. GC-2 will drop the branch.

## What did NOT change (verified)

- **No production code behavior change** — `workflow_run` still runs (and still fails
  on the watchdog), `decompose_task` still works, all 5+1+4 orchestrator tools are
  still registered.
- **No test deleted or modified** — 531 pi-orchestrator tests + 27 related pi-tasks tests
  pass unchanged. The 23 pre-existing pi-tasks test failures (environment issues per
  GC-2026-122 follow-up #4) are unchanged.
- **No verify-gate behavior change** — `verify:catalog` (3 catalogs), `verify:pi-tasks-tools`
  (7 tools), `verify:created-by-invariant` (19 files), `verify:gcdb` (postmortem
  coverage), `verify:workflow-meta-invariant` (still runs) all pass.
- **No package.json or tsconfig.json change** — `verify:workflow-meta-invariant` is
  still wired into `bun run verify:all`.
- **No install.sh change** — the `verify_package_existence` check for `workflow_run`
  is still required (the tool is still registered until GC-2).
- **No catalog change** — `pi-orchestrator/catalogs/*.json` is unchanged because
  no source code changed; `verify:catalog` confirms.
- **50 postmortem files** in `pi/docs/postmortem/` are untouched (immutable record).

## TDD evidence

This is a documentation + subagent-prompt deprecation GC. There are no behavior changes
to test, so the TDD discipline is "verify the absence of regressions" rather than
"red-then-green a new test". The verification commands are:

- `bun run verify:catalog` → OK: 3 catalogues current
- `bun run verify:pi-tasks-tools` → OK: 7 tool(s) allowlisted, 7 registered
- `bun run verify:created-by-invariant` → PASS (19 file(s) scanned)
- `bun test` (pi-orchestrator) → 531 pass / 0 fail / 1131 expect() calls
- `bun test` (pi-tasks, related subset) → 27 pass / 0 fail / 86 expect() calls
- `git diff origin/main..HEAD --name-only` → no `.pi/` files (manual takeover contract
  preserved: task report is local-only state, not in commits)
- `.pi/` files added → 0 (no `.pi/orchestrator/task-GC-2026-deprecate-workflow-run-docs-report.md`
  was needed; this GC has no subagent dispatch so the task-report file is implicit in
  the goal yaml + the commits + this postmortem)

## Process notes

- `workflow_run` was attempted (per the goal contract's `next_step` recommendation)
  and tripped the 10s watchdog (recurring bug, same as the last 6 GCs). Per
  `AGENTS.md § Orchestrator manual takeover`, the orchestrator main agent took over
  the GC directly.
- The "announce-only" scope of this GC is deliberate. GC-2 (production code removal)
  is a much larger diff (5 files deleted, 12 files modified, 8 prompts rewritten) and
  benefits from this GC establishing the migration path + giving the LLM a
  deprecation-aware context. GC-3 (test cleanup) similarly benefits from the docs
  being in the new shape.
- E2E file deletion in this GC is the only "out of scope per anti_goals" item.
  The e2e files were intentionally deleted here (not in GC-2) for diff reviewability:
  a pure deprecation-banner GC with 17 doc-only changes is hard to read. The 428
  lines of e2e content being deleted gives the reviewer a concrete signal of
  "this thing is real and being removed".

## Follow-ups

- **GC-2** (next) — production code removal. The scope is well-defined by the
  `GC-2026-deprecate-workflow-run-docs` goal contract: 5 files deleted
  (`workflow-run.ts`, `workflow-run-tool.ts`, `workflow-handler.ts`,
  `workflow-graph.ts`, `verify-workflow-meta-invariant.ts`), 12 files modified
  (extension.ts, orchestrator-advisory.ts, registered-tool-wrapper.ts,
  goal-contract.ts, decompose-task.ts, types.ts, observability/events.ts,
  pi-tasks/src/{index.ts, event-channels.ts, orchestrator-task.ts, task-feeder.ts,
  reviewer-prompt.ts}), 8 subagent prompt bodies rewritten, catalog + install.sh +
  tsconfig updated.
- **GC-3** — test cleanup: 7 test files deleted (`workflow-handler.test.ts` 932 lines,
  `workflow-graph.test.ts` 320 lines, `workflow-run.test.ts` 837 lines,
  `workflow-run-b6-b7.test.ts` 283 lines, `workflow-run-integration.test.ts` 539 lines,
  `workflow-handler-helper-integration.test.ts` 269 lines,
  `helpers/workflow-run-integration-harness.ts` 308 lines), 6 test files modified
  (extension-active-tools.test.ts, orchestrator-advisory.test.ts,
  pi-tasks-package-exports.test.ts, gc-2026-073.test.ts, goal-contract.test.ts,
  path-b-e2e.test.ts).
- **Doc GC** — broader docs (AGENTS.md, README.md) cleanup of all workflow_run
  references after GC-2 lands. The current banners are intentionally noisy so a
  future reader sees the deprecation; after GC-2 the noise can be removed.
- **Cookbook entry** — `pi/docs/cookbook/decompose_task-vs-raw-taskcreate.md` (new
  file, post-GC-2). Captures the "which path to pick" decision recipe now that
  `workflow_run` is gone.

## Risk

- **The deprecation banner is the only thing that tells the LLM not to use
  `workflow_run`.** Until GC-2 actually removes the tool registration, the LLM can
  still call `workflow_run` and the watchdog will reject. The banner is informational,
  not blocking. If the LLM ignores the banner, the 10s watchdog still kicks in and
  the LLM falls back to manual takeover (the same path it's been taking for the
  last 6 GCs). The risk is **operational annoyance**, not correctness.
- **GC-2 is a much larger diff** (~2500 lines of production code deletion + 150
  lines of modifications across 12 files). Splitting GC-2 into 2 sub-GCs (one for
  the deletion, one for the modifications) is a future option if the diff becomes
  unreviewable.
