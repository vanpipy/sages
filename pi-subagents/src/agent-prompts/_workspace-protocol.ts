/**
 * _workspace-protocol.ts — Canonical §Workspace semantics + §Handoff protocol
 * + §Cross-workspace merging triple-section, shared verbatim by the
 * `developer` and `merger` runtime prompts (GC-2026-076 P1).
 *
 * Before GC-2026-076 the canonical text lived inline in `developer.ts`
 * and `merger.ts`. The two prompts had to stay byte-identical — the
 * developer reasons about cross-workspace overlap the merger resolved, and
 * the merger reads workspace state the developer wrote. The cross-file
 * consistency was protected by a comment ("the two prompts MUST NOT drift")
 * plus a test that compared byte slices.
 *
 * After GC-2026-076 the canonical text lives in a single
 * `WORKSPACE_PROTOCOL_SECTION` constant. Both `developer.ts` and
 * `merger.ts` interpolate it via template literal. The byte slice anchored
 * by `## Workspace semantics\n` (open) and `the **cross-workspace** merge
 * result.` (close) is guaranteed identical across both prompts by
 * construction. A drift test (`workspace-protocol-drift.test.ts`) re-pins
 * this invariant after the extraction.
 *
 * The preambles (developer.ts's "🌳 Workspace Context" two-modes enumeration,
 * merger.ts's "🌐 Workspace isolation modes" preamble) stay in their
 * respective prompt files — only the three canonical sections move here.
 */

export const WORKSPACE_PROTOCOL_SECTION = `## Workspace semantics
A worktree is a **workspace**, not just an isolation boundary. One workspace
hosts a sequence of related developer tasks that build on each other's commits.

- Workspace identity = batch id (one workspace per DAG batch by default).
- Tasks sharing a workspace_id run **sequentially** on the same branch
  \`sages/<dag>/<workspace_id>\` — they never run in parallel within one workspace.
- Within a workspace, predecessor commits + HANDOFF.md carry forward to
  successor tasks.

## Handoff protocol (HANDOFF.md)

A workspace is preserved across developer sessions via HANDOFF.md. The
dispatch brief carries a \`handoff_template\` field selecting one of three
shapes — pick the matching template, do not invent a new one. The mechanism
(path, writer, reader, lifecycle) is unchanged; only the on-disk section
shape is parameterized.

### Path (all templates)

- Write: \`.pi/orchestrator/handoff/<workspace_id>/<task_id>-handoff.md\`
- Read on entry: every \`<task_id>-handoff.md\` under
  \`.pi/orchestrator/handoff/<workspace_id>/\` ordered by task_id.
  Skipping this is an automatic audit failure.

### Template A — Standard (default)

Use when dispatch brief has no \`handoff_template\` (or \`"standard"\`). The
canonical five-part body for any task on the workspace.

- **Summary** — one paragraph: what this task accomplished and where it landed.
- **Files in modified state** — paths + one-line note per file.
- **TODOs for successor** — concrete actions the next developer should take.
- **Test status** — passing / failing / pending, with the exact verification command.
- **Open questions** — anything the orchestrator or successor should know.

### Template B — Phase Gate (cross-workspace)

Use when dispatch brief says \`handoff_template: "phase-gate"\` — your changes
will be merged with another workspace via the \`merger\` sub-agent.

- **Gate criteria results** — table: criterion | threshold | result | evidence.
- **Documents carried forward** — files + handoff docs the merger must read.
- **Key constraints** — what the merging workspace must respect.
- **Risks carried forward** — table: risk | severity (🔴/🟡/💭) | mitigation.

### Template C — Escalation (blocked / 2+ failures)

Use when dispatch brief says \`handoff_template: "escalation"\` — you have
failed twice on this task and the next dispatch will be a fresh agent.

- **Failure history** — per attempt: issues found, fixes applied, why it still failed.
- **Root cause analysis** — why the task keeps failing (one-off vs pattern, scope).
- **Recommended resolution** — checkbox list: reassign / decompose / revise
  approach / accept with limits / defer.
- **Impact** — what is blocked by this, timeline effect, quality compromise if accepted.

## Cross-workspace merging
When two workspaces edit the same files (detected at DAG synthesis), the
orchestrator dispatches the dedicated \`merger\` sub-agent:

- reads both diffs (\`git diff base..ws-A\` and \`git diff base..ws-B\`),
- classifies overlap as **clean / disjoint-hunk / hunk-conflict**,
- produces a merge commit when feasible; escalates hunk-conflicts back to the
  orchestrator (NOT auto-resolved — hunk-conflict on the same lines cannot be
  safely machine-resolved),
- verifies the merged result with typecheck + lint + the merged test suite
  (not per-workspace tests).

The \`auditor\` continues to verify **per-task** commits; the \`merger\` verifies
the **cross-workspace** merge result.`;
