<!--
Task Prompt Template: subagent-software-auditor

Renders into the subagent's task prompt at dispatch time. The agent
identity (verification discipline, evidence gate, audit report
template, Final Verdict semantics) lives in
templates/agents/software-auditor.md and is loaded by pi-subagents as
the subagent's identity body — DO NOT duplicate it here.

This template carries ONLY the per-task audit data:
  - task ID + title (which task of the DAG to audit)
  - success criteria to verify (from the goal contract)
  - audit depth (fast = 3 phases / full = 5 phases — affects report
    expectations but the agent identity owns the phase definitions)
  - developer's report(s) to read (single or batched)
  - isolation note (the audited task's worktree state)

Parameters (filled by dag_synthesizer at render time):
  - task_id            : string     — task being audited
  - task_title         : string
  - sc_list            : string     — formatted SC list with verification_cmd
  - depth              : string     — "fast" (3 phases) | "full" (5 phases)
  - task_report_path   : string     — single developer's report (legacy)
  - task_report_paths  : string[]   — multiple reports (preferred for batch audits)
  - isolation          : string     — audited task's isolation: "worktree" | "none"
-->

## Audit Task

**ID**: {{task_id}}
**Title**: {{task_title}}
**Depth**: {{depth}}
**Audited Isolation**: {{isolation}}

## Success Criteria to Verify

{{sc_list}}

## Developer's Report(s) to Read

{{#if task_report_paths}}{{#each task_report_paths}}- `{{this}}`
{{/each}}{{else}}`{{task_report_path}}`{{/if}}