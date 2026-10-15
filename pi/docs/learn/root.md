# Sages monorepo — root overview

> Companion to the per-package docs under `pi/docs/learn/`. Every top-level
> entry the user sees when they `ls /home/leroy/Project/sages` is described
> here; packages get their own file.

## Purpose

`Sages` is a three-layer multi-agent workflow system for [pi](https://pi.dev),
shipped as a yarn/bun workspaces monorepo. It pairs an orchestrator
extension with a TaskStore-style "task board", an autonomous-subagent
runtime, an optional code-intelligence MCP bridge, and an opt-in evaluator
that scores a workflow across five dimensions. The repo root contains
the workspace manifest, two human-facing operational guides
(`README.md` / `AGENTS.md`), the MIT license, git hooks, and the
`pi-codebase-memory` / `pi-evaluator` / `pi-orchestrator` / `pi-subagents` /
`pi-tasks` packages.

The top-level `README.md` is the human-facing entry point; the
top-level `AGENTS.md` is the operational contract an LLM reads at session
start. Both are required reading — the orchestrator extension refuses
to behave as advertised unless the LLM honors the soft-mode rules in
`AGENTS.md`.

## Top-level entries

| Path | What it is |
|---|---|
| `README.md` | Human-facing overview: layered table, runtime diagram, quick start, repository layout, security/license, history. |
| `AGENTS.md` | LLM operational contract: the three packages' role shorthands, orchestrator tool surface, subagent dispatch rules, soft-mode policy, red lines, deep references. |
| `LICENSE` | MIT license. |
| `package.json` | The monorepo root manifest (`@sages/sages`, private, workspaces). |
| `package-lock.json` | npm lockfile. (The workspace packages also ship a `bun.lock`; npm/yarn coexist.) |
| `bun.lock` | Bun lockfile used by the orchestrator's `bun run typecheck` / `bun test` gates. |
| `.gitignore` | Standard ignores (`node_modules/`, `dist/`, `.pi/`, etc.). |
| `.husky/` | Git hooks; `husky install` is wired via the root `prepare` script. |
| `.pi/` | Per-workspace orchestrator runtime state (session artifacts). Not committed (`.gitignore`). |
| `.serena/` | Optional Serena MCP server local cache. Not committed. |
| `node_modules/` | Hoisted dependencies for the workspace root. |

## Root manifest — `package.json` (1–29)

```json
{
  "name": "@sages/sages",
  "version": "1.0.0",
  "private": true,
  "workspaces": ["pi-orchestrator", "pi-subagents", "pi-codebase-memory", "pi-evaluator"],
  "scripts": {
    "orchestrator:typecheck": "cd pi-orchestrator && bun run typecheck",
    "orchestrator:test":      "cd pi-orchestrator && bun test ./test --path-ignore-patterns dist/",
    "prepare": "husky install"
  },
  "devDependencies": { "husky": "^9.1.7" },
  "license": "MIT",
  "author": "vanpipy@gmail.com"
}
```

- `workspaces` lists **four** packages, not five: `pi-tasks` is loaded
  by `pi-orchestrator`'s dependency on `@sages/pi-tasks` (`file:../pi-tasks`),
  not registered as a workspace member. The `package.json` namespaces
  `@sages/pi-tasks`, `@sages/pi-subagents`, `@sages/pi-orchestrator`,
  `@sages/pi-codebase-memory`, `@sages/pi-evaluator`; only the four
  registered as workspaces share the hoisted `node_modules/`.
- The only top-level scripts delegate into `pi-orchestrator`. There is
  no top-level `test`, no top-level `lint`, no top-level `build`.
- `husky` is a dev dependency and its `prepare` script wires the
  pre-commit hook (`orchestrator:typecheck` + `orchestrator:test`).

## `README.md` — public-facing overview (key sections)

- **Layer table** (`README.md:5–9`): three rows mapping
  `pi-orchestrator` → Planning, `pi-tasks` → Tracking, `pi-subagents` →
  Executing.
- **Runtime diagram** (`README.md:20–54`): the `## How it works`
  section — ASCII art of the LLM → `TaskCreate` × N → `TaskStore` →
  `TaskExecute` → cross-extension RPC → `AgentManager` → detached pi
  session → result event → LLM loop.
- **Soft mode policy** (`README.md:55–63`): the
  `### Soft mode policy (GC-2026-031)` subsection — restates
  GC-2026-031: the orchestrator curates a tool allowlist but never
  blocks commands.
- **Quick start** (`README.md:64–82`): the `## Quick start` section —
  the `install.sh` one-liner and the `TaskCreate × N + TaskExecute`
  workflow.
- **Repository layout** (`README.md:83–92`): the
  `## Repository layout` table — one row per package, naming the
  orchestrator's tool surface and the standard tasks / subagents
  shapes.

## `AGENTS.md` — LLM operational contract

The most important LLM-facing doc in the repo. Sections:

- **The three packages and their roles** (`AGENTS.md:7–27`): table
  naming the Task Board / Task Orchestrator / Task Executor
  shorthands; declares the sole-creator / sole-consumer boundary
  (`only the Task Orchestrator calls TaskCreate`).
- **What you are** (`AGENTS.md:28–54`): the three guiding principles —
  soft-mode, managed-worktree dispatch for production code, current-
  workspace dispatch for meta-files.
- **The orchestrator tool surface** (`AGENTS.md:55–72`): documents
  `task_inspect` / `task_consume` / `task_convert_intent`.
- **The shipped subagent types** (`AGENTS.md:76–96`): `Developer` and
  `Reviewer` as the two built-in defaults from
  `pi-subagents/src/default-agents.ts`.
- **Profiles** (`AGENTS.md:97–109`): documents GC-2026-073 — the
  conductor/profile mechanism is gone; the orchestrator's
  `extension.ts` absorbs the three hooks directly.
- **Soft mode and the task-count threshold** (`AGENTS.md:212–240`):
  the once-per-session reminder fired by `extension.ts:tool_call`.
- **Red lines** (`AGENTS.md:284–318`): 9 hard "never" rules — no
  `isolation: "worktree"`, no `--no-verify`, no unregistered subagent
  type, no self-declared workflow `PASS`, etc.
- **Deep references** (`AGENTS.md:319–324`): pointers to the
  orchestrator skill, agent-tool description, brainstorming skill,
  and system prompt.

## How the pieces fit (runtime)

The high-level runtime loop, per `README.md:20–54`:

1. The LLM in the main session calls `TaskCreate × N` (one per phase,
   with `agentType` set) and `TaskExecute` on the first ready task.
   For intent-driven workflows, the LLM may use the
   `task_convert_intent(task_id, plan)` structured intent-to-plan
   converter (see [`pi-orchestrator.md`](./pi-orchestrator.md)).
2. `pi-tasks` writes to a file-backed `TaskStore` at
   `${ORCHESTRATOR_WORKDIR}/${projectKey(cwd)}/tasks/tasks.json` (see
   [`pi-tasks.md`](./pi-tasks.md#key-symbols)). Cascade fires on
   `subagents:completed`.
3. `TaskExecute` emits a `subagents:rpc:spawn` event on the pi events
   bus.
4. `pi-subagents`' `AgentManager` (see [`pi-subagents.md`](./pi-subagents.md#key-symbols))
   spawns a detached pi session with the chosen agent type, with
   optional git-worktree isolation.
5. The subagent finishes; the manager emits `subagents:completed` with
   the result. `pi-tasks` writes the result to `metadata.result`,
   advances the cascade, and notifies the LLM.

The orchestrator's session hooks are layered on top:

- `session_start` (`pi-orchestrator/src/extension.ts:177`) calls
  `pi.setActiveTools([...PI_TASKS_TOOLS, ...SUBAGENT_TOOLS, ...AFT_TOOLS, ...BASELINE_TOOLS, ...PI_ROUTINES_TOOLS])`.
- `before_agent_start` (`pi-orchestrator/src/extension.ts:194`) prepends
  `templates/SYSTEM.md` to every LLM system prompt.
- `tool_call` (`pi-orchestrator/src/extension.ts:209`) fires the
  once-per-session soft-mode reminder on the first side-effecting call
  (`bash` / `edit` / `write`).

## Where to learn more

- [`README.md`](./README.md) — this directory's index.
- [`pi-tasks.md`](./pi-tasks.md) — Task Board (tracking layer).
- [`pi-orchestrator.md`](./pi-orchestrator.md) — Task Orchestrator (planning layer).
- [`pi-subagents.md`](./pi-subagents.md) — Task Executor (executing layer).
- [`pi-codebase-memory.md`](./pi-codebase-memory.md) — code-intelligence MCP bridge.
- [`pi-evaluator.md`](./pi-evaluator.md) — opt-in reward-mode evaluator.