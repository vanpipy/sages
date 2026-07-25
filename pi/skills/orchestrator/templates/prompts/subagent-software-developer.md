<!--
Task Prompt Template: subagent-software-developer

Renders into the subagent's task prompt at dispatch time. The agent
identity (TDD discipline, spawn mode, First Action Protocol, Output
Contract, Sub-Agent Boundaries, Commit Conventions) lives in
templates/agents/software-developer.md and is loaded by pi-subagents
as the subagent's identity body — DO NOT duplicate it here.

This template carries ONLY the per-task data the subagent cannot derive
from its identity + the worktree state:
  - task ID + title (which task of the DAG this is)
  - success criteria (which SCs from the goal contract apply)
  - upstream outputs (context from dependent tasks)
  - files to touch (the DAG's expected file list)
  - self-check command (the DAG's acceptance.self_check_cmd, optional)

Parameters (filled by dag_synthesizer at render time):
  - task_id          : string     — e.g. "P4"
  - task_title       : string     — short title from TaskNode.description
  - sc_list          : string     — formatted SC list with verification_cmd
  - upstream_outputs : string     — formatted upstream task outputs (or "(none)")
  - files_to_touch   : string     — file paths from TaskNode.files
  - acceptance_cmd   : string     — optional self_check_cmd
-->

## Task

**ID**: {{task_id}}
**Title**: {{task_title}}

## Success Criteria (all must pass)

{{sc_list}}

## Context from Upstream Tasks

{{upstream_outputs}}

## Files You'll Touch

{{files_to_touch}}

## Self-Check Before Reporting

Run this and confirm it passes before writing your task report:

```
{{acceptance_cmd}}
```