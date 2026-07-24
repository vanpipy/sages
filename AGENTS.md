# Sages — Orchestrator Architecture

> **Theme**: the project's name and tool-titles reference Chinese
> mythology (Fuxi / QiaoChui / LuBan / GaoYao). The current runtime
> is a 4-tool DAG-based orchestrator; the role-named tools are gone
> (see [History](#history)).

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

**Ownership**:

- **Sages** (in-process pi extension): the 4 orchestrator tools and
  all `.pi/orchestrator/*` files.
- **`@tintinweb/pi-subagents`** (external): the `Agent` tool —
  subagent spawning, worktree creation, background queueing, result
  collection, steering. Sages does not re-implement this.
- **User-level agents** (installed to `~/.pi/agent/agents/` by
  `pi/scripts/install.sh`): `software-developer`, `software-auditor`.
- **Built-in agents** (from pi-subagents): `Explore`, `Plan`,
  `general-purpose`.

> **Tool routing decisions** (AFT vs `codebase_*` vs
> `codebase_memory_*` vs Magic Context vs Sages): see
> `pi/templates/SUBAGENTS.md` once installed.

## The Four Orchestrator Tools

| Tool | Stage | Purpose |
|---|---|---|
| `goal_contract_create` | 1 | GoalContract: binary success criteria with `verification_cmd`, `anti_goals`, `scope`, `constraints`, `done_definition` |
| `dag_synthesize` | 2 | Validate + persist a TaskNode DAG; render `task_template` from `task_params` |
| `task_dispatch` | 3 | Return Agent-call plan grouped by batch; LLM executes via the external `Agent` tool |
| `orchestrator_audit` | 4 | Read per-task `audit-{id}.md`; aggregate verdicts; enforce evidence gate; write `audit-workflow.md` |

Plus shared helpers in
`pi/src/tools/orchestrator/template-loader.ts`:
`loadPromptTemplate`, `loadGoalTemplate`, `loadDagTemplate`,
`renderTemplate` (`{{var}}` + `{{#if}}` + `{{#each}}`),
`renderTaskPrompt`, `validateTemplateParams`.

## Workflow

1. **Goal** — `goal_contract_create` writes `.pi/orchestrator/goal-{id}.yaml`.
   Hard-validates: unique SC ids, non-empty `verification_cmd`,
   `criterion ≥ 10` chars, non-empty `done_definition`.
2. **DAG** — `dag_synthesize` writes `.pi/orchestrator/dag-{id}.yaml`.
   Hard-validates: SC coverage, no cycles, batch contiguity, `depends_on`
   direction, within-batch independence, `task_template` whitelist,
   `task_params` schema. The shipped templates
   (`pi/skills/orchestrator/templates/dag/`) are regression-guarded
   to validate as-is.
3. **Dispatch** — `task_dispatch` returns a `DispatchPlan`; the LLM
   spawns each task via the external `Agent` tool. The tool does
   **not** spawn subagents itself.
4. **Audit** — `software-auditor` writes per-task
   `audit-{task_id}.md` with verdict `CERTIFIED | NEEDS WORK |
   BLOCKED`. `orchestrator_audit` reads those reports, aggregates
   workflow-level rollup, enforces the evidence gate, writes
   `audit-workflow.md` with verdict `PASS | REVISE | REJECT`.

State persists between calls (`audit-state-{dag_id}.yaml`,
`chmod 0o600`) so the LLM can resume after context compaction.
Lifecycle: `init → recording → complete`; recording after `complete`
is rejected.

### `run_in_background` policy

Derived from `subagent_type` (per `defaultRunInBackground`):

| `subagent_type` | Default | Why |
|---|---|---|
| `Explore`, `Plan`, `general-purpose` | `false` (foreground) | Short, read-only, output feeds next prompt |
| `software-developer`, `software-auditor` | `true` (background) | Long (1–10 min), steerable mid-run |
| unknown | `true` | Conservative default |

Per-task override: `TaskNode.run_in_background?: boolean`.

### Evidence gate

`verdict: "PASS"` requires both:
- `findings.length ≥ findings_required_min` (`1` fast, `3` full)
- `workflowReady === true` (every task's audit is CERTIFIED)

Otherwise `orchestrator_audit` auto-downgrades to `REVISE` and
surfaces the failure in `validation.errors`. Cannot be bypassed.

### Path contract

| Call shape | `report_path` |
|---|---|
| `task_id: "P1"` | `.pi/orchestrator/audit-P1.md` |
| `batch: 1` | `.pi/orchestrator/audit-1.md` |
| no filter | `.pi/orchestrator/audit-workflow.md` |

The path the tool **returns** is the path the tool **writes**.

## File Layout

```
.pi/orchestrator/
├── goal-{id}.yaml              # GoalContract
├── dag-{id}.yaml               # OrchestrationPlan
├── audit-state-{dag_id}.yaml   # persisted AuditState (0o600)
├── task-{id}-report.md         # developer's report
├── audit-{task_id}.md          # per-task auditor's report
└── audit-workflow.md           # workflow rollup (0o600)
```

All **runtime state** lives under `.pi/orchestrator/`. The only
remaining `.sages/` paths are:

- `.sages/workspace/` — an **empty marker directory**. Read by
  `pi-graphify/templates/start-mcp.sh` and
  `pi-codebase-memory`'s `isSageWorkspace` heuristic to detect
  "is this a sages project?". Not state storage.
- `.sages/designs/` — historical path; brainstorming's `writeDesignDoc`
  now writes deferred design drafts to
  `.pi/orchestrator/designs/` to keep all runtime state under one
  prefix.

## Design Decisions (KD-1..8)

- **KD-1**: Only 4 orchestrator tools; subagent spawning is delegated
  to the Agent tool.
- **KD-2**: `task_dispatch` is a planner, not a scheduler — returns
  instructions, LLM executes.
- **KD-3**: black-box contract — `content.text` = summary,
  `details` = full `DispatchPlan` / audit result.
- **KD-4**: TDD discipline lives in `software-developer`, not a
  wrapper.
- **KD-5**: A3 split — per-task audit is `software-auditor`'s job;
  `orchestrator_audit` is workflow-level rollup. Zero overlap.
- **KD-6**: `run_in_background` derived from `subagent_type` with
  per-task override.
- **KD-7**: All file ops via `FileService`; reports and state
  `chmod 0o600`; orchestrator dir `mkdir 0o700`.
- **KD-8**: `parseAuditReport` regex fallback is permissive (matches
  any `**CERTIFIED|NEEDS WORK|BLOCKED**`); real reports use the
  `## Final Verdict` anchor.

## MDD Plane

Each TaskNode carries an `plane` (Business / Data / Control /
Foundation / Observation / Security / Evolution) and `priority` for
DAG auditing. The four-sage workflow that authored `draft.md` files
is gone.

## pi Package

```
pi/
├── package.json                  # entrypoint = ./src/extension.ts
├── src/
│   ├── extension.ts              # registerSagesExtension → registerOrchestratorTools
│   ├── index.ts
│   └── tools/
│       ├── orchestrator/         # 4-tool surface + types + template renderer
│       └── brainstorming/        # pre-design intent clarification (slash command)
├── test/                         # 343 tests
├── skills/                       # orchestrator + brainstorming
└── templates/                    # installed by install.sh
```

## Development

```bash
cd pi
bun run typecheck        # 0 errors
bun test ./test          # 343 pass
bash test/install.test.sh   # all pass
```

All three must pass before committing. Use `@/...` in `pi/test/`,
relative paths in `pi/src/`.

## Security

- **No direct `node:fs`** in production code — use `FileService`.
- **Path validation** via `validatePath()`.
- **No hardcoded models**, no API keys in code.
- **Audit state and reports** are `chmod 0o600`; orchestrator dir
  `0o700`. `chmod` is wrapped in `try/catch` for non-POSIX.
- **Pending P2**: `injectUpstreamOutputs` reads `upstream.output_path`
  without a realpath / project-prefix check. Threat model currently
  assumes developer/auditor agents are trusted; harden before
  exposing the audit tool to untrusted DAGs.

## History

Earlier versions exposed four role-named tools (`fuxi_*`,
`qiaochui_*`, `luban_*`, `gaoyao_*`) plus an FSM-style orchestrator,
with state under `.sages/workspace/`. Removed in a
`simplify-actions` refactor. The current runtime is the 4-tool
DAG-based orchestrator documented above. Regression-guarded by
`pi/test/post-tool-removal.test.ts`.
