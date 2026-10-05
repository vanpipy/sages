/**
 * final-verdict-reviewer.ts — Canonical Reviewer Final Verdict section.
 *
 * Extracted from `reviewer.ts:151-180`. Distinct from `final-verdict-developer.ts`
 * because the schemas are different:
 *   - Reviewer emits **verdict** (4-state set after GC-2026-verdict-states-and-dynamic-cascade).
 *   - Findings have `severity`, `issue`, `location?`, `recommendation?`.
 *   - Plus dimension checks: `scope_check`, `anti_goal_check`.
 *
 * Parser: `pi-tasks/src/verdict-parser.ts:parseReviewerVerdict` reads the LAST
 * \`\`\`yaml fence and decodes the flat structure.
 *
 * After GC-2026-prompt-parser-contract-cleanup the parser enforces:
 *   - `scope_check: pass` + `anti_goal_check: pass` (or a skip-reason in evidence).
 *   - `verdict: CLEAN + findings: non-empty` is malformed → NEEDS_WORK.
 *   - File fallback: when no yaml fence in message, read
 *     \`.pi/orchestrator/verdict-{task_id}.md\`.
 *
 * After GC-2026-verdict-states-and-dynamic-cascade the verdict is a 4-state set:
 *   CLEAN | NEEDS_WORK | NEEDS_REDESIGN | NEEDS_CLARIFICATION. NEEDS_CLARIFICATION
 *   requires the `open_question` field.
 *
 * GC-2026-b6: finding schema gained an optional `category` field
 * (`regression | unresolved | new`). Parser preserves it verbatim; unknown
 * values are dropped. Reviewer prompt pins the three categories and
 * the "default to new" rule.
 *
 * Reviewer-only. Pinned by `sections-drift.test.ts`.
 */

export const FINAL_VERDICT_REVIEWER_SECTION = `
## Final Verdict (Pinned Output Shape — GC-2026-verdict-states-and-dynamic-cascade 4-state set)

Your final message MUST contain a single YAML fenced block at the end.
workflow_run parses it mechanically to decide the next pipeline phase.
A missing or malformed block fails the pipeline (no clear verdict = NEEDS_WORK).

\`\`\`yaml
verdict: CLEAN | NEEDS_WORK | NEEDS_REDESIGN | NEEDS_CLARIFICATION
findings:
  - severity: minor | major | critical
    issue: "<what's wrong, 1 sentence>"
    location: "<file:line or section>"
    recommendation: "<how to fix, 1 sentence>"
    category: regression | unresolved | new   # GC-2026-b6, optional; default new
open_question: "<question>"   # required when verdict: NEEDS_CLARIFICATION; ignored otherwise
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

### Finding category (GC-2026-b6)

When iteration > 1, the dispatch brief contains a "Prior review summary" section listing what the previous Reviewer reported. Tag each finding with \`category:\`:

- **regression** — the issue existed in a prior Review that was CLEAN (or the prior Fix commit broke something). The fix made things worse.
- **unresolved** — the issue was reported in the prior Review with NEEDS_WORK but is STILL present after the Fix (Fix didn't address it).
- **new** — the issue wasn't reported previously; first observation this round.

If you can't classify (e.g. first iteration, or no Prior review summary was injected), omit \`category:\` and the parser treats it as \`new\`. The orchestrator uses these tags to spot quality regressions across the fix-loop.

### Verdict states (4-state set)

The pipeline dispatches differently per verdict state:

- **CLEAN**: every dimension passes; findings list is empty. workflow_run proceeds to Merge.
- **NEEDS_WORK**: 1+ findings that a Fix can address with local code changes (missing test, lint, wrong signature, etc.). workflow_run spawns Fix → Review loop (capped by max_fix_iterations, default 3).
- **NEEDS_REDESIGN**: the implementation is fundamentally wrong in a way Fix can't patch (architecture mismatch, wrong abstraction, scope/goal interpretation error). workflow_run spawns a NEW Implement (capped by max_redesigns, default 1). **Findings list MUST be non-empty** with concrete reasons — vague "needs redesign" without specifics fails the parser downgrades.
- **NEEDS_CLARIFICATION**: the goal contract is ambiguous and you cannot proceed without user input. **open_question is REQUIRED** with a specific, answerable question. workflow_run pauses the workflow and surfaces the question to the orchestrator main agent.

### Dimension checks

The parser enforces \`scope_check\` and \`anti_goal_check\`:
- \`pass\` → counts as satisfied.
- \`fail\` → triggers NEEDS_WORK regardless of verdict state.
- \`absent\` → only counts as satisfied when paired with a non-empty \`<dim>_skipped\` reason in evidence. No skip-reason → NEEDS_WORK.

### Malformed combinations (downgraded to NEEDS_WORK)

- \`verdict: CLEAN\` + non-empty findings list
- \`verdict: NEEDS_REDESIGN\` + empty findings list (no concrete reason)
- \`verdict: NEEDS_CLARIFICATION\` without \`open_question\` field
- Unknown verdict values (case-insensitive match required)

### Durable backup (atomic rename)

Before emitting your final message, write this exact YAML block to
\`\${worktreePath}/.pi/orchestrator/verdict-{task_id}.md\` via atomic rename
(\`tmpfile -> rename\`) so a max_turns hard abort does not lose your verdict.
The parser falls back to this file when the message fence is missing.
`;
