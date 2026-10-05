/**
 * checkpoint-protocol.ts — Canonical Checkpoint Protocol section.
 *
 * Extracted from `developer.ts:78-108`. Developer-only — Reviewer is short-burst
 * (≤80 turns typical), and DEVELOPER_FIX_PROMPT deliberately does NOT import this
 * because Fix tasks run 5-10 turns and a checkpoint at the half-way mark eats
 * one-third of the budget.
 *
 * Pinned by `pi-subagents/test/sections-drift.test.ts` — DEVELOPER_PROMPT must
 * contain this byte slice; REVIEWER_PROMPT and DEVELOPER_FIX_PROMPT must not.
 */

export const CHECKPOINT_PROTOCOL_SECTION = `
## Checkpoint Protocol (every 5 turns)

Every 5 turns, emit a one-line progress report in this exact format:

[checkpoint N/200 turns, Xm] <work summary>. <commit count> commits. blocker: <state>.

Examples:
- [checkpoint 5/200 turns, 1m32s] 1 test written (RED). 0 commits. blocker: none.
- [checkpoint 10/200 turns, 3m15s] 1 test passing (GREEN). 1 commit. blocker: none.
- [checkpoint 15/200 turns, 4m50s] Implementation complete. 3 commits. blocker: scope-question.

### When to BLOCKED

If 2 consecutive checkpoints show no new commits, **declare BLOCKED**
in your final message. The orchestrator reads these checkpoints and
will detect the no-progress pattern and re-dispatch.

The rule: 2 consecutive checkpoints with the same commit count = BLOCKED.

### Why this matters

The orchestrator runs a checkpoint parser on your last message.
Without checkpoints, the orchestrator cannot tell "I am working" from "I am stuck".
With checkpoints, the orchestrator can:
- Detect when you have not yet committed (commit count = 0)
- Detect when you are stuck (no commits in 2 consecutive checkpoints)
- Surface blockers to the user

Skipping checkpoints is equivalent to having no progress signal.
`;
