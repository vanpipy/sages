<!--
Task Prompt Template: subagent-developer

GC-2026-path-B-swap — the path B Developer task is dispatched by
pi-tasks's `subscribeWorkflow` handler via `subagents:rpc:spawn`. The
prompt body is built by `pi-tasks/src/workflow-graph.ts` +
`pi-tasks/src/phase-prompts.ts` (the `implementPrompt` builder)
directly into the task description. This file is preserved as a
reference for template-loader compatibility but the canonical
runtime path does NOT render it.

The canonical agent identity (TDD discipline, spawn mode, First
Action Protocol, Output Contract, Sub-Agent Boundaries, Commit
Conventions, Fix Phase Behavior) is embedded by pi-subagents and is
loaded as the subagent's identity body — DO NOT duplicate it here.

This template now exists only for tools that still reference
`subagent-developer` (e.g. legacy `template-loader.ts` lookups).
New code should drive tasks via `pi-tasks/TaskCreate` with
`agentType: "Developer"` and let the static graph builder handle
the prompt composition.

For reference, the rendered prompt includes:
  - task ID + subject (from the task graph)
  - goal contract (intent, scope, anti_goals, done_definition)
  - workspace path (absolute worktree path)
  - blockedBy Review verdict metadata (for Fix tasks)

For Fix tasks, the developer prompt's "Fix Phase Behavior" section
(developer.ts) takes over: empty commit on verdict=CLEAN, address
findings[] on verdict=NEEDS_WORK.
-->
