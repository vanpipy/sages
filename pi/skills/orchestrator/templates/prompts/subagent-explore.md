<!--
Task Prompt Template: subagent-explore

Renders into the subagent's task prompt at dispatch time. The agent
identity (read-only enforcement, structured findings output) lives in
pi-subagents's built-in Explore agent — DO NOT duplicate it here.

This template carries ONLY the per-task data:
  - task ID + title
  - what to discover (from the goal contract's SCs)
  - files of interest (narrow the agent's search)
  - output file path

Parameters:
  - task_id, task_title, sc_list, files_to_touch
-->

## Task (READ-ONLY)

**ID**: {{task_id}}
**Title**: {{task_title}}

## What to Discover

{{sc_list}}

## Files of Interest

{{files_to_touch}}

## Report File

Write structured findings to `.pi/orchestrator/task-{{task_id}}-findings.json`
and inline a summary in your response.