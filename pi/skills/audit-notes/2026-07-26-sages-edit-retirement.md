# 2026-07-26: Sages edit / sages write tools retired

**Status**: Closed. Resolved in 4 commits (f7144b2 / 633ca97 / 3b6f6c2 / 14b0dda).

## Summary

The L3 main agent's direct meta-file write tools (`sages_write`,
`sages_edit`) were retired. The main agent's LLM-facing toolset
now has **no direct write tool at all** — all file changes go
through `Agent` dispatch:

- **Meta-file edits** (AGENTS.md, README.md, install scripts, test
  files, etc.): dispatch `general-purpose` subagent, no `isolation`
  parameter, operates in dispatcher's cwd. Main agent reviews the
  diff and commits.
- **Production code** (user `src/`, `test/`, etc.): dispatch
  `developer` subagent with managed worktree
  (`isolation: { dag_id, task_id, worktree_id?, mode: "create" | "reuse" }`).
  TDD + audit + merge gate apply.

The 4 orchestrator tools (`goal_contract_create`, `dag_synthesize`,
`task_dispatch`, `orchestrator_audit`) write orchestrator state
under `.pi/orchestrator/*` only — that's the orchestrator's own
state, not a "limb exception".

The bash-guard (Layer 2, `pi/src/tools/bash-guard.ts`) is the **only
remaining limb-side write enforcement** — it gates bash write-intent
(`cat >`, `sed -i`, `tee`, etc.) via `canMainAgentWrite()` from
`pi/src/tools/file-gate.ts`.

## Prior 5 commits that bypassed the (now-enforced) contract

These commits were made when `sages_edit`/`sages_write` were still
in the main agent's toolset. They did file edits directly via
`sages_edit` instead of dispatching `general-purpose` / `developer`.
Per the new policy, future edits must go through Agent dispatch.

| Commit | Subject | What was edited directly |
|---|---|---|
| `248f7db` | `chore(pi-subagents): retire user-level developer.md (built-in handles it)` | `pi/templates/agents/developer.md` (deleted), `pi/scripts/install.{sh,ps1,bat}`, 3 test files |
| `569a9f5` | `fix(pi-file-gate): allow direct writes to Sages monorepo subpackages` | `pi/src/tools/file-gate.ts`, `pi/test/tools/file-gate.test.ts` |
| `4ce3a51` | `docs: audit-fix + simplify README/AGENTS (+ update developer.md reference)` | `AGENTS.md`, `README.md`, `pi/templates/SYSTEM.md` |
| `5f7d4c0` | `test(pi-file-gate): lock in multi-line 1:1 replace + document gotcha` | `pi/src/tools/file-gate.ts` (comment), `pi/test/tools/file-gate.test.ts` (regression tests) |
| `a2e7073` | `chore(pi-subagents): rename backup_legacy_developer_template → backup_legacy_developer` | `pi/scripts/install.{sh,ps1}`, `pi/test/install.test.sh` |

All 5 commits were substantive enough to dispatch
`general-purpose` under the new policy — none of them were
trivial typo fixes. In retrospect, dispatching would have:
- Created audit trail in the worktree
- Allowed the subagent to run `bun test` after each edit
- Made rollback easier (revert the subagent's commit)

The reason `sages_edit` was used: at the time, the user's stated
design (per AGENTS.md) was "main agent uses `sages_edit` for
meta-files, `developer` for production code". The user later
reconsidered and decided the orchestrator should be a strict
coordinator with no direct write tool.

## What changed in the source tree

- `pi/src/tools/file-gate.ts` — removed `executeSagesWrite`,
  `executeSagesEdit`, `SagesWriteParams`, `SagesEditParams`,
  `registerFileGate`. Kept `canMainAgentWrite`, `policyMessage`,
  `META_WRITE_PATTERNS`, `PRODUCTION_DENY_PATTERNS`. Updated header
  comment to reflect the new model.
- `pi/src/tools/orchestrator/index.ts` — removed re-exports of the
  removed file-gate symbols.
- `pi/src/extension.ts` — removed `registerFileGate(pi)` call and
  import. Updated header comment.
- `pi/test/tools/file-gate.test.ts` — removed `executeSagesEdit` /
  `executeSagesWrite` tests. Added 3 new `policyMessage` tests
  verifying the new copy (mentions `Agent`, `developer`,
  `general-purpose`, lists the allowlist).
- `pi/test/tools/main-agent-toolset.test.ts` — updated to expect
  the main agent's active toolset to have 4 orchestrator tools
  (no `sages_write`/`sages_edit`). New belt-and-suspenders test
  asserts none of `edit`/`write`/`sages_edit`/`sages_write` are
  registered.
- `pi/templates/SYSTEM.md`, `AGENTS.md`, `pi/templates/SUBAGENTS.md` —
  updated to describe the new model. SUBAGENTS.md gained a new
  "Sidecar: general-purpose" section.

## Why this change

- **Strict coordinator model**: The orchestrator should coordinate,
  not edit. The `sages_write`/`sages_edit` tools were a limb
  exception that weakened the brain-vs-limb boundary.
- **Audit trail**: Every change should have a commit. With
  `sages_edit`, the change is just a working-tree diff (no commit
  until the user does it). With `Agent` dispatch, the subagent
  commits (for `developer`) or the main agent commits after review
  (for `general-purpose`).
- **Subagent discipline**: `general-purpose` can use any tool
  (including TDD-style write-then-test cycles if the task warrants).
  `sages_edit` was a "dumb" tool — no validation, no test run, no
  commit, no audit.
- **Consistency**: The 5 cleanup commits above show the inconsistency
  in action — meta-file edits should be in the same review/commit
  flow as production code.

## Lessons

- The "limb exception" (`sages_edit` for meta-files) seemed
  pragmatic but created a hidden backdoor that bypassed the
  subagent dispatch contract. Future tools should be either
  read-only OR require subagent dispatch.
- The bash-guard is the right place for path policy. With no
  LLM-facing write tool, the bash-guard becomes the only
  limb-side enforcement, which is correct — bash is the only
  way to write any file from the main agent's perspective.

## References

- Commits implementing the change: `f7144b2`, `633ca97`, `3b6f6c2`, `14b0dda`
- Prior cleanup commits (bypassed the new contract):
  `248f7db`, `569a9f5`, `4ce3a51`, `5f7d4c0`, `a2e7073`
- Memory #23 (Sages subagent write prohibition) — this transition
  makes the subagent write prohibition fully consistent: the
  main agent also no longer writes directly.
- Memory #24 (bare-repo git internals rule) — unchanged, still
  applies to all agents.
