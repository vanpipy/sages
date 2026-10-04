/**
 * previous-failure.ts — Canonical Previous Failure section (retry context).
 *
 * Extracted from `developer.ts:770-801` where it was `void`-suppressed after
 * declaration. GC-2026-prompt-parser-contract-cleanup:
 *   1. Adds it back to DEVELOPER_PROMPT so retries get the catalog's remediation.
 *   2. Splits the section body into **two branches by `mode.kind`**:
 *      - `spec` (verification-failed, commit-message-non-conformant): retry with
 *        the catalog's prescribed remediation.
 *      - `error` (subagent-timeout, worktree-concurrency-cap-reached,
 *        infra-unhandled, worktree-ownership-mismatch): **do NOT retry** —
 *        the catalog says `retryBudget: 0` and the handler is `escalate-to-l3`
 *        or `mark-stalled`. Escalate via `<ASK>` or write a BLOCKED report.
 *
 * Developer-only — Reviewer is read-only and never retried. Pinned by
 * `sections-drift.test.ts`.
 *
 * Placeholders: the orchestrator fills `{mode_id}`, `{mode_name}`, `{mode_kind}`,
 * `{mode_description}`, `{handler_note}`, `{retry_budget_left}`, `{stderr_digest}`
 * before concatenating the section into the dispatched prompt. Missing placeholders
 * remain literal `{...}` — the agent-runner interpolator lives at
 * `pi-subagents/src/agent-runner.ts` (see `interpolateRetryContext`).
 */

export const PREVIOUS_FAILURE_SECTION = `
## Previous failure

This dispatch is a RETRY. The previous attempt at this task failed and the
host recorded a diagnostic. Its classification, from the failure-mode
catalog (\`pi-subagents/src/data/failure-modes.v1.yaml\`):

- **mode**: \`{mode_id}\` — {mode_name}
- **class**: {mode_kind} (\`spec\` = a contract you missed; \`error\` = infrastructure)
- **what it means**: {mode_description}
- **remediation the catalog prescribes**: {handler_note}
- **retry budget left**: {retry_budget_left}

### Evidence from the failed attempt

\`\`\`
{stderr_digest}
\`\`\`

### How to use this — branch on \`mode_kind\`

The catalog distinguishes two failure classes. The right action differs:

#### If \`mode_kind === "spec"\` (a contract you missed — retryable)

1. **Do not re-run the whole task from scratch.** Read the evidence first and
   form a hypothesis about the specific cause.
2. **Honor the prescribed remediation.** The catalog's \`handler\` is the
   host's decision, not a suggestion — the retry budget decrements whatever
   you decide, so a repeat of the same failure burns the task.
3. **Address the exact spec violation** — the failed test / failed lint /
   non-conformant commit subject — before any other work. Spec retries are
   cheap; full reimplementations are not.

#### If \`mode_kind === "error"\` (infrastructure — NOT retryable)

1. **Do NOT retry the same approach.** The catalog has \`retryBudget: 0\` for
   \`error\` modes by definition; the handler is \`escalate-to-l3\` or
   \`mark-stalled\`.
2. **State the blocker explicitly** via \`<ASK>\` in your final message
   (or write \`status: blocked\` in the YAML verdict with \`open_questions\`).
3. **Preserve any partial work** on disk — commits, the verdict file, the
   HANDOFF — so the next dispatch (or a human) can resume from durable
   artifacts. Do not destroy context in a doomed retry attempt.

### If the evidence contradicts the classification

Say so explicitly in your final report. A mis-classified failure is a
catalog bug worth fixing and the orchestrator can only see it if you
name it.
`;
