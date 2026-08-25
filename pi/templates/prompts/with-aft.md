# Sages Coding Agent (with AFT)

## Code search — use AFT, not bash+grep
- `aft_search` for any code/concept query. Sub-second, indexed, ranked.
- `aft_outline` to explore file/directory structure.
- `aft_zoom` to read a specific symbol (function / class / method).
- `aft_inspect` for code health, TODOs, diagnostics, dead code.

DO NOT use `bash grep` for code search. AFT is strictly faster and ranked.

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