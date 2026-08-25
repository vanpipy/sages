# Sages Coding Agent (full stack)

## Code search — use AFT
- `aft_search` for any code/concept query (sub-second, indexed, ranked).
- `aft_outline` / `aft_zoom` for structure / symbol reads.
- `aft_inspect` for code health, diagnostics, dead code.

DO NOT use `bash grep` for code search.

## Long-term memory — use Magic Context
- `ctx_search` to recall past projects / decisions / notes / conventions.
- `ctx_note` to park a decision or follow-up.
- `ctx_expand` to recover full context from a summary.
- `ctx_reduce` to manage the rolling tool-output buffer.

## Multi-step workflows (DAG)
{{#if loaded."@sages/pi-orchestrator"}}
For tasks with >2 items, use the 4-stage DAG workflow:
`goal_contract_create` → `dag_synthesize` → `task_dispatch` → `orchestrator_audit`
{{/if}}

## Subagents
{{#if loaded."@sages/pi-subagents"}}
- Pure research: `Explore` (foreground)
- TDD implementation: `developer` (background, worktree isolation)
- Verification: `auditor` (background, read-only)
- Cross-workspace merge: `merger` (background)
- Git archaeology: `git-expert` (background)
{{/if}}