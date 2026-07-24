# Sages

Multi-agent workflow system for [pi](https://pi.dev). A 4-tool
orchestrator drives a Goal → DAG → Dispatch → Audit pipeline; TDD
implementation and per-task auditing are delegated to
`software-developer` and `software-auditor` subagents spawned via
the Agent tool from `@tintinweb/pi-subagents`. See [History](#history)
for the project's Four-Sages mythology.

## Architecture

```
goal_contract_create  →  .pi/orchestrator/goal-{id}.yaml
        ↓
dag_synthesize        →  .pi/orchestrator/dag-{id}.yaml
        ↓
task_dispatch         →  Agent-call plan (LLM spawns)
        ↓
software-developer    →  .pi/orchestrator/task-{id}-report.md
software-auditor      →  .pi/orchestrator/audit-{task_id}.md
        ↓
orchestrator_audit    →  .pi/orchestrator/audit-workflow.md (verdict)
```

Sages owns the 4 orchestrator tools and all `.pi/orchestrator/*`
files. Subagent spawning, worktree creation, background queueing, and
result collection are owned by `@tintinweb/pi-subagents` (deliberate
delegation boundary — Sages does not re-implement the Agent tool).

`software-developer` (TDD: RED → GREEN → REFACTOR) and
`software-auditor` (per-task certifier) are user-level agents shipped
to `~/.pi/agent/agents/` by `pi/scripts/install.sh`. `Explore`,
`Plan`, `general-purpose` are built-in.

## Installation

```bash
# Quick install
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash

# Manual
git clone https://github.com/vanpipy/sages.git
cd sages && ./pi/scripts/install.sh
```

The installer registers the 4 orchestrator tools, installs the
orchestrator skill + system prompt, ships the two custom subagent
templates, and adds the `@tintinweb/pi-subagents` npm dependency.

## Workflow

| Stage | Tool | Output |
|---|---|---|
| 1 | `goal_contract_create({ id, success_criteria, anti_goals, scope, constraints, done_definition })` | `.pi/orchestrator/goal-{id}.yaml` |
| 2 | `dag_synthesize({ goal_id, tasks: [...] })` | `.pi/orchestrator/dag-{id}.yaml` |
| 3 | `task_dispatch({ dag_id, strategy })` | Agent-call plan (LLM spawns) |
| 4 | `orchestrator_audit({ dag_id, batch?, task_id?, depth?, observation })` | `.pi/orchestrator/audit-workflow.md` |

**Defaults**: `depth: "fast"` (3 phases ink/nose/foot; `full` adds
castration/death). `run_in_background` is derived from
`subagent_type` — Explore/Plan/general-purpose foreground,
software-developer/software-auditor background. Override per task via
`TaskNode.run_in_background`.

**Evidence gate** (cannot be bypassed): `verdict: "PASS"` requires
`findings.length ≥ findings_required_min` (1 fast / 3 full) AND
`workflowReady === true`; otherwise the tool auto-downgrades to
`REVISE`.

## MDD Plane

Each `TaskNode` carries an MDD `plane` (Business / Data / Control /
Foundation / Observation / Security / Evolution) and `priority` for
DAG auditing. The original four-sage workflow that authored
`draft.md` files is gone.

## Project Structure

```
sages/
├── pi/
│   ├── src/
│   │   ├── extension.ts                  # entrypoint → registerOrchestratorTools
│   │   ├── index.ts
│   │   └── tools/
│   │       ├── orchestrator/             # 4-tool surface + types + template renderer
│   │       └── brainstorming/            # pre-design intent clarification
│   ├── test/                              # 343 tests
│   ├── skills/                            # orchestrator + brainstorming
│   └── templates/                         # installed by install.sh to ~/.pi/agent/
└── .pi/orchestrator/                      # runtime workspace (ephemeral)
```

## Development

```bash
cd pi
bun run typecheck       # 0 errors
bun test ./test         # 343 pass
bash test/install.test.sh  # all pass
```

All three must pass before committing. Imports: use `@/...` in
`pi/test/`, relative paths in `pi/src/`.

## Security

- No direct `node:fs` in production code — use `FileService`.
- `.pi/orchestrator/` directory is `0o700`; audit state and report
  files are `0o600`.
- No hardcoded models, no API keys in code.

## History

The project name and agent-titles reference Chinese mythology
(Fuxi / QiaoChui / LuBan / GaoYao). The current runtime is the
4-tool DAG-based orchestrator documented above; the legacy role-named
tools and `.sages/workspace/` storage were removed in a
`simplify-actions` refactor. Regression-guarded by
`pi/test/post-tool-removal.test.ts`.

## License

MIT
