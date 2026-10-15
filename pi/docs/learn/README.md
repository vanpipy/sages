# Sages — module-by-module learning walkthrough

This directory holds a one-document-per-package tour of the Sages
monorepo. Each file is a self-contained overview: purpose, entry
points, top key symbols with verified file:line references,
dependencies (peer `pi-*` + external libs), and the runtime flows
that the package owns.

The reference target is the repo as it stands on `main` —
`README.md` and `AGENTS.md` describe the human + LLM contract; this
directory is the code-shape contract, verified against actual
source.

## Index

| Doc | What it covers |
|---|---|
| [`root.md`](./root.md) | Top-level entries: `README.md`, `AGENTS.md`, `package.json`, hooks. The runtime diagram, the layered packages, and the soft-mode contract at a glance. |
| [`pi-tasks.md`](./pi-tasks.md) | Task Board (tracking layer). File-backed `TaskStore` with locking, the 7 LLM-facing `Task*` tools, the `subagents:rpc:spawn` consumer, the above-editor widget, system-reminder cadence. |
| [`pi-orchestrator.md`](./pi-orchestrator.md) | Task Orchestrator (planning layer). Session hooks (`setActiveTools` / `SYSTEM.md` / once-per-session soft-mode reminder), the 3 consumer tools (`task_inspect` / `task_consume` / `task_convert_intent`), verdict parsing, the 5-phase `/brainstorm` state machine. |
| [`pi-subagents.md`](./pi-subagents.md) | Task Executor (executing layer). `AgentManager` with two concurrency pools, the `subagents:rpc:spawn` RPC bridge, the `Developer` / `Reviewer` built-in defaults, the agent widget + fleet list, the `SubagentScheduler`, the scripted workflow runtime, worktree isolation. |
| [`pi-codebase-memory.md`](./pi-codebase-memory.md) | Code-intelligence MCP bridge. The curated `mcp.json`, the 14 first-class MCP tools, the Sages-workspace detection, the `session_start` lifecycle hook. |
| [`pi-evaluator.md`](./pi-evaluator.md) | Opt-in reward-mode evaluator. `eval_score` / `eval_trend` tools, the 5-dimension scoring engine, the YAML / JSONL artifact readers, the coefficients config. |

## How to read these docs

1. **Start with [`root.md`](./root.md)** for the layout and the runtime
   diagram. That gives you the cross-package vocabulary ("Task Board"
   / "Task Orchestrator" / "Task Executor") used in every other file.
2. **Read `pi-tasks.md`, `pi-orchestrator.md`, `pi-subagents.md` in
   that order.** The data flow is `LLM → orchestrator → board →
   executor → result event → orchestrator`. Following the same
   order in the docs lines up with the runtime.
3. **Read `pi-codebase-memory.md` and `pi-evaluator.md` for the
   opt-in companions.** Both are off by default; both follow the same
   pattern (peer `pi-*` deps + lifecycle hooks + a curated set of
   LLM-facing tools).

## File:line references

Every symbol in every doc is verified against the source. The
format is `path:line` (relative to the repo root). When a symbol's
declaration spans multiple lines, the reference points at the line
where the keyword (`class` / `function` / `export const` /
`export interface` / `export type` / `pi.registerTool` /
`pi.on("event", ...)`) appears.

## Out of scope

- **Per-package tests.** Each `pi-*/test/` directory holds the
  per-package test suite. The docs call out the verification
  commands (`bun run typecheck` / `bun test`) but do not enumerate
  every test file.
- **External `pi` packages.** `@earendil-works/pi-coding-agent` /
  `@earendil-works/pi-ai` / `@earendil-works/pi-tui` / `typebox`
  are the host packages; they appear in `peerDependencies` but are
  not part of this repo.
- **Templates and skills** (`pi-orchestrator/templates/*.md`,
  `pi-*/skills/*/SKILL.md`). These are referenced from the package
  docs when they materially shape runtime behavior
  (e.g. `templates/SYSTEM.md` from `pi-orchestrator.md`); they are
  not transcribed in full.

## Committing changes to this directory

Per `AGENTS.md` commit conventions, doc-only edits to this directory
land as `chore(docs): learn ...`. Do not include any code change in
the same commit as a learn-doc update — keep the audit trail clean.