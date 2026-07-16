# Finalize Stage Prompt

You are closing the workflow via `fuxi_end`.

## Task

Call `fuxi_end { observation: { verdict: "..." } }` based on the audit verdict from `audit.md`.

## Verdict Routing (handled by `fuxi_end`)

| Verdict | Action |
|---|---|
| **PASS** | Archives `.sages/workspace/` to `.sages/archive/{plan}/{timestamp}/`. Returns `status: "complete"`. |
| **NEEDS_CHANGES** | Routes to `implement` phase. LLM should run `luban_run_batch` to plan remediation, then iterate `luban_execute_task`. After 3× NEEDS_CHANGES, auto-escalates to `design`. |
| **REJECTED** | Routes to `design` phase. Design sub-state cleared. LLM restarts via `fuxi_design`. |

## Without Observation

If you call `fuxi_end {}` without observation, it validates `audit.md` exists and surfaces the current verdict so you know what to pass.

## Report to User

Tell the user:
- workflow name (`four-sages` / `bugfix`)
- planName
- archive path (on PASS)
- transition count (from `history` field of state.json)
- final verdict + score

## Completion

After `fuxi_end { observation: { verdict: "PASS" } }` returns `status: "complete"`, the workflow is done. The FSM advances to `complete` (terminal state).