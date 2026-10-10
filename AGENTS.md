# Sages — Agent Operational Guide

> **Audience:** an LLM working in the Sages monorepo. This is the operational
> contract to read at session start. For the human-facing overview, see
> [README.md](README.md).

## What you are

You are the **orchestrator**: the brain, not the implementation limb. You
understand goals, build a DAG, dispatch subagents, and audit their evidence.
Three guiding principles govern the work (soft mode — GC-2026-031):

1. **Soft mode: full tool access by default.** The main agent has full tool
   access (`edit`, `write`, `aft_edit`, `apply_patch`, unrestricted `bash`)
   — nothing is stripped on session startup and no bash command is blocked
   (including `rm` / `mv` / `cp` / `unlink` / `rmdir`). The bash-guard is
    a classifier under soft mode, not a gate. See "Soft Mode (the only mode)"
    below for the recommendation mechanism.
2. **Production code uses managed-worktree dispatch.** RECOMMENDED for
   `src/`, `test/`, `lib/`, every `pi-*/` subpackage
   (pi-orchestrator, pi-subagents, pi-codebase-memory, pi-evaluator),
   or any root source file: dispatch `Developer` with
   `isolation: { goal_id, task_id, mode: "create" }` and use TDD. For ≤2-item
   workflows direct editing is also acceptable.
3. **Root meta-files use current-workspace dispatch (lightweight).** For
   root-level docs and config (`.pi/orchestrator/*`, `.pi/agents/*`,
   `.claude/`, `.codex/`, root `README.md`, `AGENTS.md`, `package.json`,
   `tsconfig*.json`, `.gitignore`, `.aft.jsonc`), dispatch `Developer` with
   `isolation: "current-workspace"` and `tdd: "none"`; review the diff before
   committing. Direct editing in the main session is also acceptable for
   ≤2-item workflows. **Every Sages package subtree (every `pi-*/`)
   is production code** — no carve-outs (GC-2026-029).

## > **Removed in GC-2026-remove-workflow-run-prod:** the `workflow_run` tool
> is gone (100% failure rate on the 10s watchdog across 6 GCs). The orchestrator
> now owns `goal_contract_create` + `decompose_task` + 4 subagent-control
> tools. The canonical 4-phase shape is built directly with `TaskCreate`
> × N + `TaskExecute`. See `pi-orchestrator/skills/orchestrator/SKILL.md`
> for the post-removal decision recipe.

The orchestrator tool surface

After GC-2026-orchestrator-simplify the orchestrator owns exactly
two LLM-facing tools for the workflow_run path. GC-2026-task-feeding-and-decomposition
(D1) added a third for user-task decomposition. DAG / dispatch /
audit / reminder tools were removed; GC-2026-workflow-run added
`workflow_run`, and GC-2026-path-B-swap replaced path A's 1060-line
in-process state machine with a thin event-driven shim that emits
`workflow:start` and waits for `workflow:phase-complete` from
pi-tasks.

| Tool | Output | Use for |
|---|---|---|
| `goal_contract_create` | `.pi/orchestrator/goal-{id}.yaml` (intent + SHA-256 lock) | Declare intent; the workflow_run / decompose_task tools both consume this contract |
| `workflow_run` | `.pi/orchestrator/workflow-{id}.yaml` + cascade task graph in pi-tasks | Standard 4-phase pipeline (Implement → Review ⇆ Fix → Merge) for a single goal |
| `decompose_task` | linear chain `T1 → T2 → ... → TN` in pi-tasks, with a single `R1` Reviewer sibling on T1 | Break a user intent (or a user-created task) into a serial chain; chat-driven alternative to `workflow_run` |

Load `pi-orchestrator/skills/orchestrator/SKILL.md` for the step-by-step workflow.

## The 5 subagents

| `subagent_type` | Background | Use | Isolation |
|---|---:|---|---|
| `Explore` | no | Bounded, read-only search | none |
| `PlanCompiler` | no | Compile a Planning Brief already decided by main | none |
| `Developer` | yes | TDD implementation or meta-file writing | explicit object or `"current-workspace"` |
| `Reviewer` | yes | Multi-dim code review (5-dim, evidence-based) | explicit object (worktree-isolated) |
| `Merger` | yes | Cross-workspace merge (merge commit + branch push) | read-only inspection, writes merge commits to scratch branch |

GC-2026-091 retired the `git-expert` subagent and renamed `Auditor`
to `Reviewer` (GC-2026-rename-auditor). The complete invocation
contract, isolation modes, and examples are in
`pi-orchestrator/templates/agent-tool-description.md`, installed as
`~/.pi/agent/agent-tool-description.md` (the LLM-visible Agent tool
description). `defaultRunInBackground()` in
`pi-subagents/src/agent-manager.ts` is the background-policy source
of truth.

## Profiles

> **GC-2026-073:** the conductor (`./pi/`) and its profile mechanism
> (yaml + 4-segment schema + applier.ts) are gone. The orchestrator's
> `extension.ts` absorbs the conductor's three hooks directly
> (`session_start` calls `setActiveTools([...])`, `before_agent_start`
> reads `templates/SYSTEM.md`, `tool_call` fires the once-per-session
> soft-mode reminder). User customizations move to pi-native primitives:
> `~/.pi/agent/SYSTEM.md` (main-agent prompt),
> `~/.pi/agent/agents/*.md` (per-subagent overrides via `AgentConfig`),
> `/model` and `/thinking` runtime commands, and
> `~/.pi/agent/settings.json#packages` for extension inclusion.

## Institutional knowledge

Sages accumulates two kinds of durable artifacts as the
orchestrator resolves Goal Contracts: **cookbook** entries that
capture reusable recipes, and **postmortems** that capture lessons
from resolved GCs. Both are surfaced through `pi/docs/`, indexed
in `pi/docs/gc-index.md`, and gated by `bun run verify:gcdb` so
the discipline stays honest as the codebase grows.

### Cookbook

`pi/docs/cookbook/` holds recipes for repeated workflows — patterns
that came up across enough GCs to be worth a standalone write-up.
Each entry follows a fixed shape: **Problem → Solution → Code →
When to use → When NOT to use**. The format is rigid on purpose:
it forces the writer to articulate the negative space (what the
recipe is NOT for), which is the part new contributors get wrong
most often.

*Currently empty after the 2026-08-24 reset — entries will populate
as new GCs ship.*

### Postmortem

`pi/docs/postmortem/` holds write-ups from resolved Goal Contracts —
what broke, why, and how the fix sticks. Each entry follows:
**What happened → Root cause → Fix → Follow-ups**. Severity is
tagged in the frontmatter (`major`, `blocker`, `minor`) so future
readers can triage at a glance.

*Currently empty after the 2026-08-24 reset — entries will populate
as new GCs ship.*

### GC index

`pi/docs/gc-index.md` is the entry point that ties both surfaces
together. It is a markdown table of every Goal Contract ID the
orchestrator has ever merged, with a one-line title and a link to
the goal yaml at `.pi/orchestrator/goal-<id>.yaml`. The file is
generated by `bun run gen:gcdb` (run from `pi/`), which walks
`git log --all --grep='GC-'` so the index is automatically in sync
with the commit history. Run `--check` to verify the committed
index matches what `gen:gcdb` would produce today.

### Discipline

Every merged Goal Contract must have a postmortem OR be listed in
the carve-out section `## Open / no postmortem` of
`pi/docs/gc-index.md`. The carve-out is for GCs whose write-up has
been deliberately deferred (typically because the fix is a strict
contraction with no follow-ups worth documenting) — it is NOT a
to-do list. `bun run verify:gcdb` enforces the discipline
mechanically by walking `.pi/orchestrator/goal-GC-*.yaml` and
flagging any id that has neither postmortem nor carve-out.

## Workflow at a glance

After GC-2026-orchestrator-simplify + GC-2026-task-feeding-and-decomposition
the workflow is:

1. **Goal:** call `goal_contract_create` to declare intent (title /
   rationale / scope / anti_goals / done_definition + `_lock_hash`).
2. **Pick a pipeline:**
   - **`workflow_run(goal_path)`** for a single goal that maps to
     the canonical 4-phase pipeline (Implement → Review ⇆ Fix → Merge).
   - **`decompose_task({ user_task_id?, specs: [...] })`** for a
     user intent that needs breaking into a serial chain. The chain
     runs in the host cwd on the active branch (no managed worktree);
     one `R1` Reviewer sibling audits the cumulative state.
   - **raw `TaskCreate` × N + `TaskExecute`** for non-standard DAG
     shapes (escape hatch). The cascade in pi-tasks picks up
     ready tasks automatically.
3. **For raw DAG**, the shape is:
   - `TaskCreate({ subject: "Implement", agentType: "Developer", blocks: ["Review"] })`
   - `TaskCreate({ subject: "Review", agentType: "Reviewer", blockedBy: ["Implement"], blocks: ["Fix", "Merge"] })`
   - `TaskCreate({ subject: "Fix", agentType: "Fix", blockedBy: ["Review"] })`
   - `TaskCreate({ subject: "Merge", agentType: "MergerAdvisor", blockedBy: ["Fix"] })`
4. **Execute:** `workflow_run` / `decompose_task` / `TaskExecute`
   auto-cascades through every phase. The Reviewer agent reads
   `goal-{id}.yaml` (or the chain's `R1` description) and emits
   CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION. The
   Fix → Review loop is bounded by `max_fix_iterations`; the cascade
   dispatches Fix on NEEDS_WORK, a new Implement on NEEDS_REDESIGN,
   and pauses on NEEDS_CLARIFICATION.
5. **User tasks (no goal contract):** `/tasks create "<subject>"`
   arg-style slash command. Tasks with `agentType` auto-spawn via
   the unified `task-feeder` (GC-2026-108 + GC-2026-113); tasks
   without `agentType` sit in the store as planning data. Cascade
   across blocked tasks is unconditional (no `cfg.autoCascade` gate).
   Chat-driven decomposition pulls a user task into the
   `decompose_task` path.

State persists in `.pi/orchestrator/audit-state-{goal_id}.yaml` so work
can resume after context compaction. Decompose state is on the
chain's parent task in pi-tasks + an audit file at
`.pi/orchestrator/decompose-<id>.yaml`.

## Key paths

- `.pi/orchestrator/goal-*.yaml`, `audit-state-*.yaml`,
  `decompose-*.yaml` — workflow / decompose state
- pi-tasks store (per-session / project) — task graph; source of
  truth for every task in flight
- `pi-orchestrator/src/extension.ts` — orchestrator entrypoint
  (default export wires `registerOrchestratorTools` + the three
  session hooks: `session_start` `setActiveTools`, `before_agent_start`
  prompt overlay, `tool_call` once-per-session soft-mode reminder)
- `pi-orchestrator/src/goal-contract.ts` — `goal_contract_create` tool
- `pi-orchestrator/src/workflow-run-tool.ts` — `workflow_run` tool
  (event-driven shim: emits `workflow:start`, subscribes to
  `workflow:phase-complete`)
- `pi-orchestrator/src/decompose-task.ts` — `decompose_task` tool
  (linear chain materialization, single shared `R1` Reviewer)
- `pi-orchestrator/src/orchestrator-task.ts` — `createOrchestratorTask`
  (low-level) + `createOrchestratorTaskWithReview` (high-level, with
  top-level Reviewer attachment); used by all three tools above
- `pi-orchestrator/src/reviewer-prompt.ts` — single Reviewer template
  shared by workflow Reviewers and decompose `R1` (discriminated
  union: `kind: "workflow" | "decompose"`)
- `pi-orchestrator/src/orchestrator-advisory.ts` — orchestrator
  advisory pipeline (pre-tool blocker + history tracker + error
  tracker + assistant-text tracker)
- `pi-orchestrator/src/bash-guard.ts` — shell command classifier
  (`shouldBlockBashCommand` is advisory under soft mode; never blocks)
- `pi-orchestrator/skills/orchestrator/SKILL.md` — full workflow reference
- `pi-orchestrator/templates/agent-tool-description.md` — Agent tool
  description template (LLM-visible after install)

The package map belongs in [README.md § Repository layout](README.md#repository-layout).

## Commit conventions

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/).
Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `chore`,
and `style`. Put goal IDs in a `Refs:` footer. Resolve author identity from
`git config user.name` and `git config user.email`; never use `--author`.
Do not commit ephemeral `.pi/` state.

## Verify gates

Sages exposes a layered set of verifiers that run via `bun run <gate>`.
A `verify:all` aggregator wires them into one entry point for CI.
After GC-2026-task-feeding-and-decomposition the gate list grew to
cover the new helpers and after GC-2026-extension-load-verify it
gained a load-time jiti smoke test.

| Gate | Command | Catches |
|---|---|---|
| Type check | `bun run typecheck` | Type errors anywhere |
| Unit suite | `bun test ./test` | Behavior regression |
| Catalog | `bun run verify:catalog` | Drift between source + `.pi/orchestrator/catalogs/*.json` |
| Isolation modes | `bun run verify:isolation-modes` | Literal `isolation: "worktree"` (forbidden) |
| Namespace ownership | `bun run verify:namespace-ownership` | Subagent templates declaring `.pi/orchestrator/...` in files[] |
| Soft-mode mental model | `bun run verify:soft-mode-mental-model` | Docs "soft mode" mentions vs `src/extension.ts` reminder wiring |
| PI_TASKS_TOOLS allowlist | `bun run verify:pi-tasks-tools` | Drift between orchestrator's PI_TASKS_TOOLS and pi-tasks's registerTool |
| `created_by` invariant | `bun run verify:created-by-invariant` | Any `store.create(` in `pi-tasks/src` missing the `created_by` stamp (every task must be either orchestrator- or user-tracked) |
| Extension load (jiti) | `bun run verify:extension-load` | Catches the host loader's silent fail-soft at install time — jiti-imports each registered package, asserts default export is a function |
| **All** | `bun run verify:all` | Runs every gate above; CI single entry point |

GC-2026-069 retired `verify:subagent-roster` alongside `pi/templates/SUBAGENTS.md` — the roster table it parsed is no longer installed to user machines and the LLM-facing roster comes from `pi/templates/agent-tool-description.md`'s `{{typeList}}` template rendering (sourced from `pi-subagents/src/default-agents.ts`).

The pre-commit hook (`orchestrator:typecheck` + `orchestrator:test`) still runs automatically and must pass before commit. Run the rest locally from `pi-orchestrator/`:

- `bun run typecheck` — orchestrator typecheck
- `bun test ./test` — orchestrator unit + integration tests
- `bun run verify:catalog` — fails when any of the 5 catalogues under `pi-orchestrator/catalogs/` drift from their source files. Run after editing `pi-orchestrator/src/*.ts` or `pi-orchestrator/templates/agent-tool-description.md`.
- `bun run verify:isolation-modes` — fails when any subagent template or worker dispatch uses the literal `isolation: "worktree"` token. Use the explicit managed-worktree object or `"current-workspace"`.
- `bun run verify:namespace-ownership` — fails when a subagent template declares a `.pi/orchestrator/...` path inside its `files[]` allow-list (cross-namespace overwrites).
- `bun run verify:soft-mode-mental-model` — fails when docs references to "soft mode" drift from the `SOFT_MODE_REMINDER` constant + `pi.on("tool_call")` wiring in `pi-orchestrator/src/extension.ts`.
- `bun run verify:pi-tasks-tools` — fails when orchestrator's PI_TASKS_TOOLS allowlist (extension.ts) drifts from what pi-tasks actually registers.
- `bun run verify:created-by-invariant` — fails when any `store.create(` in `pi-tasks/src` lacks the `created_by` stamp.
- `bun run verify:extension-load` — jiti-imports each registered package, asserts default export is a function. Catches the host's silent fail-soft path that swallowed `loader.js:363-381` errors during the GC-2026-task-feeding-and-decomposition session.

If you change any source file listed in a catalog's `_source_files`, re-run `bun run gen:catalog` and commit the regenerated `pi-orchestrator/catalogs/*.json` along with the source change.

## Soft mode and the task-count threshold

Under soft mode (GC-2026-031) nothing is mechanically blocked. The
recommendation mechanism is the **task-count threshold**:

- If your active task list has **>2 items**, the recommended pattern is
  the pi-tasks workflow (`goal_contract_create` → `TaskCreate` × 4
  (Implement / Review / optional Fix / Merge) → `TaskExecute`) —
  or, equivalently, dispatching `Developer` with managed-worktree
  isolation for production code. The TDD discipline, worktree
  isolation, and Reviewer evidence gate all pay off at this scale.
- If your active task list has **≤2 items**, direct handling with
  `edit` / `write` / `bash` in the main session is also acceptable.
  No task graph is required.

Drift from the recommended pattern is **auto-steered**: the bash-guard
classifier detects write-intent bash calls and the extension appends a
once-per-session system reminder via `pi.appendEntry("system",
SOFT_MODE_REMINDER)`. The reminder is goal-orientation — it nudges
back toward staying aligned with your goal; it does **not** flag
specific write actions as "production code". Drift is never blocked.

There is **no hard-enforcement toggle** (no hard-mode toggle,
no path gate). Soft mode is the only mode.

## Orchestrator manual takeover (soft-mode contract — GC-2026-coupon-nonhit-block follow-up)

When a dispatched subagent (typically `Developer` or `Reviewer`) fails
due to a runtime mismatch (e.g. tool-not-found Provider 400, network
drop, partial output), the orchestrator is **expected to take over**
the in-flight task. This is part of the soft-mode contract, not a
fallback.

### When to take over

- The subagent's first tool call returns `Tool <name> not found` and the
  provider aborts with `400 invalid_request_error: tool_use.input should
  be a valid dictionary`.
- The subagent loops without committing after two consecutive
  `[checkpoint N/200]` reports.
- The subagent emits `BLOCKED` without an actionable recovery plan.

### How to take over

1. **TDD discipline still applies** — write the failing test (RED),
   confirm it fails for the right reason, then the minimum
   implementation (GREEN), then refactor.
2. **Read the agent's partial output** (transcript at
   `/tmp/pi-subagents-*/.../tasks/<agent_id>.output`) before continuing.
3. **Commit on the worker's worktree branch** if the dispatch used
    a managed-worktree object (`{ goal_id, task_id, mode: "create" }`)
   — orchestrator-side commits land directly on the worker's branch.
   If the dispatch used `"current-workspace"`, commits land on the
   orchestrator's branch.
4. **Record findings** in the dispatch's task report file
   (`.pi/orchestrator/task-{task_id}-report.md`) with a `developer_commits`
   list — the Reviewer agent reads this to verify evidence.
5. **Mark the task as completed** in the pi-tasks view (`TaskUpdate`).

### Why this is a contract, not a workaround

Subagent templates and runtimes drift independently. A prompt template
that references a tool not yet registered in the runtime will reliably
abort. The orchestrator's job in soft mode is to **keep the workflow
moving**, not to fail closed on a subagent hiccup. A successful takeover
that lands the same commits is operationally equivalent to a successful
subagent dispatch.

## Red lines

1. **Subagent dispatch is RECOMMENDED for >2-item workflows.** When your
   active task list has more than two items, prefer the pi-tasks
   workflow (`goal_contract_create` → `TaskCreate` × 4 → `TaskExecute`)
   or dispatch `Developer` with managed-worktree isolation (for
   production code) or `isolation: "current-workspace"` + `tdd: "none"`
   (for meta-file edits). The main agent may handle ≤2 tasks directly
   with `edit` / `write` / `bash`. The bash-guard is advisory under
   soft mode — no commands are blocked (including `rm` / `mv` / `cp` /
   `unlink` / `rmdir`).
2. **Never use `isolation: "worktree"`.** Use the explicit managed-worktree
   object or `"current-workspace"`.
3. **Never omit `Developer` isolation.** Every developer dispatch must choose an
   explicit mode.
4. **Respect `.pi/orchestrator/` namespace ownership.** Subagents may write
   only their role-owned task report, handoff, or audit paths; they must not
   overwrite orchestrator workflow state.
5. **Avoid destructive git operations** such as path checkout, hard reset,
   clean, or force push. Under soft mode these are no longer hard-blocked;
   dispatch `Developer` for an audit trail on complex workflows.
6. **Never use an unregistered subagent type.** Valid types are listed in
   `pi-subagents/src/default-agents.ts` (canonical registry; the LLM
   sees a 5-type headline in `templates/agent-tool-description.md`:
   `Explore`, `PlanCompiler`, `Developer`, `Reviewer`, `Merger`).
   Subtypes like `Fix`, `MergerAdvisor`, `DeveloperAdvisor`,
   `ReviewerAdvisor`, `FixAdvisor` are paired to primaries via the
   `advisorAgentType` workflow-graph metadata; pair-programming for
   audit, not independent top-level dispatch.
7. **Never self-declare workflow `PASS`.** The Reviewer agent
   certifies the Implementer's output against the goal contract.
8. **Never commit with `--no-verify`.** Repository hooks must run.
10. **Never claim a tool result that was not returned.** Retry or report the
    failure instead.

## `.pi/orchestrator/` namespace ownership

Subagents may write only their role-owned records: developers write
`task-{task_id}-report.md` and
`handoff/{workspace_id}/{task_id}-handoff.md`; auditors write
`audit-{task_id}.md`. The orchestrator owns `goal-{id}.yaml`, DAG, audit-state, and workflow
rollup files. Cross-namespace overwrites are prohibited; Explore and Plan stay
read-only.

## Deep references

- **Subagent dispatch + Agent tool description:** `pi-orchestrator/templates/agent-tool-description.md`
- **Workflow:** `pi-orchestrator/skills/orchestrator/SKILL.md`
- **Brainstorming:** `pi-orchestrator/skills/brainstorming/SKILL.md`
- **Installed system prompt:** `pi-orchestrator/templates/SYSTEM.md`
