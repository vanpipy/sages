/**
 * final-verdict-developer.ts — Canonical Developer Final Verdict section.
 *
 * Extracted from `developer.ts:182-235`. The DEVELOPER_FIX_PROMPT also imports
 * this so Fix tasks emit the same status / deliverables / commits YAML block
 * shape (parser expects identical schema across all Developer dispatches).
 *
 * Schema contract (pinned by `sections-drift.test.ts`):
 *   - status: completed | blocked | partial
 *   - deliverables: { files_changed[], commits[], tests_added[] }
 *   - test_results: { pass, fail, fail_details?[] }
 *   - open_questions?[]: { question, why_blocking?, suggestion? }
 *   - handoff_for_next_task?[]: { read_first, context }
 *
 * Parser: `extractStructuredOutput` in `pi-subagents/src/agent-runner.ts`.
 * The audit gate fails "missing_yaml_block" when this section is absent.
 */

export const FINAL_VERDICT_DEVELOPER_SECTION = `
## Final Verdict (Pinned Output Shape - GC-2026-037 T2)

Your final message MUST contain a single YAML fenced block at the end.
This is your "verdict" - the orchestrator parses it mechanically; a
missing or malformed block fails the audit gate.

The block MUST include these fields:

\`\`\`yaml
status: completed | blocked | partial
deliverables:
  files_changed: ["path/relative-to-repo", ...]
  commits: ["sha1", "sha2", ...]
  tests_added: ["path::test_name", ...]
test_results:
  pass: <number>
  fail: <number>
  fail_details:  # optional
    - file: "test/foo.test.ts"
      test: "edge case"
      message: "expected 0 got 1"
open_questions:  # optional; empty list OK
  - question: "what API signature?"
    why_blocking: true
    suggestion: "ask the orchestrator"
handoff_for_next_task:  # optional; empty list OK
  - read_first: "src/foo.ts"
    context: "new public API for the next task"
\`\`\`

Status values:
- completed: all work done, tests green, ready to merge.
- blocked: cannot proceed; open_questions describes what is needed.
- partial: some work done but incomplete; tests may fail; describe in
  open_questions.

Field semantics:
- files_changed: paths relative to the worktree root.
- commits: SHAs of commits you made on the worktree branch.
- tests_added: each test in path::test_name form.
- fail_details: one entry per failing test (omit if fail: 0).
- open_questions: a question only if the orchestrator should answer it.
- handoff_for_next_task: list the file the next developer should read first.

Anti-patterns (will fail the audit gate):
- No YAML block at all.
- YAML block missing status, deliverables, or test_results.
- YAML block status is completed but tests are failing.

This block is what the orchestrator uses to verify you did the work. Be specific.
If you cannot fill a field, leave it out (the schema tolerates that) or
move the item to open_questions.
`;
