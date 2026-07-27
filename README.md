# Sages

Multi-agent workflow system for [pi](https://pi.dev). A 4-tool
orchestrator drives a Goal → DAG → Dispatch → Audit pipeline; TDD
implementation and per-task auditing are delegated to `developer` and
`auditor` subagents spawned via the Agent tool from
`@tintinweb/pi-subagents`. See [History](#history) for the project's
Four-Sages mythology.

## What's in this repo

Sages is a monorepo of 6 npm packages:

| Package | Purpose |
|---|---|
| `pi` | Main orchestrator (4-tool pipeline + 2 meta-file tools) |
| `pi-subagents` | Agent tool (subagent lifecycle, worktrees) |
| `pi-codebase-memory` | Code knowledge graph (MCP server) |
| `pi-evaluator` | Eval metrics (cost, security, text quality) |
| `pi-minimax` | MiniMax AI integration |
| `pi-yunxiao` | Alibaba Cloud DevOps integration |

## Architecture

```
goal_contract_create  →  .pi/orchestrator/goal-{id}.yaml
        ↓
dag_synthesize        →  .pi/orchestrator/dag-{id}.yaml
        ↓
task_dispatch         →  Agent-call plan (LLM spawns)
        ↓
developer / auditor (subagents) →  /tmp/pi-subagents-.../tasks/<id>.output
        ↓                                      (L3 main agent writes summary to .pi/orchestrator/)
orchestrator_audit    →  .pi/orchestrator/audit-workflow.md (verdict)

(meta-file tools, path-gated:)
sages_write / sages_edit  →  .pi/orchestrator/*, pi/*, pi-*/, root docs
```

Sages owns the 4 orchestrator tools + 2 meta-file tools. Subagent
spawning, worktree creation, background queueing, and result
collection are owned by `@tintinweb/pi-subagents`. Full operational
manual: [AGENTS.md](AGENTS.md).

## Installation

```bash
# Main orchestrator (required)
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash

# Subpackages (each has its own installer)
./pi-{subagents,codebase-memory,evaluator,minimax,yunxiao}/scripts/install.sh
```

## Workflow

| Stage | Tool | Output |
|---|---|---|
| 1 | `goal_contract_create` | `goal-{id}.yaml` |
| 2 | `dag_synthesize` | `dag-{id}.yaml` |
| 3 | `task_dispatch` | Agent-call plan |
| 4 | `orchestrator_audit` | `audit-workflow.md` |

**Evidence gate** (cannot be bypassed): `verdict: "PASS"` requires
`findings.length ≥ findings_required_min` (1 fast / 3 full) AND
`workflowReady === true`; otherwise auto-downgrades to `REVISE`.

For developers and security researchers, see [AGENTS.md](AGENTS.md).

## Development

```bash
cd pi
bun install && bun run typecheck && bun test   # 528 tests across 29 files
```

Commit messages follow [Conventional Commits
1.0.0](https://www.conventionalcommits.org/). Use `@/...` in
`pi/test/`, relative paths in `pi/src/`.

## Security

- No direct `node:fs` in production code — use `FileService`.
- `.pi/orchestrator/` is `0o700`; audit state and reports are `0o600`.
- No hardcoded models, no API keys in code.
- L3 main agent has a two-layer hard threshold (path-gate + bash-guard)
  preventing direct writes to user production code.

For the full security model (write policy, hard threshold, three-tier
agent model), see [AGENTS.md](AGENTS.md).

## History

Earlier versions exposed four role-named tools (`fuxi_*`, `qiaoChui_*`,
`luban_*`, `gaoyao_*`) plus an FSM-style orchestrator, with state
under `.sages/workspace/`. Removed in a `simplify-actions` refactor
(2026-07-24). Regression-guarded by `pi/test/post-tool-removal.test.ts`.

## License

`MIT` — see [LICENSE](LICENSE).
