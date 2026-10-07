---
gc: GC-2026-main-agent-tool-surface
title: Expose pi-orchestrator's goal_contract_create + workflow_run to main agent's LLM-facing tool surface
date: 2026-10-06
severity: major
refs: []
---

## What happened

`goal_contract_create` and `workflow_run` are documented in `pi-orchestrator/templates/SYSTEM.md` as part of the Sages orchestrator's 36-tool budget. They are registered by `pi-orchestrator/src/extension.ts:179-187`, listed in `ORCHESTRATOR_TOOLS` (line 60-62), and included in `installSessionHooks` setActiveTools (line 203). Yet in the live runtime, the main session's LLM-facing tool list never included either tool — only pi-tasks's `Task*` tools, pi-subagents's `Agent`/`subagent_*`, baseline FS tools, AFT, and MCP.

The Sages orchestrator session `01a11162-2dfc-7080-9a3a-705705206fa7cd0.jsonl` (2026-10-06T13:23) surfaced the gap: `TaskExecute` failed with `Skipped: spawn failed — Unknown spawn option 'maxTurns'`, and the fallback path required manually wiring `TaskCreate` × 4 + `Agent` dispatches instead of using the canonical `workflow_run` driver.

## Root cause

**Operational cause**: `~/.pi/packages/pi-orchestrator/` was deleted from disk; `~/.pi/agent/settings.json#packages` held a stale registration pointing at the now-missing dir.

**Why the deletion passed silently**:
1. `pi-coding-agent`'s extension loader (`loader.js:541-555` in `pi-subagents/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`) processes `configuredPaths` and calls `addPaths([resolved])` regardless of whether the path exists. The `loadExtension` step then catches the jiti ENOENT, returns `{ extension: null, error }`, and the caller pushes to an `errors` array with no logging — so neither the user nor the LLM sees a warning.
2. `pi-orchestrator/scripts/install.sh` lacked an `is_pi_orchestrator_installed()` helper. Without the auto-recovery invariant "settings registered AND dir exists", the install script's "already installed" early-return at `install()` would pass on a stale registration alone, never re-copying the missing dir.

**Why the other four peers were not affected**: `is_pi_codebase_memory_installed` (line 237), `is_pi_subagents_installed` (line ~1127), `is_pi_evaluator_installed` (line ~1282), and `is_pi_tasks_installed` (line ~1411) all paired settings-registration with `os.path.isdir(pkg)`. `pi-orchestrator` was the only peer without this guard.

## Fix

`GC-2026-main-agent-tool-surface` ships three coordinated edits to `pi-orchestrator/scripts/install.sh`:

1. **`PI_ORCHESTRATOR_PKG` constant** (line ~159) — parity with the other four peers.
2. **`is_pi_orchestrator_installed()` helper** (line ~964) — mirrors `is_pi_subagents_installed` etc. Auto-recovery invariant: `settings.json#packages` lists the path AND `os.path.isdir(pkg)` is true. Without both, the next install re-copies files.
3. **`verify_package_existence()` gate** (line ~927) — added at end of `install()`. Iterates `settings.json#packages`, skips `npm:` peers (npm owns their existence), and exits non-zero if any local-path peer is missing on disk. Failure message lists the missing paths and points at `bash $0 --force` for recovery.

Plus immediate operational recovery: `bash /home/leroy/Project/sages/pi-orchestrator/scripts/install.sh` re-copied the missing peer.

Test coverage: `pi-orchestrator/test/scripts/install-package-existence.test.ts` (14 tests, all pass) pins the constants / functions / wiring + behavioral cases for both helpers (registered-but-missing, npm-skip, happy-path, missing-tab).

## Out of scope (deliberate)

- **Editing `loader.js` in `node_modules`**: not committable, gets overwritten on `bun install`. The fix lives upstream in `pi-coding-agent` (the orchestrator-side install.sh changes are the practical mitigation).
- **Generalizing the `is_*_installed` helpers into a shared abstraction**: would have expanded scope beyond the immediate operational fix. The four existing helpers are mechanical copies of each other and refactoring them risks breaking unrelated invariants.
- **Renaming `is_pi_codebase_memory_installed` to the parity name**: out of scope; the bug only manifested for pi-orchestrator.

## Follow-ups

- **GC-2026-loader-fail-soft-warn**: ship a patch upstream to `pi-coding-agent`'s `loader.js` so missing configured paths emit a `console.warn` or surface the errors array at session start. Without this, the bug class remains in observation — `install.sh` self-heals on the next install but in-flight sessions continue with stale tool lists.
- **GC-2026-install-helper-generalization**: replace the 4 mechanical copies of `is_*_installed` with one shared `is_peer_registered(pkg)` helper. Same observability win as `verify_package_existence` but at the install-step granularity.
- **Add to `verify:all`**: a `verify-orchestrator-installation` gate that boots `pi-coding-agent`'s loader with the Sages packages and asserts the orchestrator tools are in the resulting `getActiveTools()` output. CI-level smoke test for the whole class.