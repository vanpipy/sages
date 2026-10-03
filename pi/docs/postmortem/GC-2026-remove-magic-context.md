---
id: GC-2026-remove-magic-context
title: Remove all magic-context dependencies and references from the Sages monorepo
severity: major
date: 2026-09-30
audit_verdict: PASS
post_hoc: true
---

# GC-2026-remove-magic-context — Postmortem (post-hoc reconstruction)

## What happened

Sages migrated from the magic-context extension (todowrite + ctx_*)
to pi-tasks as the workflow primitive. With GC-2026-pi-tasks-fork
merged, pi-tasks was in place. Continuing to ship magic-context
introduced surface area (its tools, install logic, configuration)
that was no longer needed.

## Root cause

Sages pre-path-B had two parallel workflow primitives:
`magic-context` (todowrite + ctx_*) for the main agent and `pi-tasks`
for subagents. Both surfaces shipped to the user, requiring both to
be installed and configured. After path-B-swap removed the orchestrator's
DAG infrastructure, magic-context's `todowrite_compile` /
`todowrite_progress` / `ctx_search` / `ctx_memory` / etc. tools had
no callers — they only existed for the DAG era.

## Fix

Three commits:

- `cd62120 refactor(orchestrator): drop magic-context extension`
  — removed `src/todowrite.ts`, `src/todo-sync.ts`,
  `templates/magic-context.jsonc`, `templates/prompts/with-magic-context.md`,
  plus the corresponding tests. `TODOWRITE_TOOLS` / `CTX_TOOLS` /
  `registerTodowriteTools` deleted from `extension.ts`.

- `d077782 refactor(subagents): drop pi-magic-context from subagent
  extensions` — removed magic-context references from subagent
  prompts.

- `62afe25 docs: drop magic-context references from project docs` —
  cleaned `.pi/orchestrator/designs/*.md` and `AGENTS.md`.

`install.sh` retained a `uninstall_legacy_magic_context` helper for
backward-cleanup of existing installations but stopped installing
magic-context on fresh installs.

## Verification

10 SCs from the goal contract all green. Zero remaining
magic-context references in `pi-orchestrator/src/` and
`pi-subagents/src/` outside historical design docs. The
orchestrator's active toolset no longer includes
`todowrite`, `todowrite_compile`, `todowrite_progress`, `ctx_search`,
`ctx_memory`, `ctx_note`, `ctx_reduce`, `ctx_expand`.

Refs: `GC-2026-remove-magic-context`