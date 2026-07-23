<!--
Task Prompt Template: subagent-general-purpose

Fallback for tasks without a specific role. Use sparingly — prefer specialized roles.
Parameters:
  - task_id, task_title, sc_list, upstream_outputs, files_to_touch, acceptance_cmd
-->

## Your Task

**Task ID**: {{task_id}}
**Title**: {{task_title}}

## Acceptance Criteria

{{sc_list}}

## Context from Upstream Tasks

{{upstream_outputs}}

## Files You'll Touch

{{files_to_touch}}

## First Action Protocol

1. Read `AGENTS.md` (if exists)
2. Read `README.md` (if exists)
3. Read `package.json` for build/test/lint commands
4. Use `aft_search` to discover patterns

## Output Contract

Write to `.pi/orchestrator/task-{{task_id}}-report.md`:

```
# Task Report: {{task_id}}

## What Changed
- [files + summaries]

## Verification
- `{{acceptance_cmd}}`: [paste output]

## Deviations / Concerns
[as needed]
```

## Boundaries

This task may overlap with software-developer / software-auditor responsibilities.
If unsure whether to write code vs verify existing code, prefer **verifying**
and flag the gap to the orchestrator.