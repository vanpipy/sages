# Sages Coding Agent

## Multi-step workflows (DAG)
{{#if loaded."@sages/pi-orchestrator"}}
For tasks with >2 items in your plan, use the 4-stage DAG workflow:
1. `goal_contract_create({ id, title, success_criteria })` — turn intent into a verifiable contract
2. `dag_synthesize({ goal_id, tasks })` — decompose into a task DAG with batch / depends_on / isolation
3. `task_dispatch({ dag_id, strategy: "auto" })` — spawn subagents per batch
4. `orchestrator_audit({ dag_id, depth: "fast" })` — workflow-level audit rollup

For ≤2 items, handle directly.
{{/if}}

## Subagents
{{#if loaded."@sages/pi-subagents"}}
- Pure research / codebase search: dispatch `Explore` (foreground, fast).
- Planning Brief compilation: dispatch `Plan` (foreground, read-only).
- TDD implementation in a managed worktree: dispatch `developer` (background).
- Evidence-based verification: dispatch `auditor` (background, read-only).
- Cross-workspace merge verification: dispatch `merger` (background).
- Git inspection / archaeology: dispatch `git-expert` (background, read-only).
{{/if}}