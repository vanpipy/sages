---
gc: GC-2026-pi-tasks-task-execute-spawn-fix
title: Fix pi-tasks TaskExecute spawn — maxTurns → max_turns casing mismatch
date: 2026-10-06
severity: blocker
refs: []
---

## What happened

`TaskExecute([task_id])` returned `Skipped: spawn failed — Unknown spawn
option "maxTurns"`. The spawn never reached the agent loop because the
subagent extension's TypeBox schema (SpawnOptions at `pi-subagents/src/types.ts:328`)
declares `max_turns` (snake_case) — and pi-tasks was forwarding the
camelCase variant.

This broke every pi-tasks-driven subagent execution. The orchestrator's
`workflow_run` cascade depends on TaskExecute, so all
Implement → Review → Fix → Merge cascades silently dropped on the first
spawn. `TaskExecute` itself has worked correctly since the upstream fork
(`GC-2026-pi-tasks-fork`); the bug surfaced only after
`GC-2026-path-B-field-renames` introduced the snake_case tool input
(`max_turns` at `pi-tasks/src/index.ts:1108`) without updating the
internal `cascadeConfig` struct's emit.

## Root cause

Two boundary lines in `pi-tasks/src/index.ts` used the camelCase key
that predated the snake_case tool-input rename:

| Line | Path | Wrong key |
|---:|---|---|
| 272 | `subagents:completed` cascade re-spawn | `maxTurns: cascadeConfig.maxTurns` |
| 1155 | `TaskExecute.execute` initial spawn | `maxTurns: params.max_turns` |

The internal `cascadeConfig` struct (line 96) and its setter (line 1173)
both use `maxTurns?: number` — a private camelCase field that's local
to pi-tasks. The schema on the receiving side, however, is
`SpawnOptions.max_turns` (`pi-subagents/src/types.ts:328`).

Two existing tests (`auto-cascade.test.ts:82`,
`subagent-integration.test.ts:409`) were asserting the camelCase key.
That froze the bug into the test suite: as long as those tests passed,
the spawn silently kept emitting the rejected key, and the real
downstream pi-subagents extension was never the unit under test — only
the mock that records whatever the producer wrote.

## Fix

Two boundary lines changed from `maxTurns:` to `max_turns:`. The
internal `cascadeConfig` struct keeps its camelCase key (it's a private
type with no observable cross-package surface), so the rename is
surgical — four characters across two lines, plus the test that pins
them.

| File:line | Change |
|---|---|
| `pi-tasks/src/index.ts:272` | `maxTurns: cascadeConfig.maxTurns` → `max_turns: cascadeConfig.maxTurns` |
| `pi-tasks/src/index.ts:1155` | `maxTurns: params.max_turns` → `max_turns: params.max_turns` |
| `pi-tasks/test/auto-cascade.test.ts:82` | Assertion flipped to `max_turns` (was asserting the bug) |
| `pi-tasks/test/subagent-integration.test.ts:409` | Same |
| `pi-tasks/test/task-execute-spawn-options.test.ts` (new) | Regression guard — drives both spawn paths |

## TDD

`pi-tasks/test/task-execute-spawn-options.test.ts` exercises the real
spawn path:

1. `TaskExecute({ task_ids: ["1"], max_turns: 12 })` → assert `rpc.spawned[0].options.max_turns === 12`.
2. Cascade path: complete the first task, assert `rpc.spawned[1].options.max_turns === 9`.

| Phase | Count |
|---|---|
| RED at HEAD (before fix) | **2/2 fail** (spawn emits `maxTurns`; test expects `max_turns`) |
| GREEN after fix | **2/2 pass** |
| Full `pi-tasks` suite | **476 pass / 1 skip** |
| `verify:all` (pi-orchestrator) | **7/7 green** |

The bug-locking tests at `auto-cascade.test.ts:82` and
`subagent-integration.test.ts:409` were updated to assert the corrected
key; before the fix they would have failed too, masking the regression.

## Why no monkey test caught this

Three layers of test infrastructure had gaps:

1. **Unit tests** mock `subagents:rpc:spawn` and capture whatever the
   producer sends. They didn't reject unknown keys — they just stored
   them. So a camelCase `maxTurns` happily appeared in
   `rpc.spawned[0].options.maxTurns` and the assertion was happy too.
2. **Schema validation** lives in `pi-subagents/src/types.ts:328`, but
   pi-tasks and pi-subagents are sibling packages tested in isolation.
   No integration test exercises the actual RPC round-trip.
3. **`verify:all`** has 7 gates, none of which assert schema
   conformance between pi-tasks' spawn boundary and pi-subagents'
   receiving schema.

## Follow-ups

- **Add a schema-conformance verifier** to `verify:all` that greps
  pi-tasks spawn call sites and asserts every key written to `options.*`
  is a known `SpawnOptions` field. Would have flagged `maxTurns` at
  CI-time, not at subagent-completion.
- **Stand up an integration test** that drives a real
  `pi-tasks → pi-subagents` RPC round-trip (e.g., a thin test that
  imports both packages' real handlers, not their mocks). The cascade
  path then has evidence beyond "the mock captured what we wrote".
- **Audit remaining pi-tasks fields emitted at the spawn call** for
  similar casing drift. The grep pattern is
  `spawnSubagent\(.*?,\s*\{[^}]*\}` in `pi-tasks/src/index.ts`; cross
  each key against `pi-subagents/src/types.ts` SpawnOptions.
- **Use `typebox` to derive `SpawnOptions`** at the pi-tasks spawn
  call so the type system rejects unknown keys at compile time, not at
  spawn time. The codebase already imports `typebox` (peer dep).