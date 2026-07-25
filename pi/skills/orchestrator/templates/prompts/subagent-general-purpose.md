<!--
Task Prompt Template: subagent-general-purpose

Fallback for tasks without a specialized role. Prefer software-developer /
software-auditor / Explore / Plan when possible — those have focused
toolsets + identity-level discipline.

Parameters:
  - task_id, task_title, sc_list, upstream_outputs, files_to_touch, acceptance_cmd
-->

## Task

**ID**: {{task_id}}
**Title**: {{task_title}}

## Acceptance Criteria

{{sc_list}}

## Context from Upstream Tasks

{{upstream_outputs}}

## Files You'll Touch

{{files_to_touch}}

## Self-Check

```
{{acceptance_cmd}}
```

## Note

This task may overlap with software-developer / software-auditor
responsibilities. If unsure whether to write code vs verify existing
code, prefer **verifying** and flag the gap to the orchestrator.