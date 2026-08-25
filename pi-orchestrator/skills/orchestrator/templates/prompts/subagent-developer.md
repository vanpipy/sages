<!--
Task Prompt Template: subagent-developer

Renders into the subagent's task prompt at dispatch time. The canonical
agent identity (TDD discipline, spawn mode, First Action Protocol, Output
Contract, Sub-Agent Boundaries, Commit Conventions) is embedded by
pi-subagents and is loaded as the subagent's identity body — DO NOT
duplicate it here.

Phase A alias context: the deprecated `subagent-software-developer` key may
still resolve for persisted DAG compatibility, but new authoring uses
`subagent-developer`.

This template carries ONLY the per-task data the subagent cannot derive
from its identity + the worktree state:
  - task ID + title (which task of the DAG this is)
  - success criteria (which SCs from the goal contract apply)
  - upstream outputs (context from dependent tasks)
  - workspace context (workspace identity + predecessor HANDOFF contents)
  - files to touch (the DAG's expected file list)
  - self-check command (the DAG's acceptance.self_check_cmd, optional)

Parameters (filled by dag_synthesizer at render time):
  - task_id          : string     — e.g. "P4"
  - task_title       : string     — short title from TaskNode.description
  - sc_list          : string     — formatted SC list with verification_cmd
  - upstream_outputs : string     — formatted upstream task outputs (or "(none)")
  - workspace_id      : string — defaults to batch_id; identifies the worker's worktree + branch
  - upstream_handoffs : string — concatenated HANDOFF bodies ordered by task_id (or "(none)")
  - files_to_touch   : string     — file paths from TaskNode.files
  - acceptance_cmd   : string     — optional self_check_cmd
-->

## Task

**ID**: {{task_id}}
**Title**: {{task_title}}

> **Note**: you may be running in background — the orchestrator gets your agent id immediately and may `steer_subagent` to redirect you mid-run. No synchronous user interaction.

## Workspace Context

**Workspace**: {{workspace_id}}

By default, `workspace_id = batch_id`. The TaskNode prompt
receives an `upstream_handoffs` parameter containing concatenated HANDOFF
contents ordered by `task_id`, or `(none)` if this is the first task in the
workspace.

### Upstream HANDOFF contents

{{upstream_handoffs}}

## Success Criteria (all must pass)

{{sc_list}}

## Context from Upstream Tasks

{{upstream_outputs}}

## Files You'll Touch

{{files_to_touch}}

## Workspace Output

Before exit, write the task report to
`.pi/orchestrator/task-{{task_id}}-report.md`, and write the handoff record to
`.pi/orchestrator/handoff/{{workspace_id}}/{{task_id}}-handoff.md`. These are
developer-owned paths; do not overwrite goal, DAG, audit, or rollup state.
Include the summary, modified files, successor TODOs, test status, and open
questions so the next developer session can continue without repeating work.

## Self-Check Before Reporting

Run this and confirm it passes before writing your task report:

```
{{acceptance_cmd}}
```