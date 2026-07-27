<!--
Task Prompt Template: subagent-merger

Renders into the merger subagent's task prompt at dispatch time. The
canonical merger identity, including the Cross-workspace merging protocol,
is embedded by pi-subagents and is loaded as the subagent's identity body —
DO NOT duplicate that protocol here.

This template carries ONLY the merge-specific data the subagent cannot derive
from its identity + the worktree state:
  - task ID + title (which merge task of the DAG this is)
  - both workspace branch refs and their common base
  - success criteria (which SCs the merge must preserve)
  - optional escalation destination
  - both workspace paths (where the merge operation is run)

Parameters (filled by dag_synthesizer at render time):
  - task_id          : string — required merge task id (e.g. "M1")
  - task_title      : string — short title for the merge task
  - branch_a        : string — absolute ref `sages/<dag>/<workspace-A>`
  - branch_b        : string — absolute ref `sages/<dag>/<workspace-B>`
  - base_ref        : string — common base ref for both workspaces
  - sc_list         : string — formatted SC list the merge must preserve
  - escalation_path : string — optional destination for hunk-conflict escalation
  - worktree_path_a : string — absolute path to workspace A's worktree
  - worktree_path_b : string — absolute path to workspace B's worktree
-->

## Task

**ID**: {{task_id}}
**Title**: {{task_title}}

> **Note**: you may be running in background — the orchestrator gets your agent id immediately and may `steer_subagent` to redirect you mid-run. No synchronous user interaction.

You are the merger sub-agent. Read both diffs, classify, produce merge commit (when feasible) or escalate hunk-conflicts.

## Workspace Refs

- **Workspace A branch**: `{{branch_a}}`
- **Workspace B branch**: `{{branch_b}}`
- **Common base**: `{{base_ref}}`
- **Workspace A worktree**: `{{worktree_path_a}}`
- **Workspace B worktree**: `{{worktree_path_b}}`
- **Escalation path**: `{{escalation_path}}`

Use the canonical **Cross-workspace merging** sub-section for the required
classification and merge/escalation protocol. Do not silently resolve a
hunk-conflict on the same lines.

## Success Criteria (all must pass)

{{sc_list}}

## Verification on Merge Result

After producing a merge commit, run typecheck, lint, and the merged test suite
on the merged worktree. Report the exact commands and their outputs. Verify the
merged result, rather than only re-running each workspace's pre-merge tests.

## Reporting

Write the merge audit to
`.pi/orchestrator/audit-merge-{{task_id}}.md`. Include the two refs and base,
the overlap classification, the merge commit when one was produced, all
verification commands and results, and any escalation details. If a
hunk-conflict cannot be safely resolved, escalate it using
`{{escalation_path}}` instead of claiming the merge passed.
