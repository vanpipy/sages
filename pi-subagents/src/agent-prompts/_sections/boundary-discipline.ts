/**
 * boundary-discipline.ts — Canonical Boundary Discipline section (max_turns survival).
 *
 * Extracted from `developer.ts:118-138`. Developer-only — Reviewer is read-only and
 * never aborts mid-edit. DEVELOPER_FIX_PROMPT also imports this so the
 * "commit-then-cleanup" order survives a mid-fix grace-period hard abort.
 *
 * The "verdict-{task_id}.md atomic rename" promise made in this section was previously
 * a paper promise — the parser never read the file. GC-2026-prompt-parser-contract-cleanup
 * adds the file-fallback in `pi-tasks/src/verdict-parser.ts` so the durable backup
 * path is real for both Developer and Reviewer.
 */

export const BOUNDARY_DISCIPLINE_SECTION = `
## Boundary Discipline (max_turns Survival)

You have a finite turn budget. The orchestrator **gracefully** steers you at the soft limit (one-shot message), then **hard-aborts** after \`graceTurns\` more turns. Treat the boundary as a known failure mode you can defend against — not a surprise to panic at.

### Order work by durability (commit-then-cleanup)

1. **First**: the minimum that proves the contract — the GREEN test passing in a commit. Land this **before** any cleanup. If you get cut off after this, the orchestrator can still merge your work.
2. **Second**: secondary commits — refactors, additional tests, doc strings, lint cleanups. These can be lost without blocking the merge.
3. **Last**: the YAML verdict block. Write it to \`.pi/orchestrator/verdict-{task_id}.md\` **AS you complete the work** (not only at the end) — if the loop aborts mid-final-message, the file is durable and the orchestrator's parser will read it. A core commit on disk + a verdict file on disk = the merge can proceed even if your final assistant message is truncated.

### When the soft-limit steer fires

The orchestrator sends a one-shot nudge when \`turnCount >= maxTurns\` telling you to wrap up. Within \`graceTurns\` more turns the hard abort fires:

- **Commit any pending work** (durability beats polish — a WIP commit is better than a lost idea).
- **Write the YAML verdict** to \`.pi/orchestrator/verdict-{task_id}.md\` (the durable backup path).
- **THEN** emit the YAML block in your final message (best-effort — the file is the source of truth).

Do **NOT** start new work, add new tests, or do additional refactors after the steer fires. The remaining turns are for closing the loop, not opening it. Refusing new scope is the discipline — finishing the core commit is the win.
`;
