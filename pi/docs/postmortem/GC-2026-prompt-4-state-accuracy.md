# GC-2026-prompt-4-state-accuracy

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit + 1 merge)

## What happened

The prompt-consistency audit (a follow-up to the first audit) identified 10 P1/P2 findings about the gap between actual runtime behavior and the documentation/prompts that describe it. The biggest was that the agent prompts claimed a 2-state Reviewer verdict set (`CLEAN` / `NEEDS_WORK`) while the runtime had been 4-state since `GC-2026-verdict-states-and-dynamic-cascade`. The dispatch brief and `FINAL_VERDICT_REVIEWER_SECTION` had been updated when the parser went 4-state, but the agent prompts' top prose and several orchestrator docs were never updated. A second meta-audit (the "auditor audit") caught this and also caught **fake test coverage** — `sections-drift.test.ts:113` was using a substring check (`"verdict: CLEAN | NEEDS_WORK"`) that passed for both 2-state and 4-state prose, so the 4-state invariant was never actually pinned. The orchestrator's docs (SYSTEM.md, SKILL.md, agent-tool-description.md) carried stale field names (`dag_id` instead of `goal_id` post `GC-2026-path-B-field-renames`, `Auditor` instead of `Reviewer` post `GC-2026-rename-auditor`) and a 5-phase count (pre-`GC-2026-verdict-states-and-dynamic-cascade`).

## Root cause

The system went through 6+ GCs that touched the verdict schema, agent naming, and field renames. Each GC updated the code that immediately mattered to its scope (parser, dispatch brief, runtime handler) but didn't sweep the documentation/prompt surface. There was no test that asserted "this prompt and this doc are 4-state, not 2-state", so the drift accumulated silently across GCs.

The fake test coverage is the more pernicious part: a substring check that matches a prefix of a longer expected string is a no-op pin. The fix isn't just "use a regex" — it's that the test should pin the **full** 4-state enumeration, not a 2-state prefix that happens to also exist in the 4-state text.

## Fix

10 findings addressed across 3 layers:

**P1 (prompt accuracy)**:
- `pi-subagents/src/agent-prompts/reviewer.ts:44` — top prose "CLEAN or NEEDS_WORK" → "4-state set (CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION)". The agent now sees the full vocabulary before reading the FINAL_VERDICT_REVIEWER_SECTION.
- `pi-subagents/src/agent-prompts/_fix.ts:67-71` — Fix prompt type union widened to 4-state with defensive notes. Fix is dispatched only on CLEAN/NEEDS_WORK per `workflow-handler.ts:555-576`, but the prompt now handles NEEDS_REDESIGN / NEEDS_CLARIFICATION defensively (emit empty commit + report blocked) in case the cascade routing changes.
- `pi-subagents/src/agent-prompts/developer.ts` — added rule 10 to Critical Rules: "Read Reviewer verdicts in the full 4-state set". Developers reading blockedBy Review tasks must recognize all 4 transitions.
- `pi-subagents/src/agent-prompts/_sections/commit-conventions.ts` — added "Forbidden paths — never commit `.pi/`" section. The rule was only in SYSTEM.md (orchestrator view) before; now both Developer and Reviewer (who both import the section) see it.
- `pi-orchestrator/templates/agent-tool-description.md` — 4 stale references fixed: `Auditor` → `Reviewer` (line 66, post `GC-2026-rename-auditor`), `CLEAN | NEEDS_WORK` → 4-state (line 73), `dag_id` → `goal_id` (line 95, post `GC-2026-path-B-field-renames`), branch convention `sages/<dag>/<worktree>` (line 95) → `sages/<goal_id>/<worktree>` with workflow_run dispatch note.

**P1 (test coverage gaps)**:
- `pi-subagents/test/sections-drift.test.ts:113` — substring check `expect(...).toContain("verdict: CLEAN | NEEDS_WORK")` → regex `expect(...).toMatch(/verdict:\s*CLEAN\s*\|\s*NEEDS_WORK\s*\|\s*NEEDS_REDESIGN\s*\|\s*NEEDS_CLARIFICATION/)`. Now passes only when the full 4-state enumeration is present.
- `pi-subagents/test/developer-prompt.test.ts` — added test "documents the 4-state Reviewer verdict set" that asserts DEVELOPER_PROMPT mentions all 4 verdict strings (CLEAN, NEEDS_WORK, NEEDS_REDESIGN, NEEDS_CLARIFICATION).
- `pi-subagents/test/prompts-replace-mode.test.ts:429` — REVIEWER_PROMPT declaration test expanded from `/NEEDS_WORK/` to require all 3 non-CLEAN strings (`/NEEDS_REDESIGN/`, `/NEEDS_CLARIFICATION/`). The original regex was satisfied by any prose mentioning "NEEDS_WORK" (which the prompt had in the "Default to NEEDS_WORK" line); the new regex forces the full vocabulary.

**P2 (doc/cleanup)**:
- `pi-orchestrator/templates/SYSTEM.md:7-9` — "5-phase pipeline runner" → "Implement → Review ⇆ Fix → Merge" with a note that Fix is now dispatched dynamically.
- `pi-orchestrator/templates/SYSTEM.md:131` — Pipeline pattern `TaskCreate(Fix, agentType="Developer", ...)` → `agentType: "Fix"`. The canonical agent type for Fix is "Fix" (per `pi-subagents/src/default-agents.ts:256`).
- `pi-orchestrator/skills/orchestrator/SKILL.md:131-132` — added cascade branches for NEEDS_REDESIGN (new Implement, capped by `max_redesigns`) and NEEDS_CLARIFICATION (pause + open_question).
- `pi-subagents/src/agent-prompts/developer.ts` — removed `FIX_PHASE_BEHAVIOR_SECTION` (dead code: Fix uses `DEVELOPER_FIX_PROMPT` from `./_fix.ts`; the full DEVELOPER_PROMPT's Fix fallback was never invoked). Added a comment block explaining the cleanup.
- `pi-subagents/src/agent-prompts/developer.ts:176,371-377` + `merger.ts:122` — renamed `dag_id` → `goal_id` in isolation context (kept merger.ts:92's `dag_id` as the DAG-synthesis file naming). Added workflow_run dispatch note to developer.ts explaining the `<goal_id_lowercase>-implement` sentinel worktree_id convention.

### Tests

| File | Change | Status |
|---|---|---|
| `sections-drift.test.ts` | 1 test upgraded (substring → regex 4-state) | pass |
| `developer-prompt.test.ts` | 1 new test (4-state assertion) | pass |
| `prompts-replace-mode.test.ts` | 1 test expanded (full 4-state regex) | pass |

`bun run typecheck` green on both `pi-subagents` and `pi-orchestrator`. `bun test`:
- `pi-subagents`: 8 errors pre-existing (TaskStore list ID resolution + projectKey + sessionTaskFile, unchanged from main baseline)
- `pi-orchestrator`: 1 fail (verify:catalog subprocess) + 4 SMOKE-073 tests pre-existing (orchestrator smoke tests reading template content, unchanged from main baseline)

No regressions introduced. The pre-existing failures are in test surfaces I didn't touch.

## Verification

| # | Item | Status |
|---|---|---|
| 1 | Reviewer prompt 4-state top prose | ✓ reviewer.ts:44 |
| 2 | Fix prompt 4-state type union + defensive handlers | ✓ _fix.ts:67-78 |
| 3 | agent-tool-description.md 4 stale fixes | ✓ (Auditor→Reviewer, 2-state→4-state, dag_id→goal_id, branch convention) |
| 4 | Test coverage: sections-drift regex, developer-prompt new test, prompts-replace-mode full 4-state | ✓ 3 test files |
| 5 | commit-conventions.ts "Never .pi/" rule added | ✓ section added |
| 6 | SYSTEM.md "5-phase" → "4-phase" | ✓ |
| 7 | SYSTEM.md Fix agentType | ✓ |
| 8 | SKILL.md NEEDS_REDESIGN + NEEDS_CLARIFICATION cascade branches | ✓ |
| 9 | Developer FIX_PHASE_BEHAVIOR_SECTION removed | ✓ |
| 10 | Developer + Merger branch naming dual-mode note | ✓ |
| 11 | typecheck green, no regressions | ✓ |

## Effect on the user

- The prompts agents read now match the runtime 4-state schema they actually emit.
- The orchestrator's docs (`SYSTEM.md`, `SKILL.md`, `agent-tool-description.md`) no longer carry stale field names or stale "5-phase" / "Auditor" / "dag_id" references.
- Future drift of the same shape (sub-claim of a claim escaping the test surface) is now caught — the test coverage gap is closed, so anyone re-introducing 2-state prose will fail tests.

## Lessons learned

- **Substring matches in test assertions are fake pins.** A `toContain("CLEAN | NEEDS_WORK")` test passes for both 2-state and 4-state prose — the test looked like it was guarding the invariant but was actually just checking that the string "CLEAN | NEEDS_WORK" appears somewhere. Regex (with the full enum) is the minimum viable test for a multi-state schema.
- **Sectioned comments are not tests.** `commit-conventions.ts:39` had a comment "Adding a `Never .pi/` rule would be a useful follow-up" — that comment sat there for 3+ GCs. The follow-up is now done. The lesson: comment-as-TODO without an associated test or GC entry is technical debt.
- **Across-GC drift accumulates silently when each GC's scope is narrow.** The 6+ GCs that touched the verdict schema each updated the code in their scope. None of them ran `grep "CLEAN | NEEDS_WORK"` across `pi-subagents/src/agent-prompts/` to find stragglers. A future GC candidate: a "drift sweep" that greps for any cross-package invariant and asserts it's present in all relevant places.

Refs: GC-2026-prompt-4-state-accuracy
