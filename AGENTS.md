# Sages — Orchestrator Architecture

> **Theme**: the project's name references Chinese mythology (Fuxi /
> QiaoChui / LuBan / GaoYao — the four sages). The current runtime is
> a 4-tool DAG-based orchestrator; the legacy role-named tools are
> gone (see [History](#history)).

> **Audience**: this is the operational manual for the LLM reading
> it. For a human-facing summary, see [README.md](README.md).

## Architecture

```
goal_contract_create  →  .pi/orchestrator/goal-{id}.yaml
        ↓
dag_synthesize        →  .pi/orchestrator/dag-{id}.yaml
        ↓
task_dispatch         →  Agent-call plan (LLM spawns)
        ↓
developer             →  /tmp/pi-subagents-.../tasks/<id>.output
auditor      →  /tmp/pi-subagents-.../tasks/<id>.output
                        (L3 main agent writes summary to .pi/orchestrator/)
        ↓
orchestrator_audit    →  .pi/orchestrator/audit-workflow.md (verdict)
```

**Ownership**:

- **Sages** (in-process pi extension): 4 orchestrator tools (write
  `.pi/orchestrator/*` only) and the main-agent gates (Layer 1 +
  Layer 2). The main agent has NO direct write tool — any other
  file edit goes through `Agent` dispatch.
- **`@tintinweb/pi-subagents`** (external): the `Agent` tool —
  subagent spawning, worktree creation, background queueing, result
  collection, steering. Sages does not re-implement this.
- **User-level agents** (installed to `~/.pi/agent/agents/` by
  `pi/scripts/install.sh`): `developer` (canonical; legacy alias
  `developer` resolves to it) and `auditor`
  (canonical; alias `auditor`).
- **Built-in agents** (from pi-subagents): `Explore`, `Plan`.
  (`general-purpose` was removed in DAG-2026-011 Phase C — the
  escape window replaces it for ad-hoc work; see §"Escape Window"
  below.)

> **Tool routing decisions** (AFT vs `codebase_*` vs
> `codebase_memory_*` vs Magic Context vs Sages): see
> `pi/templates/SUBAGENTS.md` once installed.

## The 4 Orchestrator Tools + 2 Meta-File Tools

| Tool | Stage | Purpose |
|---|---|---|
| `goal_contract_create` | 1 | GoalContract: binary success criteria with `verification_cmd`, `anti_goals`, `scope`, `constraints`, `done_definition` |
| `dag_synthesize` | 2 | Validate + persist a TaskNode DAG; render `task_template` from `task_params` |
| `task_dispatch` | 3 | Return Agent-call plan grouped by batch; LLM executes via the external `Agent` tool |
| `orchestrator_audit` | 4 | Read per-task `audit-{id}.md`; aggregate verdicts; enforce evidence gate; write `audit-workflow.md` |
| `sages_write` / `sages_edit` | — | **RETIRED 2026-07-26** (commits f7144b2 + 633ca97). The main agent now has NO direct write tool — all file edits go through `Agent` dispatch (`developer` with `tdd: none` for meta-files / design-doc writes; `developer` with managed worktree for production code). See §"Write policy" below. |

Shared helpers in `pi/src/tools/orchestrator/template-loader.ts`:
`loadPromptTemplate`, `loadGoalTemplate`, `loadDagTemplate`,
`renderTemplate` (`{{var}}` + `{{#if}}` + `{{#each}}`),
`renderTaskPrompt`, `validateTemplateParams`.

## Workflow

1. **Goal** — `goal_contract_create` writes `.pi/orchestrator/goal-{id}.yaml`. Hard-validates unique SC ids, non-empty `verification_cmd`, `criterion ≥ 10` chars, non-empty `done_definition`.
2. **DAG** — `dag_synthesize` writes `.pi/orchestrator/dag-{id}.yaml`. Hard-validates SC coverage, no cycles, batch contiguity, `depends_on` direction, within-batch independence, `task_template` whitelist, `task_params` schema.
3. **Dispatch** — `task_dispatch` returns a `DispatchPlan`; the LLM spawns each task via the `Agent` tool.
4. **Audit** — `auditor` writes per-task `audit-{task_id}.md`; `orchestrator_audit` aggregates into `audit-workflow.md`.

State persists between calls (`audit-state-{dag_id}.yaml`, `chmod 0o600`) so the LLM can resume after context compaction. Lifecycle: `init → recording → complete`; recording after `complete` is rejected.

Detailed workflow + run_in_background policy: see `pi/skills/orchestrator/SKILL.md` (loaded on demand).

### Evidence gate

`verdict: "PASS"` requires both:
- `findings.length ≥ findings_required_min` (`1` fast, `3` full)
- `workflowReady === true` (every task's audit is CERTIFIED)

Otherwise `orchestrator_audit` auto-downgrades to `REVISE` and surfaces the failure in `validation.errors`. **Cannot be bypassed.**

### Path contract

| Call shape | `report_path` |
|---|---|
| `task_id: "P1"` | `.pi/orchestrator/audit-P1.md` |
| `batch: 1` | `.pi/orchestrator/audit-1.md` |
| no filter | `.pi/orchestrator/audit-workflow.md` |

The path the tool **returns** is the path the tool **writes**.

## Write policy (main agent)

The main orchestrator agent has **no direct write tool at all**.
The 4 orchestrator tools (`goal_contract_create`, `dag_synthesize`,
`task_dispatch`, `orchestrator_audit`) write orchestrator state
under `.pi/orchestrator/` only. For any other file edit, dispatch a
subagent via the `Agent` tool:

- **Meta-files** (AGENTS.md, README.md, install scripts, test files,
  design-doc writes): dispatch `developer` with `tdd: none` (DAG-2026-011
  Phase C — the `general-purpose` helper was removed; meta-file edits
  now flow through the `developer` agent in a worktree with the TDD
  cycle disabled). Main agent reviews the diff before committing.
- **Production code** (user `src/`, `test/`, `lib/`, `*.ts`, `*.py`, …):
  dispatch `developer` with managed worktree isolation
  (`isolation: { dag_id, task_id, worktree_id?, mode: "create" | "reuse" }`).
  TDD discipline + audit gate + merge gate apply.

**Meta-files** that the main agent dispatches `developer` to
edit (the bash-guard's `canMainAgentWrite` allowlist is the single
source of truth for this list — see `pi/src/tools/file-gate.ts`):

- `.pi/orchestrator/**` — goal / dag / audit / state / designs
  (NB: the 4 orchestrator tools write here directly; `developer` with
  `tdd: none` can write to designs/, but for state files prefer the
  orchestrator tools)
- `pi/src/`, `pi/test/`, `pi/skills/`, `pi/templates/`, `pi/scripts/`
- `pi-*/` — sibling subpackages (pi-subagents, pi-codebase-memory,
  pi-graphify, pi-evaluator, pi-minimax, pi-yunxiao)
- `README.md`, `AGENTS.md`, `package.json`, `tsconfig.json`
- `.gitignore`, `.graphifyignore`, `.aft.jsonc`, `.claude/`, `.codex/`

**Production code** (user `src/`, `test/`, `lib/`, `*.ts`, `*.py`, …) is
**rejected by the bash-guard** for any subagent. The guard's job is to
protect the audit invariant (auditor independently re-runs
`verification_cmd` on the developer's work) and DAG-attribution
(every production change has a goal contract + task + subagent +
audit verdict).

**Read tools remain unrestricted** (`read`, `aft_read`, `aft_search`,
`codebase_*`, `graphify_*`, `bash` for read-only commands) — the main
agent still needs to read user code to understand context.

### Subagent write prohibition (added 2026-07-25)

Subagents (`developer`, `auditor`, `Explore`, `Plan`)
**MUST NOT** actively write to `.pi/orchestrator/`. This directory is
the orchestrator's state space — only the L3 main agent (or humans
explicitly) decide what goes in there. (`general-purpose` was removed
in DAG-2026-011 Phase C; the `developer` agent with `tdd: none` may
write design docs to `designs/`, but the rest of the state is
off-limits.)

- Subagent roles produce their verdicts in the Agent tool's response.
- The persistent output file managed by pi-subagents
  (`/tmp/pi-subagents-.../tasks/<id>.output`) is the subagent's only
  allowed write target.
- If the LLM orchestrator needs to record an audit trail, it writes a
  SUMMARY based on the subagent's response — that is the orchestrator's
  record, not the subagent's.

Practical consequences:
- The `developer` / `auditor` agent templates must NOT
  instruct subagents to write `task-{id}-report.md` or
  `audit-{id}.md` to `.pi/orchestrator/`.
- `pi/src/tools/orchestrator/task-dispatcher.ts` `report_path` field
  should not route subagent output to `.pi/orchestrator/`.

### Bare-repo git internals rule (added 2026-07-25)

The original repo's git internals are read-only from EVERY agent's
perspective — L3 main agent, L2 developer, L2 auditor, L1 read-only,
all subagents.

Concrete prohibitions:
- Do NOT write to `.git` (the main worktree's git pointer file).
- Do NOT run `git merge`, `git worktree add/remove`, `git checkout`,
  `git branch -D`, or any other ref-mutating command from the bare
  repo root (`/home/leroy/Project/sages`).
- Do NOT manipulate the bare repo's `.git/` directory directly.
- Do NOT modify any file under the main worktree directly.

Correct pattern:
- All git operations (merge, worktree add/remove, checkout, branch)
  must be initiated from inside a worktree (`/tmp/<purpose>-<dag>`).
- Worktrees themselves are fine to create — they're the "scratch
  space" at `/tmp/pi-agent-*` or `/tmp/merge-*`.
- The "original repo" = bare repo + main worktree is read-only from
  every agent's perspective.

If a workflow needs the main worktree and it's broken: do NOT fix it;
use a fresh `/tmp/<purpose>-<dag>` worktree. The user can fix their
local setup separately.

Background: 2026-07-25 during GC-2026-004, an earlier operation had
renamed the main worktree's `.git` to `.git.old`. The L3 main agent
violated the rule twice — running `git merge` directly in the bare
repo, and trying to restore `.git` by `echo "gitdir: ..." > .git`.
The proper response would have been "use a different worktree". Going
forward, every agent must respect this rule.

## Hard Threshold — Brain-vs-Limb Separation (added 2026-07-24)

Beyond the path gate, the extension enforces a **two-layer hard
threshold** so the main agent cannot bypass the brain-vs-limb
separation by accident or by intent. Both layers share
`canMainAgentWrite` from `pi/src/tools/file-gate.ts` as **single source
of truth** — adding a new production-deny pattern updates both gates
at once.

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
LLM has NO direct write tool at all — the only paths to modify any
file are:

| Target | Allowed path |
|---|---|
| Orchestrator state (`.pi/orchestrator/goal-*.yaml`, `dag-*.yaml`, `audit-*.md`) | 4 orchestrator tools (direct write, no dispatch) |
| Other meta-files (`.pi/orchestrator/designs/`, `pi/`, `pi-*/`, root docs, …) | `Agent({subagent_type: "developer", isolation: {...}, tdd: "none"})` — managed worktree + no TDD (DAG-2026-011 Phase C: the `general-purpose` helper was removed; meta-file work now uses `developer` with `tdd: none`) |
| Production code (user `src/`, `test/`, …) | `Agent({subagent_type: "developer", isolation: {...}})` — managed worktree + TDD + audit |

If the LLM tries to call raw `edit`/`write`, the tool isn't in the
visible list (Layer 1). The bash-guard (Layer 2) also blocks bash
write-intent (`cat >`, `sed -i`, `tee`, …) targeting production
code — `canMainAgentWrite()` is the single source of truth for the
path policy.

### Layer 2 — Bash write-intent gate (`tool_call`)

Defense-in-depth for `bash` (which we can't easily drop because the
main agent needs it for read-only commands like `ls`, `cat`, `git
status`, `bun test`):

```ts
pi.on("tool_call", (event: any, ctx: any) => {
    if (event.toolName !== "bash") return;
    const decision = shouldBlockBashCommand(event.input.command, { cwd: ctx.cwd });
    if (decision.block) return { block: true, reason: decision.reason };
});
```

`shouldBlockBashCommand` (in `pi/src/tools/bash-guard.ts`):

1. Classify command (`read-only` / `write-intent` / `unknown`)
2. Extract target paths from write-intent commands (`rm`, `mv`, `cp`,
   `sed -i`, `tee`, `perl -pi`, shell redirects `>` `>>` + `N>file`,
   `git checkout --`, `git restore`, `git rm`, `git clean -fd`,
   `find -delete`, `tar -xf`)
3. For each target, call `canMainAgentWrite(target)` — same function
   the path gate uses
4. Block if any target is denied, with a redirect message naming the
   target paths + the dispatch instruction

39 design test cases (`pi/test/tools/bash-guard.test.ts` T1–T39) cover
the matrix; the gate also classifies 18 supporting patterns. The
`splitChainedCommands` walker splits on top-level `&&`/`||`/`;`
respecting quotes + parens, defeating the original first-word bypass.
F4-1 (`perl -pi` target extraction, line 226) and F4-2 (`N>file`
fd-redirect detection, line 85) harden the two known gaps.

### Subagent dispatch contract

The L3 main agent dispatches subagents based on the task shape — NEVER use `developer` for meta-files or git operations without `tdd: none` (or for read-only exploration). See `pi/templates/SUBAGENTS.md § Dispatch Contract` for the full decision tree. DAG-2026-011 Phase C removed the `general-purpose` helper — for ad-hoc work, see the §"Escape Window" section below.

### Three-tier agent model

| Tier | Who | Write tools | Safety mechanism |
|---|---|---|---|
| **L1 — read-only** | `Explore`, `Plan`, `auditor` (auditor is read-only on production code; writes only to its own `audit-{task_id}.md`) | **none** (frontmatter `tools:` allowlist) | LLM physically cannot call write |
| **L2 — write-in-worktree** | `developer` (canonical, alias `developer`) | `edit`, `write` | managed-worktree object (`{ dag_id, task_id, worktree_id?, mode: "create" | "reuse" }`) + `auditor` + merge gate. `tdd: none` flips the gate off for meta-file / design-doc writes (path must still be a meta-file). |
| **L3 — coordinator** | **main agent** | 4 orchestrator tools (write `.pi/orchestrator/*` only) + `Agent` (dispatch). NO direct write tool. Dispatches: `developer` (with `isolation: { dag_id, task_id, mode: "create" }`, `tdd: "none"` for meta-files / design-doc writes; managed worktree + TDD for production code), `auditor` (alias `auditor`) for audit. See `pi/templates/SUBAGENTS.md § Dispatch Contract`. The escape window (§"Escape Window") gives the main agent direct write tools in 主动 mode when it gets stuck. | Layer 1 + Layer 2 hard threshold |

The asymmetry IS the design — `developer` keeps raw edit/write
because that's its job; main agent gives them up because they were
never its job.

## File Layout

```
.pi/orchestrator/
├── goal-{id}.yaml              # GoalContract
├── dag-{id}.yaml               # OrchestrationPlan
├── audit-state-{dag_id}.yaml   # persisted AuditState (0o600)
├── task-{id}-report.md         # L3 main agent's summary of developer output
├── audit-{task_id}.md          # L3 main agent's summary of auditor output
├── audit-workflow.md           # workflow rollup (0o600)
└── designs/                    # brainstorming "save for later" (see brainstorming/index.ts:writeDesignDoc)
```

Brainstorming designs: `.pi/orchestrator/designs/{date}-{name}.md`. The
`.sages/designs/` path sometimes appears in older notes — that
directory was retired in 2026-07-24 along with the legacy
`.sages/workspace/` (the marker at `.sages/workspace/` is now read
only by `pi-graphify/templates/start-mcp.sh` and
`pi-codebase-memory/src/index.ts` to detect a Sages repo).

## Design Decisions (KD-1..9)

- **KD-1**: Only 4 orchestrator tools; subagent spawning is delegated
  to the Agent tool.
- **KD-2**: `task_dispatch` is a planner, not a scheduler — returns
  instructions, LLM executes.
- **KD-3**: black-box contract — `content.text` = summary, `details`
  = full `DispatchPlan` / audit result.
- **KD-4**: TDD discipline lives in `developer`, not a wrapper.
- **KD-5**: A3 split — per-task audit is `auditor`'s job;
  `orchestrator_audit` is workflow-level rollup. Zero overlap.
- **KD-6**: `run_in_background` derived from `subagent_type` with
  per-task override.
- **KD-7**: All file ops via `FileService`; reports and state
  `chmod 0o600`; orchestrator dir `mkdir 0o700`.
- **KD-8**: `parseAuditReport` regex fallback is permissive (matches
  any `**CERTIFIED|NEEDS WORK|BLOCKED**`); real reports use the
  `## Final Verdict` anchor.
- **KD-9**: Two-layer hard threshold (Layer 1 toolset drop + Layer 2
  bash-guard) enforces brain-vs-limb separation. Both layers import
  `canMainAgentWrite` from `pi/src/tools/file-gate.ts` as **single
  source of truth** — adding a new production-deny pattern (e.g.,
  `*.go`) updates the path-gate AND the bash-guard simultaneously.

## MDD Plane

Each TaskNode carries a `plane` (Business / Data / Control /
Foundation / Observation / Security / Evolution) and `priority` for
DAG auditing. The four-sage workflow that authored `draft.md` files is
gone.

## Monorepo Layout

```
sages/
├── pi/                  # main orchestrator
│   ├── package.json     # entrypoint = ./src/extension.ts
│   ├── src/             # extension.ts + tools/{orchestrator,brainstorming,file-gate,bash-guard}
│   ├── test/            # 530 tests across 29 files
│   ├── skills/          # orchestrator + brainstorming
│   └── templates/       # installed by install.sh
├── pi-subagents/        # Agent tool
├── pi-codebase-memory/  # Code knowledge graph (MCP server)
├── pi-graphify/         # Graph extraction skill
├── pi-evaluator/        # Eval metrics
├── pi-minimax/          # MiniMax AI integration
├── pi-yunxiao/          # Alibaba Cloud DevOps
└── .pi/orchestrator/    # runtime workspace (ephemeral, gitignored)
```

## Development

```bash
cd pi
bun install && bun run typecheck && bun test   # 530 tests across 29 files
bash test/install.test.sh                     # all pass
```

All three must pass before committing. Use `@/...` in `pi/test/`,
relative paths in `pi/src/`. Commit messages follow
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/).

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
- **Bash-guard hardening**: F4-1 (`perl -pi`, `bash-guard.ts:226`)
  and F4-2 (`N>file` fd-redirect regex, `bash-guard.ts:85`) close the
  two known gaps. `splitChainedCommands` walks each top-level segment
  independently, defeating the command-chain bypass. No remaining
  gaps as of 2026-07-26.

## History

Earlier versions exposed four role-named tools (`fuxi_*`,
`qiaochui_*`, `luban_*`, `gaoyao_*`) plus an FSM-style orchestrator,
with state under `.sages/workspace/`. Removed in a `simplify-actions`
refactor (2026-07-24). The current runtime is the 4-tool DAG-based
orchestrator documented above. Regression-guarded by
`pi/test/post-tool-removal.test.ts`.
