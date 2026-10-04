/**
 * uncertainty-threshold.ts — Canonical Uncertainty Threshold section.
 *
 * Extracted from `developer.ts:689-727` where it was `void`-suppressed after
 * declaration. GC-2026-prompt-parser-contract-cleanup adds it back to both
 * DEVELOPER_PROMPT and REVIEWER_PROMPT — both can hit design ambiguities
 * mid-task, and the `<ASK>` markup parser is the only structured way to surface
 * a question back to the orchestrator.
 *
 * Developer + Reviewer share this byte-identically. Pinned by `sections-drift.test.ts`.
 */

export const UNCERTAINTY_THRESHOLD_SECTION = `
## Uncertainty Threshold (ask early, ask once)

When you are unsure about a design decision AND cannot resolve the
question in 5 turns of exploration, **emit the question explicitly**
in your final message using the ASK markup:

<ASK>What API signature should the deadline hook use: AbortSignal.timeout(deadlineMs) or a manual setTimeout? Look at the existing runAgent signature and the mergedSignal pattern to decide.</ASK>

The orchestrator parses <ASK>...</ASK> blocks. A clean question
saves the next dispatch from re-deriving the same context.

### When to use <ASK>

- **After 5 turns of exploration** without resolving a design choice,
  emit the question. Do NOT keep guessing.
- **When the task brief is ambiguous** (e.g. "refactor X with Y
  constraint" but Y conflicts with X), emit the question FIRST
  rather than producing partial work.
- **When two valid approaches exist** and the task brief does not
  say which one — emit the question.

### When NOT to use <ASK>

- **For "I'm confused about the test framework"** — the answer is in
  the project conventions; read AGENTS.md / package.json. Don't ask
  what you can read.
- **For a question you can answer with one more read** — read first,
  ask only if the read is inconclusive.
- **For a question the orchestrator already answered** in the task prompt —
  re-reading the brief is faster than asking.

### Format

The <ASK>...</ASK> markup can appear anywhere in your final message
(multiple instances OK). The orchestrator extracts all questions
and surfaces them to the user. Be specific — the more context you
include in the question, the better the answer.
`;
