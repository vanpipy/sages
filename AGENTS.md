# Sages — Agent Operational Guide

> **Audience:** an LLM working in the Sages monorepo. This is the operational
> contract to read at session start. For the human-facing overview, see
> [README.md](README.md).

## The three packages and their roles

The Sages runtime is composed of three packages. We refer to their
roles informally as the **Task Board**, the **Task Orchestrator**, and
the **Task Executor**. These names are descriptive shorthand for how
the packages interact — no package calls itself by that name in its
own code.

| Package | Role shorthand | Job |
|---|---|---|
| `pi-tasks/` | Task Board | Dumb persistent state. File-backed `TaskStore` with locking, plus the persistent widget above the editor. Holds the DAG, emits lifecycle events, but never decides shape |
| `pi-orchestrator/` | Task Orchestrator (you) | The brain. The **sole writer** that appends new tasks to the Board, and the **sole consumer** that reads them. Driven by the LLM in the main session |
| `pi-subagents/` | Task Executor | The muscle. Spawned by the Orchestrator via the Board (through `TaskExecute` → cross-extension RPC), runs a subagent session, reports the result back through the event bus. Does not see the Board |

**Boundary — single creator, single consumer.** Only the Task
Orchestrator calls `TaskCreate` / `TaskUpdate` / `TaskOutput` and only
the Task Orchestrator reads task results. The Task Executor is given
a tool allowlist that excludes the Board, so the boundary is enforced
at the host level. The Task Board is passive infrastructure under
both.

## What you are

You are the **Task Orchestrator**: the brain, not the implementation limb.
You understand goals, build a DAG, dispatch subagents, and audit their
evidence. Three guiding principles govern the work (soft mode — GC-2026-031):

1. **Soft mode: full tool access by default.** The main agent has full tool
   access (`edit`, `write`, `apply_patch`, unrestricted `bash`) — nothing
   is stripped on session startup and no bash command is blocked
   (including `rm` / `mv` / `cp` / `unlink` / `rmdir`). Soft mode never
   blocks; it nudges. See "Soft Mode (the only mode)" below for the
   recommendation mechanism.
2. **Production code uses managed-worktree dispatch.** RECOMMENDED for
   `src/`, `test/`, `lib/`, every `pi-*/` subpackage
   (pi-orchestrator, pi-subagents, pi-tasks, pi-codebase-memory,
   pi-evaluator), or any root source file: dispatch `Developer` with
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

## The orchestrator tool surface

The orchestrator owns exactly **one** LLM-facing tool:

| Tool | Output | Use for |
|---|---|---|
| `orchestrate(plan)` | task DAG materialized in pi-tasks's shared store (`<ORCHESTRATOR_WORKDIR>/<projectKey(cwd)>/tasks/tasks.json`, resolved via `pi-tasks/src/task-paths.ts:orchestratorProjectTaskFile`) | Materialize a multi-phase plan as a DAG in one call. For each phase, a task is created with the chosen `agentType`; phase-level `blockedBy` references (by subject) are resolved to task IDs and wired into both ends of every edge. After this returns, `TaskExecute` on the first ready task drives the cascade. |

For full per-step control the orchestrator uses the raw pi-tasks tools
directly: `TaskCreate` × N + `TaskExecute`. Both paths produce the same
DAG; `orchestrate` is the convenience wrapper. No orchestrator-owned
file (goal contract, workflow rollup, audit state) is produced —
`.pi/orchestrator/` carries only optional subagent evidence.

Load `pi-orchestrator/skills/orchestrator/SKILL.md` for the step-by-step workflow.

## The shipped subagent types

Only two agent types ship as built-in defaults in `@sages/pi-subagents`:

| `subagent_type` | Background | Use | Isolation |
|---|---:|---|---|
| `Developer` | yes | TDD implementation or meta-file writing | explicit object or `"current-workspace"` |
| `Reviewer` | yes | Code review (reads Developer's `metadata.result`, emits the 4-state verdict: CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION) | explicit object (worktree-isolated) |

The complete invocation contract, isolation modes, and examples are in
`pi-orchestrator/templates/agent-tool-description.md`, installed as
`~/.pi/agent/agent-tool-description.md` (the LLM-visible Agent tool
description). `defaultRunInBackground()` in
`pi-subagents/src/agent-manager.ts` is the background-policy source
of truth.

User-defined agent types (e.g. `Explore`, `PlanCompiler`, `Merger`,
custom roles) live in `~/.pi/agent/agents/*.md` or `.pi/agents/*.md`.
They extend the registry but are not part of the orchestrator's
standard dispatch surface.

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

Sages accumulates durable artifacts as the orchestrator resolves work.
The primary surface is **cookbook** entries that capture reusable
recipes for repeated patterns.

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

## Workflow at a glance

The orchestrator drives work through pi-tasks's DAG. Two equivalent
paths:

1. **One-shot DAG via `orchestrate(plan)`** — for the standard
   Implement → Review shape, materialize both tasks in a single call.
2. **Raw `TaskCreate` × N + `TaskExecute`** — for any non-standard
   shape (multi-package coordination, parallel tracks, conditional
   dependencies, fan-out / fan-in). The cascade in pi-tasks picks up
   ready tasks automatically.

The Reviewer agent reads the Developer's `metadata.result` via the
incoming `TaskOutput` and emits one of CLEAN / NEEDS_WORK /
NEEDS_REDESIGN / NEEDS_CLARIFICATION. The orchestrator (the main
LLM) reads the verdict via `TaskOutput` and decides whether to
declare the work done or to spawn a follow-up Fix task (with
`agentType: "Developer"`, blockedBy the Review) by hand.

### User tasks (no goal contract)

`/tasks create "<subject>"` arg-style slash command. Tasks with
`agentType` auto-spawn via the unified `task-feeder` (GC-2026-108 +
GC-2026-113); tasks without `agentType` sit in the store as planning
data. Cascade across blocked tasks is unconditional (no
`cfg.autoCascade` gate).

## Key paths

- `pi-tasks/` task store (per-session / project) — task graph; source
  of truth for every task in flight.
- `pi-orchestrator/src/extension.ts` — orchestrator entrypoint
  (default export wires `installSessionHooks` + the `orchestrate` tool).
  The orchestrator curates PI_TASKS / PI_SUBAGENT / SUBAGENT_CONTROL /
  AFT / BASELINE tool allowlists via `setActiveTools` at session_start.
- `pi-orchestrator/src/orchestrator-tool.ts` — the `orchestrate(plan)`
  tool: takes a multi-phase plan, materializes it as a DAG in
  pi-tasks's shared store.
- `pi-orchestrator/src/brainstorming/` — the `/brainstorm` slash
  command's 5-phase state machine (exploring → grilling → proposing →
  designing → approved).
- `pi-orchestrator/skills/orchestrator/SKILL.md` — full workflow reference
- `pi-orchestrator/templates/agent-tool-description.md` — Agent tool
  description template (LLM-visible after install)
- `pi-orchestrator/templates/SYSTEM.md` — orchestrator constitution
  prepended to every agent system prompt.

The package map belongs in [README.md § Repository layout](README.md#repository-layout).

## Commit conventions

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/).
Allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `chore`,
and `style`. Put goal IDs in a `Refs:` footer. Resolve author identity from
`git config user.name` and `git config user.email`; never use `--author`.
Do not commit ephemeral `.pi/` state.

## Verify gates

The pre-commit hook (`orchestrator:typecheck` + `orchestrator:test`) is the only gate that runs automatically; it must pass before every commit. Earlier layered verifier scripts (`verify:isolation-modes`, `verify:soft-mode-mental-model`, `verify:pi-tasks-tools`, `verify:created-by-invariant`, `verify:extension-load`, `verify:pi-universe`, `verify:catalog`, `verify:all`, etc.) were retired along with the `pi-orchestrator/catalogs/` directory they produced. Run the two remaining gates locally from `pi-orchestrator/`:

- `bun run typecheck` — orchestrator typecheck
- `bun test ./test` — orchestrator unit + integration tests

## Soft mode and the task-count threshold

Under soft mode (GC-2026-031) nothing is mechanically blocked. The
recommendation mechanism is the **task-count threshold**:

- If your active task list has **>2 items**, the recommended pattern
  is the pi-tasks workflow: `TaskCreate` × N (one per phase, with
  `agentType: "Developer"` for Implement and `agentType: "Reviewer"`
  for Review) → `TaskExecute`. For the standard 2-phase shape, the
  `orchestrate(plan)` tool collapses it into one call. Production
  code edits dispatch `Developer` with managed-worktree isolation;
  the TDD discipline, worktree isolation, and Reviewer evidence
  trail all pay off at this scale.
- If your active task list has **≤2 items**, direct handling with
  `edit` / `write` / `bash` in the main session is also acceptable.
  No task graph is required.

Drift from the recommended pattern is **auto-steered**: the
extension appends a once-per-session system reminder via
`pi.appendEntry("system", SOFT_MODE_REMINDER)` on the first
side-effecting call. The reminder is goal-orientation — it nudges
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
4. **Record findings** in the dispatch's task metadata
   (`metadata.developer_commits` list on the task) — the Reviewer agent
   reads `metadata.result` of the prior task to verify evidence.
6. **Mark the task as completed** in the pi-tasks view (`TaskUpdate`).

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
   workflow (`TaskCreate` × N + `TaskExecute`, optionally
   `orchestrate(plan)` for the standard 2-phase shape) or dispatch
   `Developer` with managed-worktree isolation (for production code)
   or `isolation: "current-workspace"` + `tdd: "none"` (for meta-file
   edits). The main agent may handle ≤2 tasks directly with
   `edit` / `write` / `bash`. Soft mode never blocks — including
   `rm` / `mv` / `cp` / `unlink` / `rmdir`.
2. **Never use `isolation: "worktree"`.** Use the explicit managed-worktree
   object or `"current-workspace"`.
3. **Never omit `Developer` isolation.** Every developer dispatch must choose an
   explicit mode.
4. **Respect `.pi/orchestrator/` namespace ownership.** The orchestrator
   owns no per-task state file; subagents may write optional evidence
   under `.pi/orchestrator/` but must not overwrite each other.
5. **Avoid destructive git operations** such as path checkout, hard reset,
   clean, or force push. Under soft mode these are no longer hard-blocked;
   dispatch `Developer` for an audit trail on complex workflows.
6. **Never use an unregistered subagent type.** Built-in defaults are
   `Developer` and `Reviewer` (per `pi-subagents/src/default-agents.ts`,
   the canonical registry); other types come from user-defined
   `~/.pi/agent/agents/*.md` or `.pi/agents/*.md`. Resolve any new
   type with `resolveEnabledTypeIn(registry, name)` — case-ambiguous
   or disabled names are rejected, never silently fallen back.
7. **Never self-declare workflow `PASS`.** The Reviewer agent
   certifies the Developer's output against the goal via the
   4-state verdict (CLEAN / NEEDS_WORK / NEEDS_REDESIGN /
   NEEDS_CLARIFICATION).
8. **Never commit with `--no-verify`.** Repository hooks must run.
9. **Never claim a tool result that was not returned.** Retry or report the
   failure instead.

## Deep references

- **Subagent dispatch + Agent tool description:** `pi-orchestrator/templates/agent-tool-description.md`
- **Workflow:** `pi-orchestrator/skills/orchestrator/SKILL.md`
- **Brainstorming:** `pi-orchestrator/skills/brainstorming/SKILL.md`
- **Installed system prompt:** `pi-orchestrator/templates/SYSTEM.md`