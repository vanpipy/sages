<!--
Task Prompt Template: subagent-merger

GC-2026-path-B-swap — the path B Merger task is dispatched by
pi-tasks's `subscribeWorkflow` handler via `subagents:rpc:spawn`. The
prompt body is built by `pi-tasks/src/workflow-graph.ts` +
`pi-tasks/src/phase-prompts.ts` (the `mergePrompt` builder)
directly into the task description. This file is preserved as a
reference for template-loader compatibility but the canonical
runtime path does NOT render it.

The canonical agent identity (cross-workspace merge protocol,
HANDOFF.md discipline, hunk-conflict escalation) is embedded by
pi-subagents and is loaded as the subagent's identity body — DO NOT
duplicate it here.

This template now exists only for tools that still reference
`subagent-merger` (e.g. legacy `template-loader.ts` lookups).
New code should drive tasks via `pi-tasks/TaskCreate` with
`agentType: "Merger"` and let the static graph builder handle
the prompt composition.

For reference, the rendered prompt includes:
  - task ID + subject
  - goal contract (intention + done_definition)
  - source branch + worktree path
  - the standard merge instructions (`git merge --no-ff <branch> -m "merge(<goal-id>): <title>"`)
-->
