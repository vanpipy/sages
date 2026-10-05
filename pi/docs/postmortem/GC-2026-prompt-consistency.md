# GC-2026-prompt-consistency

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit, post-merge)

## What happened

User asked about consistency of commit rules across orchestrator and
subagent contexts after noticing a recent subagent commit (`c6e5084 feat(fix-agent):
wire DEVELOPER_FIX_PROMPT to Fix cascade`). Audit found the rules WERE
semantically consistent in three places (DEVELOPER_PROMPT verbose,
SYSTEM.md one-line, AGENTS.md link), but each was a SEPARATE COPY with
no shared source. Any future change to the format / type table / forbidden-
author list had to be replicated in three+ places.

A separate gap: `failure-modes.v1.yaml:44` has a `commit-message-non-conformant`
retry mode, but no agent prompt references it — the retry feedback was
triggered by external regex matching without the agent knowing the full
rule set.

## Root cause

GC-2026-prompt-parser-contract-cleanup (commit b4e9891, July 2026)
extracted a handful of sections into `_sections/` (commit-discipline,
boundary-discipline, checkpoint-protocol, etc.) but skipped commit-conventions
because that prose predated the section-library pattern by a year and
was already considered "settled". The fix pattern would re-establish the
single-source guarantee.

## Fix

1 commit on `main`:

- `1684fc0 feat(prompts): centralize commit-conventions + cross-prompt consistency`
  11 files changed, 206 insertions, 101 deletions:

**pi-subagents/src/agent-prompts/_sections/commit-conventions.ts (NEW)**
- Single source of truth for the Conventional Commits format + 8-type
  table + Rules + 5 examples + Author derivation bash script +
  Never-author list + Why-it-matters rationale. Header documents
  which prompts import this and why.

**pi-subagents/src/agent-prompts/developer.ts**
- Import `COMMIT_CONVENTIONS_SECTION` and replace the inline 92-line
  block with `${COMMIT_CONVENTIONS_SECTION}`. Byte-identity preserved
  by sections-drift.test.ts.

**pi-subagents/src/agent-prompts/reviewer.ts**
- Import + append. Add a correctness spot-check bullet linking to the
  section so the Reviewer audits commit subjects during 5-dim review.

**pi-subagents/src/agent-prompts/_fix.ts**
- One-line cross-ref. Fix tasks rarely produce new subjects (the
  fix-phase branches section already shows `fix(<scope>): …`).

**pi-orchestrator/templates/SYSTEM.md**
- 4-line block-quote pointing to the canonical section. Keep the
  8-type quick reference + Refs footer reminder (orchestrator needs
  the reminder even though the canonical lives elsewhere).

**pi-orchestrator/src/data/failure-modes.v1.yaml**
- `commit-message-non-conformant.description` cross-references the
  canonical section. `feedbackTemplate` points to the section path.
  Retry feedback now has a stable pointer for the agent to consult.

**pi-subagents/src/subagent-control-tools.ts + agent-manager.ts**
- Add `parent_aborted` to `AgentStatusSchema` (TypeBox union) +
  `SubagentStatusParams` union so `subagent_status` / `subagent_list`
  honor the new state (carried over from the GC-2026-subagent-interruption-
  minimal commit on the same branch).

**Tests**
- `pi-subagents/test/sections-drift.test.ts`: byte-identity pin for
  `COMMIT_CONVENTIONS_SECTION` in `DEVELOPER_PROMPT` and `REVIEWER_PROMPT`
  (pre-emptively added by the Implement agent; the rest of the test
  suite already passes on this codebase).
- `pi-orchestrator/test/agents/commit-conventions.test.ts`: update to
  read the canonical section file (the prose moved out of `developer.ts`)
  + relax the heading regex (`^#+\s+` no longer matches because the
  heading now lives inside a template literal preceded by a backtick).

## Verification

- `bun run typecheck` from `pi-subagents/`: green.
- `bun run test` from `pi-subagents/`: 1006 pass, 8 skip, 0 fail.
- `bun run test` from `pi-orchestrator/`: 477 pass, 2 skip, 0 fail.
- `bun run test` from `pi-tasks/`: 475 pass, 0 fail.
- `verify:catalog`: regenerated, no hash diffs.

## Done-definition verification

| # | Item | Status |
|---|---|---|
| 1 | `_sections/commit-conventions.ts` exists with the canonical prose | ✓ 92 lines extracted verbatim |
| 2 | `developer.ts` imports + drops inline | ✓ byte-identity test |
| 3 | `_fix.ts` + `reviewer.ts` cross-ref or import | ✓ |
| 4 | SYSTEM.md block-quote pointing to section | ✓ |
| 5 | failure-mode description references section | ✓ |
| 6 | sections-drift byte-identity test | ✓ (added by Implement agent) |
| 7 | All tests + postmortem + gc-index | ✓ (this file + index update next) |

## Out of scope (deferred)

- **`.pi/` path rule**: still lives only in SYSTEM.md. Could be folded
  into `commit-conventions.ts` later. Not part of this GC because it
  would break byte-identity with the prior inline slice.
- **PlanCompiler / Explore / Merger commit instructions**: these agents
  don't produce commits. The cross-ref in `commit-conventions.ts`'s
  header notes "NOT a consumer".
- **Fix agent's `fix(<scope>): …` rule documentation**: already in the
  fix-phase branches section of `_fix.ts`, so no further cross-ref
  needed.

## Lessons learned

- **Section libraries catch drift.** The GC-2026-prompt-parser-contract-cleanup
  set the pattern (commit-discipline, boundary-discipline, etc.).
  Commit conventions predated that pattern by a year; this GC brings
  it into line. Audit all long-prompts for inline prose that could be
  extracted into sections — there's likely more candidates.
- **Failure-mode descriptions should reference canonical sections.**
  `commit-message-non-conformant` had a working retry path but the
  description was self-contained (didn't link to the prompt section
  where the same rules lived). Now they share one source — future
  changes to the section auto-update the retry feedback.

Refs: GC-2026-prompt-consistency
