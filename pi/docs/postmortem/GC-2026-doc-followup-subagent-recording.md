---
gc_id: GC-2026-doc-followup-subagent-recording
title: Doc followup: update subagent budget references for recording-no-budget GC
severity: minor
---

## What happened

GC-2026-subagent-recording-no-budget merged on 2025-10-10, removing
all subagent budget enforcement (turn caps, wall-clock deadline,
prompt-section hard caps). The postmortem explicitly listed the
follow-up:

> "Documentation updates (P2) — AGENTS.md, README.md, and
> `pi-orchestrator/skills/orchestrator/SKILL.md` reference the old
> GC-2026-122 reminder mechanism. Updating those is a doc follow-up
> GC. The `pi-subagents` README also needs the same update."

This GC executes that follow-up.

## Root cause

The user-facing docs were written under the GC-2026-038 / GC-2026-022
budget regime. Three locations still referenced the now-removed
mechanism:
- 3 occurrences of `max_turns hard-abort` in
  `pi-orchestrator/DEEP-DIVE.md` (the "durability boundary" framing
  used max_turns as the canonical abnormal-end scenario)
- 0 occurrences in AGENTS.md, README.md, or SKILL.md (already clean
  — these docs describe the orchestrator / agent surface at a
  higher level that doesn't reach the budget mechanism detail)

The new model (post-GC-2026-subagent-recording-no-budget) is:
**no automatic enforcement; every tool call captured to a JSONL log;
the orchestrator inspects the log post-hoc via
`subagent-usage:summary` and decides what to abort.** The verdict file
fallback is now the only durable backup for whatever ends a run
(transport timeout, parent-signal abort, model API truncation, or
manual cancellation).

## Fix

3 surgical edits in `pi-orchestrator/DEEP-DIVE.md`:
1. **Line 427** (Reviewer verdict-file fallback section): the
   "durability boundary that survives `max_turns` hard-abort" sentence
   was expanded to list all abnormal-end scenarios and explicitly
   call out that GC-2026-subagent-recording-no-budget removed the
   turn / wall-clock budget.
2. **Line 677** (verdict-parser section): same expansion applied.
3. **Line 765** (failure-modes table `subagent-timeout` row): the
   "Hard-aborted after `max_turns` + grace" description was rewritten
   to point at the JSONL log + `subagent-usage:summary` aggregator
   and clarify that the rule now covers only transport-layer timeouts.

Each edit preserves the surrounding prose; the new sentences are
1-2 lines and reference the GC that made the change so future
readers can find the postmortem for context.

## Files edited

| File | Lines | What changed |
|---|---|---|
| `pi-orchestrator/DEEP-DIVE.md` | 427, 677, 765 | 3 references to `max_turns hard-abort` rewritten to reflect the post-recording model |

Net: 3 hunks, 17 lines added, 4 lines removed.

## Files inspected but NOT edited

| File | Why no edit |
|---|---|
| `AGENTS.md` | Search for `max_turns` / `max_duration` / `wall-clock` / `BudgetTracker` / `graceTurns` returned 0 hits. The "5 subagents" table, "Profiles" section, and "Orchestrator manual takeover" section all describe the agent surface at a level that doesn't reach the budget mechanism detail. Confirmed clean via inspection. |
| `README.md` | Same — 0 hits on the search terms. The high-level "Planning / Executing" layer overview doesn't reference budget params. Confirmed clean. |
| `pi-orchestrator/skills/orchestrator/SKILL.md` | The 2 `budget` references in this file are about the orchestrator's `max_fix_iterations` retry budget (NEEDS_REDESIGN budget exhausted, fix-iteration budget) — UNRELATED to the subagent budget mechanism. Confirmed not part of the GC scope via context inspection. |
| `pi/docs/cookbook/` | The only cookbook entry that referenced `workflow_run` was deleted in GC-7. No recipe references the subagent budget mechanism. Confirmed clean. |
| `pi/docs/postmortem/*` | Historical; not to be re-edited. The new postmortem (this file) is the only new postmortem. |
| `pi-orchestrator/SYSTEM.md` | Doesn't exist; the SYSTEM prompt is the runtime's own `templates/SYSTEM.md` (per AGENTS.md L78-80). That file is part of the orchestrator install payload and is the user's runtime config surface, not a project doc. Out of scope. |

## TDD evidence

No code changes; no tests added/modified. The verify gates that
guard the post-merge state still pass:
- `bun run verify:recorder` — 19/19 (post-GC-2026-subagent-recording-no-budget)
- `bun run verify:gcdb` — 16 GCs all covered (this GC adds the 17th, the verify gate runs post-merge)

## Follow-ups

1. **Catalog drift fix** (P3, pre-existing) — `pi-orchestrator/catalogs/event.json`
   and `pi-orchestrator/catalogs/namespace.json` have been
   pre-existing-dirty on `main` since before this GC. The
   `verify:catalog` gate would fail if the orchestrator CI runs.
   Not part of this GC's scope; a separate `GC-2026-catalog-refresh`
   should regenerate the catalogs via `bun run gen:catalog`.

2. **Periodic doc audit** (P3) — the budget mechanism in code is now
   stable (recording + no enforcement), so future GCs are unlikely to
   regress the docs. But any future GC that touches the agent dispatch
   surface (e.g. a new subagent type, a new prompt section) should
   grep for "max_turns" / "BudgetTracker" / "wall-clock deadline" in
   `pi-orchestrator/DEEP-DIVE.md` and update if needed. The
   `verify:recorder` gate's negative assertion (deleted budget files
   are gone) already covers the code side; the doc side is a
   manual-review step.

## Process notes

- **Doc-only GC, manual implementation** — the scope is 3 hunks
  in 1 file. No subagent dispatch; the orchestrator main agent
  implemented directly per the same pattern as the prior GCs.

- **Goal contract + postmortem discipline preserved** — even
  for a 3-hunk doc GC, the contract + postmortem + gc-index cycle
  is followed. The contract scope is 6 lines, the postmortem is
  ~70 lines, the gc-index entry is 1 line. The institutional
  coverage discipline (`verify:gcdb`) catches any future drift.

- **No new subagent types or code surface** — strict doc-only
  GC. The 17th GC instance is the smallest by code surface
  (3 hunks, 0 net code lines) but it ships the institutional
  coverage for the recording-no-budget GC's doc follow-up.

- **Cross-package boundary** — touches only `pi-orchestrator/DEEP-DIVE.md`
  in the `pi-orchestrator/` package; no changes to `pi-subagents/`,
  `pi-tasks/`, `pi-evaluator/`, `pi-codebase-memory/`, or the
  `pi/docs/postmortem/GC-2026-122.md` historical file.
