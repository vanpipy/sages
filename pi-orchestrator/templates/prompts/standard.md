# Active tooling — standard

The Sages conductor loaded the following extensions for this session.
Each contributes tools to your active toolset. This file is the
dynamic-context companion to `SYSTEM.md` (the static constitution);
it only lists which extensions are loaded and what each contributes
— workflow rules (DAG mechanics, subagent dispatch, TDD, commit
conventions, namespace ownership) live in SYSTEM.md, not here.

## Loaded extensions

{{#if loaded."@sages/pi-orchestrator"}}
- **`@sages/pi-orchestrator`** — workflow governance
  - `goal_contract_create` — turn intent into a verifiable contract (writes `.pi/orchestrator/goal-{id}.yaml`)
  - `workflow_run` — one-shot 5-phase pipeline (Implement → Review ⇆ Fix → Merge); emits `workflow:start`, waits for `workflow:phase-complete`, returns `WorkflowRunOutput`
  - `subagent_status` — inspect running/queued/recently-finished subagents
  - `subagent_steer` — push a message into a running or queued subagent session
  - `subagent_abort` — hard-stop a subagent (idempotent on terminal agents)
  - `subagent_resume` — re-enter a TERMINAL subagent session with a new prompt
{{/if}}

{{#if loaded."@sages/pi-subagents"}}
- **`@sages/pi-subagents`** — subagent lifecycle (managed worktrees)
  - `Agent` — dispatch subagents
  - `get_subagent_result` — fetch results
  - `steer_subagent` — redirect mid-run
{{/if}}

{{#if loaded."@sages/pi-evaluator"}}
- **`@sages/pi-evaluator`** — eval scoring (off by default; opt in via `sages.rewardMode`)
{{/if}}

## Reaching for the right tool

- Code search across the repo → use `aft_search` (or `grep` tool);
  avoid `bash grep`.
- Symbol lookup / cross-file → `codebase_search` / `codebase_refs`.
- Cross-package blast radius → `codebase_memory_trace_path`.
- Find past decisions / parked notes → `ctx_search`.

See SYSTEM.md for hard rules (meta-file classification, foreground
vs background, TDD, commit conventions, namespace ownership).