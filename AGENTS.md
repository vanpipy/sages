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
| `sages_write` / `sages_edit` | — | **Path-gated** writes to Sages meta-files (`.pi/orchestrator/`, `pi/`, root docs). Rejects production code — see §“Write policy” below |

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

## Write policy (main agent)

The main orchestrator agent can write **directly** to Sages meta-files
only. For everything else, dispatch a `software-developer` subagent
via the Agent tool.

**Allowlisted for direct write** (via `sages_write` / `sages_edit`):

- `.pi/orchestrator/**` — goal / dag / audit / state / designs
- `pi/src/`, `pi/test/`, `pi/skills/`, `pi/templates/`, `pi/scripts/`
- `README.md`, `AGENTS.md`, `package.json`, `tsconfig.json`
- `.gitignore`, `.graphifyignore`, `.aft.jsonc`, `.claude/`, `.codex/`

**Production code** (user `src/`, `test/`, `lib/`, `*.ts`, `*.py`, …) is
**rejected by the gate** with `{ isError: true }` and a message pointing
at the Agent tool. The gate's job is to protect the audit invariant
(software-auditor independently re-runs `verification_cmd` on the
developer's work) and DAG-attribution (every production change has
a goal contract + task + subagent + audit verdict).

**Read tools remain unrestricted** (`read`, `aft_read`, `aft_search`,
`codebase_*`, `graphify_*`, `bash` for read-only commands) — the main
agent still needs to read user code to understand context.

## Hard Threshold — Brain-vs-Limb Separation (added 2026-07-24)

Beyond the path gate, the extension enforces a **two-layer hard
threshold** so the main agent cannot bypass the brain-vs-limb
separation by accident or by intent. Both layers share `canMainAgentWrite`
from `pi/src/tools/file-gate.ts` as **single source of truth** — adding a
new production-deny pattern updates both gates at once.

### Layer 1 — Toolset drop (`session_start`)

The main agent's active toolset is filtered on every session start:

```ts
pi.on("session_start", () => {
    pi.setActiveTools(
        pi.getActiveTools().filter((t: string) => t !== "edit" && t !== "write"),
    );
});
```

The LLM's `tool_calls` list never includes raw `edit` or `write`. The
only paths to modify any file are:

| Target | Allowed path |
|---|---|
| Meta-files (`.pi/`, `pi/`, root docs, …) | `sages_write` / `sages_edit` (path-gated) |
| Production code | `Agent` dispatch to `software-developer` (TDD + worktree + audit) |

If the LLM tries to call raw `edit`/`write`, the tool isn't in the
visible list — the model has to take one of the two allowed paths.

### Layer 2 — Bash write-intent gate (`tool_call`)

Defense-in-depth for `bash` (which we can't easily drop because the main
agent needs it for read-only commands like `ls`, `cat`, `git status`,
`bun test`):

```ts
pi.on("tool_call", (event: any, ctx: any) => {
    if (event.toolName !== "bash") return;
    const decision = shouldBlockBashCommand(event.input.command, { cwd: ctx.cwd });
    if (decision.block) return { block: true, reason: decision.reason };
});
```

`shouldBlockBashCommand` (in `pi/src/tools/bash-guard.ts`):

1. If command (after `trim`) starts with `# sages:safe` → allow (escape hatch)
2. Classify command (`read-only` / `write-intent` / `unknown`)
3. Extract target paths from write-intent commands (`rm`, `mv`, `cp`,
   `sed -i`, `tee`, shell redirects `>` `>>`, `git checkout --`,
   `git restore`, `git rm`, `git clean -fd`, `find -delete`, `tar -xf`)
4. For each target, call `canMainAgentWrite(target)` — same function
   the path gate uses
5. Block if any target is denied, with a redirect message naming the
   target paths + the dispatch instruction

15 design test cases (`pi/test/tools/bash-guard.test.ts` T1–T15) cover
the matrix; the gate also classifies 18 supporting patterns
(`find -exec`, `awk > file`, etc.).

**Known limitation**: command chaining (`echo done && rm src/foo.ts`)
bypes because the first word is `echo` (read-only). Documented future
hardening — add T16 + extend `extractBashTargets` to look past `&&`/`||`/`;`.

### Three-tier agent model (the design is asymmetric on purpose)

| Tier | Who | Write tools | Safety mechanism |
|---|---|---|---|
| **L1 — read-only** | `Explore`, `Plan`, `software-auditor` | **none** (frontmatter `tools:` allowlist) | LLM physically cannot call write |
| **L2 — write-in-worktree** | `software-developer` | `edit`, `write` | `isolation: "worktree"` + `software-auditor` + merge gate |
| **L3 — coordinator** | **main agent** | `sages_write` / `sages_edit` only (raw `edit`/`write` filtered out) | Layer 1 + Layer 2 hard threshold |

Each tier uses the safety mechanism that fits its role. The asymmetry
IS the design — `software-developer` keeps raw edit/write because
that's its job; main agent gives them up because they were never its
job.

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

All **runtime state** lives under `.pi/orchestrator/`. The
`.sages/` directory has been fully retired:

- `.sages/workspace/` — was an empty marker directory (read by
  `pi-codebase-memory` and `pi-graphify`'s `isInSagesWorkspace`,
  and by `pi-graphify/templates/start-mcp.sh`). Detection now uses
  `.pi/orchestrator/` — the real orchestrator state directory.
- `.sages/designs/` — brainstorming's `writeDesignDoc` deferral
  path. Moved to `.pi/orchestrator/designs/`.

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
- **KD-9**: Two-layer hard threshold (Layer 1: `session_start` drops
  raw `edit`/`write` from main agent toolset; Layer 2: `tool_call`
  intercepts bash write-intent) enforces brain-vs-limb separation.
  Both layers import `canMainAgentWrite` from `pi/src/tools/file-gate.ts`
  as **single source of truth** — adding a new production-deny pattern
  (e.g., `*.go`) updates the path-gate AND the bash-gate simultaneously.

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
│       ├── brainstorming/        # pre-design intent clarification (slash command)
│       ├── file-gate.ts          # path-aware write policy (canMainAgentWrite)
│       └── bash-guard.ts         # bash write-intent gate (Layer 2)
├── test/                         # 343 tests
├── skills/                       # orchestrator + brainstorming
└── templates/                    # installed by install.sh
```

## Development

```bash
cd pi
bun run typecheck        # 0 errors
bun test ./test          # 444 pass (was 343 pre-2026-07; +33 bash-guard +7 main-agent-toolset + others)
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
- **Pending hardening**: ~~bash-guard command-chain bypass (`echo done
  && rm src/...`)~~ — **resolved 2026-07-25** by adding
  `splitChainedCommands` (splits on top-level `&&`/`||`/`;` respecting
  quotes + parens) and rewriting `shouldBlockBashCommand` to walk each
  segment independently. T16–T24 in `pi/test/tools/bash-guard.test.ts`.
  No remaining command-chain gaps in the gate.

## History

Earlier versions exposed four role-named tools (`fuxi_*`,
`qiaochui_*`, `luban_*`, `gaoyao_*`) plus an FSM-style orchestrator,
with state under `.sages/workspace/`. Removed in a
`simplify-actions` refactor. The current runtime is the 4-tool
DAG-based orchestrator documented above. Regression-guarded by
`pi/test/post-tool-removal.test.ts`.
