/**
 * commit-discipline.ts — Canonical Commit Discipline section (GC-2026-prompt-parser-contract-cleanup).
 *
 * Extracted from `developer.ts:33-72` (was inline + `void`-suppressed? no, this one WAS in DEVELOPER_PROMPT,
 * but we move it to a shared library so DEVELOPER_FIX_PROMPT can also reuse it without drift).
 *
 * Developer-only — Reviewer is read-only and never commits. The byte slice between the
 * `## Commit Discipline` header and the trailing fence is pinned by
 * `pi-subagents/test/sections-drift.test.ts` (mirrors `workspace-protocol-drift.test.ts`).
 *
 * Why a single source: GC-2026-076 established the `_sections/` pattern for `WORKSPACE_PROTOCOL_SECTION`
 * because two prompts had to stay byte-identical. Same rationale applies here — DEVELOPER_PROMPT and
 * DEVELOPER_FIX_PROMPT both need commit discipline, and any drift between them is a footgun.
 */

export const COMMIT_DISCIPLINE_SECTION = `
## Commit Discipline (commit-as-checkpoint)

Your work is on a git branch. The orchestrator reads git history to
verify your progress. **Every RED test and every GREEN test MUST end with
a git commit.** A commit is your durable progress signal — without it,
the orchestrator cannot distinguish “work done” from “work in progress”.

### When to commit

1. **After writing a failing test (RED phase):**
   git add -A && git commit -m "wip: <test name> red"
   Example: \`git commit -m "wip: T-DEADLINE-01: a 1/60 minute deadline aborts within 2s red"\`

2. **After implementing the minimum to pass (GREEN phase):**
   git add -A && git commit -m "feat: <test name> green"
   Example: \`git commit -m "feat: T-DEADLINE-01: a 1/60 minute deadline aborts within 2s green"\`

3. **After every refactor step:** \`git commit -m "refactor: <description>"\`

### Anti-patterns

- **Do NOT write multiple tests before committing the first one.** If
  you write 7 tests and run out of turns before committing any, the
  The orchestrator sees 0 commits and abandons your work.
- **Do NOT explore further without committing what you have.** If 5
  turns have passed without a commit, stop exploring. Commit what
  you have (even if RED) and emit \`BLOCKED\` in your final message.
- **Do NOT skip the commit step for "trivial" changes.** WIP counts.
  A running history of WIP commits is far more useful than a single
  mega-commit at the end.

### Escape hatch

If you realize mid-task that you have been exploring for too long
without a commit, **commit what you have immediately and declare
BLOCKED**. Do not try to “finish the exploration first”. The orchestrator will
re-dispatch a follow-up task with your partial work as the starting
point.
`;
