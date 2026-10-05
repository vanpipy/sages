/**
 * final-verdict-reviewer.ts — Canonical Reviewer Final Verdict section.
 *
 * Extracted from `reviewer.ts:151-180`. Distinct from `final-verdict-developer.ts`
 * because the schemas are different:
 *   - Reviewer emits **verdict** (CLEAN | NEEDS_WORK), not status.
 *   - Findings have `severity`, `issue`, `location?`, `recommendation?`.
 *   - Plus dimension checks: `scope_check`, `anti_goal_check`.
 *
 * Parser: `pi-tasks/src/verdict-parser.ts:parseReviewerVerdict` reads the LAST
 * \`\`\`yaml fence and decodes the flat structure. After GC-2026-prompt-parser-contract-cleanup
 * the parser ALSO enforces:
 *   - `scope_check: pass` + `anti_goal_check: pass` (or a skip-reason in evidence).
 *   - `verdict: CLEAN + findings: non-empty` is malformed → NEEDS_WORK.
 *   - File fallback: when no yaml fence in message, read
 *     \`.pi/orchestrator/verdict-{task_id}.md\`.
 *
 * Reviewer-only. Pinned by `sections-drift.test.ts`.
 */

export const FINAL_VERDICT_REVIEWER_SECTION = `
## Final Verdict (Pinned Output Shape)

Your final message MUST contain a single YAML fenced block at the end.
workflow_run parses it mechanically to decide the next pipeline phase.
A missing or malformed block fails the pipeline (no clear verdict = NEEDS_WORK).

\`\`\`yaml
verdict: CLEAN | NEEDS_WORK
findings:
  - severity: minor | major | critical
    issue: "<what's wrong, 1 sentence>"
    location: "<file:line or section>"
    recommendation: "<how to fix, 1 sentence>"
evidence:
  typecheck: "<output line>"
  tests: "<output summary>"
  lint: "<output summary>"
  files_read: ["path1", "path2", ...]
  commands_run: ["cmd1", "cmd2", ...]
scope_check: pass | fail | absent
  scope_check_skipped: "<reason>"  # required when scope_check: absent
anti_goal_check: pass | fail | absent
  anti_goal_check_skipped: "<reason>"  # required when anti_goal_check: absent
\`\`\`

**Default to NEEDS_WORK.** Only emit CLEAN when every dimension below is satisfied AND the evidence trail is complete. A vague or evidence-thin verdict fails the pipeline.

Status meanings:
- **CLEAN**: implementation is ready for Merge. workflow_run proceeds.
- **NEEDS_WORK**: at least one finding OR a dimension failed. workflow_run spawns Fix with the findings.

### Dimension checks

The parser enforces \`scope_check\` and \`anti_goal_check\` after GC-2026-prompt-parser-contract-cleanup:
- \`pass\` → counts as satisfied.
- \`fail\` → triggers NEEDS_WORK regardless of findings list.
- \`absent\` → only counts as satisfied when paired with a non-empty \`<dim>_skipped\` reason in evidence. No skip-reason → NEEDS_WORK.

### Durable backup (atomic rename)

Before emitting your final message, write this exact YAML block to
\`\${worktreePath}/.pi/orchestrator/verdict-{task_id}.md\` via atomic rename
(\`tmpfile -> rename\`) so a max_turns hard abort does not lose your verdict.
The parser falls back to this file when the message fence is missing.
`;
