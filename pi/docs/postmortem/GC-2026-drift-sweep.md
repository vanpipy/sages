# GC-2026-drift-sweep

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit + 1 merge)

## What happened

`GC-2026-prompt-4-state-accuracy` closed the named P1/P2 findings in the prompt-consistency audit, but its scope was the specific files + lines the audit called out. A drift-sweep grep across all three packages (pi-tasks, pi-subagents, pi-orchestrator) plus docs surfaces 8 additional stale references that the targeted audit missed:

- `AGENTS.md:23` — `isolation: { dag_id, task_id, mode: "create" }` (stale field name; should be `goal_id` per `GC-2026-path-B-field-renames`)
- `pi-orchestrator/skills/orchestrator/SKILL.md:40,51,60,116,144` — 5 stale references in the orchestrator's primary workflow reference: 2-state verdict (lines 40, 51), "5-phase pipeline" (lines 60, 116), `dag_id` field (line 144)
- `pi-subagents/src/prompts.ts:65` — "Append mode is now only used for the `developer` and `auditor` built-ins" (stale; `auditor` → `Reviewer` per `GC-2026-rename-auditor`)
- `pi-subagents/src/agent-prompts/_workspace-protocol.ts:95` — "The `auditor` continues to verify **per-task** commits" (stale agent name; this is the canonical byte-identical WORKSPACE_PROTOCOL_SECTION source consumed by developer.ts + merger.ts)

## Root cause

Per-GC scope is too narrow to catch cross-package drift. Each GC's "fix the runtime" is paired with "fix the doc that describes the runtime", but only at the specific lines the GC author touches. Anywhere a stale reference exists in a file the GC didn't open, the drift persists until the next person grep's for it.

The second-audit's "auditor audit" (which meta-reviewed the first audit's findings) flagged this as a class of bug: **drift is recurring**, and the only scalable defense is periodic sweep greps.

## Fix

8 stale references updated across 4 files. Decisions on what to keep:

- **`auditor` in `pi-orchestrator/catalogs/namespace.json:23` + `pi-orchestrator/src/namespace-ownership.ts:1`** — KEPT. The "auditor" string here is the **namespace role** that writes `.pi/orchestrator/audit-{id}-{task_id}.md` files. The Merger (DAG-synthesis) writes these. The role is intentionally separate from the agent type name (renamed to "Reviewer" in `GC-2026-rename-auditor`). Updating this would break the namespace ownership contract.
- **`dag_id` in `pi-subagents/src/invocation-config.ts:183` + `pi-subagents/src/worktree-contract.ts:7` + `pi-subagents/src/agent-manager.ts:152`** — KEPT. These are documenting the **back-compat alias** for the renamed `goal_id` field. The `isolation` interface accepts both `goal_id` (preferred) and `dag_id` (deprecated) per `GC-2026-path-B-field-renames` compat shim. Removing the alias would break legacy call sites.
- **`dag_id` in `pi-subagents/src/agent-prompts/merger.ts:23` + `merger-advisor.ts:55` + `merger.ts:92` (DAG identity for the audit file name)** — KEPT. The Merger (DAG-synthesis) still uses `dag_id` for the audit file naming. Different concept from workflow_run's `goal_id`.
- **postmortems + gc-index historical references** — KEPT. These are frozen historical artifacts.
- **GC-2026-prompt-4-state-accuracy itself + the "test 4-state" cases in test files** — KEPT. The substring `CLEAN | NEEDS_WORK` is part of the 4-state enumeration string `CLEAN | NEEDS_WORK | NEEDS_REDESIGN | NEEDS_CLARIFICATION`, not a 2-state claim.

What I changed:

| File | Line | Old | New |
|---|---|---|---|
| `AGENTS.md` | 23 | `isolation: { dag_id, task_id, mode: "create" }` | `isolation: { goal_id, task_id, mode: "create" }` |
| `pi-orchestrator/skills/orchestrator/SKILL.md` | 40 | `Reviewer verdict (CLEAN / NEEDS_WORK) drives Fix loop` | `Reviewer verdict (4-state set: CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION) drives the Fix / Redesign / Clarification branches` |
| `pi-orchestrator/skills/orchestrator/SKILL.md` | 51 | `emits \`verdict: CLEAN | NEEDS_WORK\`` | `emits \`verdict: CLEAN | NEEDS_WORK | NEEDS_REDESIGN | NEEDS_CLARIFICATION\`` |
| `pi-orchestrator/skills/orchestrator/SKILL.md` | 60 | `5-phase pipeline` | `4-phase pipeline (Implement → Review ⇆ Fix → Merge)` |
| `pi-orchestrator/skills/orchestrator/SKILL.md` | 116 | `doesn't fit the 5-phase pipeline` | `doesn't fit the 4-phase pipeline` |
| `pi-orchestrator/skills/orchestrator/SKILL.md` | 144 | `\`{ dag_id, task_id, mode: "create" }\` (managed worktree)` | `\`{ goal_id, task_id, mode: "create" }\` (managed worktree)` |
| `pi-subagents/src/prompts.ts` | 65 | `the \`developer\` and \`auditor\` built-ins` | `the \`developer\` and \`Reviewer\` built-ins` |
| `pi-subagents/src/agent-prompts/_workspace-protocol.ts` | 95 | `The \`auditor\` continues to verify **per-task** commits; the \`merger\` verifies` | `The \`Reviewer\` continues to verify **per-task** commits; the \`Merger\` verifies` |

Note on `_workspace-protocol.ts`: this is the **canonical source** for `WORKSPACE_PROTOCOL_SECTION`, consumed by `developer.ts:194` and `merger.ts:131` via template-literal interpolation. The byte-identity pin (`workspace-protocol-drift.test.ts`) is preserved automatically because both consumers import from this file.

## Verification

After the fix, re-ran the grep patterns — all 8 target instances gone, all 5 keep-list items still present. `bun run typecheck` green on all 3 packages. `bun test`:
- `pi-subagents`: 8 errors pre-existing (TaskStore list ID resolution + projectKey + sessionTaskFile, unchanged from main baseline)
- `pi-orchestrator`: 5 fail pre-existing (4 SMOKE-073 + 1 verify:catalog subprocess, unchanged from main baseline)
- `pi-tasks`: 8 errors pre-existing (unchanged from main baseline)

No regressions introduced.

## Effect on the user

After this GC, the prompt/docs surface is fully consistent with the 4-state verdict runtime. Searching for `dag_id` or `5-phase` in current docs returns only the historical / back-compat / namespace-role references that were intentionally kept. The drift class is now: closed (for these 4 specific terms), with the sweep method documented in this postmortem as a reusable tool for future drift.

## Lessons learned

- **Per-GC scope is too narrow for cross-package drift.** `GC-2026-prompt-4-state-accuracy` fixed 10 named findings, then this drift sweep found 8 more in the same conceptual class. The 8 missed instances lived in files the audit didn't open (AGENTS.md, SKILL.md, prompts.ts, _workspace-protocol.ts). Sweep-based GCs close the gap.
- **Same prompt word, two meanings.** "auditor" in `prompts.ts` and `_workspace-protocol.ts` is the agent type name (should be `Reviewer`); "auditor" in `namespace-ownership.ts` is the namespace role (should stay). When sweeping, distinguish these by context — the audit pattern is "if it refers to an AgentConfig or agent type, update; if it's a logical role, keep with a comment explaining the separation".
- **Byte-identical pinned sections are easier to update than expected.** The `WORKSPACE_PROTOCOL_SECTION` is consumed by 2 prompts via import, so a single edit in `_workspace-protocol.ts` propagates. The "byte-identity" invariant in `workspace-protocol-drift.test.ts` is about the runtime value of the exported constant, not about the source file — so editing the source automatically propagates to all consumers without re-asserting byte-identity.
- **The grep that found this batch is reusable.** A future "drift sweep" can copy the 4 grep patterns (verbatim verdict schema, `5-phase`, `Auditor`, `dag_id`) and re-run. If new results appear, they're new drift introduced since this GC.

Refs: GC-2026-drift-sweep
