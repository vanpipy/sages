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
  - `goal_contract_create` — turn intent into a verifiable contract
  - `dag_synthesize` — decompose into a task DAG
  - `task_dispatch` — spawn subagents per batch
  - `orchestrator_audit` — workflow-level audit rollup
  - `sages_reminder` — soft-mode reminder injector
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