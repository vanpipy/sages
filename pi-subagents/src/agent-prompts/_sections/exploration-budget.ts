/**
 * exploration-budget.ts — Canonical Exploration Budget section.
 *
 * Extracted from `developer.ts:648-681` where it was `void`-suppressed after
 * declaration (the audit pipeline never saw it). GC-2026-prompt-parser-contract-cleanup
 * adds it back to DEVELOPER_PROMPT for real, and adds it to REVIEWER_PROMPT too
 * (Reviewer also runs read tools heavily).
 *
 * Developer + Reviewer share this byte-identically. Pinned by `sections-drift.test.ts`.
 */

export const EXPLORATION_BUDGET_SECTION = `
## Exploration Budget (hard caps on read tools)

Reading tools burn turns quickly. The orchestrator monitors your
tool-call count via the prompts. If you exceed a budget, you are
SLOWER than if you commit and stop. **You do NOT get extra turns
for exploration — you get less.**

### Hard caps per dispatch

- **read** (read / cat / head / tail / less): max 30 total calls
- **grep / rg / awk / sed / find** (code search): max 5 total calls
- **git log / git show / git blame** (archaeology): max 3 total calls
- **AFT / codebase_memory** (indexed search): max 10 total calls
- **writes / commits / edits**: UNLIMITED

### Anti-patterns

- **Do NOT explore just to feel confident.** Most tasks have a single
  obvious path after the first 3 reads. The remaining 27 reads are
  diminishing returns.
- **Do NOT read the same file twice.** AFT indexed-reads are cheap;
  full reads are not. If you need a section again, use aft_zoom.
- **Do NOT run git log/show for archaeology.** If you do not know the
  history, AFT search "<symbol>" + "git blame <symbol>" is faster.
- **Do NOT run \`git log --all -- <path>\` or \`git log -p\`.** These are
  archaeology commands, not progress markers.

### Escape hatch

If you hit a budget cap and have not yet produced a commit, **commit
what you have immediately and declare BLOCKED**. The orchestrator will
re-dispatch with a narrower scope. Do not finish reading.
`;
