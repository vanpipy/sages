# GC-2026-drift-sweep-v3

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit + 1 merge)

## What happened

Third-round drift sweep after `GC-2026-precommit-fixes` and `GC-2026-evaluator-drift-sweep`. Re-ran the 5 v1 grep patterns on the most recently changed files (orchestrator extension.ts + workflow-run-tool.ts). Most 2-state / 5-phase residue was already cleaned by v1 + v2; this round caught a few that were overlooked.

## What was found (v3 results)

4 new drift sites (1 of which is LLM-facing — the rest are dev-facing comments):

1. **`pi-orchestrator/src/workflow-run-tool.ts:55`** — `GC-2026-workflow-run: run the 5-phase pipeline (Implement → Review ⇆ Fix → Merge)` — **the `workflow_run` tool description shown to the LLM when invoking it**. The LLM reads this and reasons about workflow_run as a 5-phase pipeline, which is wrong since `GC-2026-verdict-states-and-dynamic-cascade`. Fixed to `4-phase pipeline`.

2. `pi-orchestrator/src/extension.ts:55-58` — `* (one-shot 5-phase pipeline runner). ...` — top-of-file docstring. Updated to mention `4-phase` + the dynamic Fix dispatch.

3. `pi-orchestrator/src/extension.ts:184` — `// GC-2026-workflow-run: one-shot 5-phase pipeline runner.` — code comment. Updated.

4. `pi-orchestrator/scripts/install.sh:157` — `# (the orchestrator's 5-phase pipeline runner, GC-2026-workflow-run)` — install script comment. Updated.

5. **`pi-orchestrator/src/goal-contract.ts:276`** — `agentType: "Auditor"` in the Pipeline pattern example returned to the LLM. `Auditor` was renamed to `Reviewer` in `GC-2026-rename-auditor`; the type no longer exists in `default-agents.ts`. Fixed to `agentType: "Reviewer"`. **If the LLM copied the example, the spawned Review task would fail with "unknown agent type"** — this was a real integration risk, not just stale doc.

The other 4 categories came up clean:

- `dag_id` residue — only in `goal-lock.ts:73` comment and `agent-tool-description.md:95` (the alias keep-list). KEPT (back-compat documentation).
- `Auditor` residue — only in `agent-tool-description.md:10,75` and `SKILL.md:54` (historical changelog mentions explaining the rename). KEPT (intentional historical context).
- `partial: true` residue — only in `workflow-run.ts:313,318` (postmortem-style comments documenting the GC-2026-chat-stream-render fix). KEPT.
- `Never .pi/` — 1 spot in `agent-tool-description.md:95` (the rule statement). KEPT.

## Fix

4 one-line edits + 1 agentType update. All dev-facing except the workflow-run-tool.ts tool description (which is LLM-facing).

```diff
- "GC-2026-workflow-run: run the 5-phase pipeline (Implement → Review ⇆ Fix → Merge) " +
+ "GC-2026-workflow-run: run the 4-phase pipeline (Implement → Review ⇆ Fix → Merge) " +
```

```diff
- * (one-shot 5-phase pipeline runner). The workflow inside
+ * (one-shot 4-phase pipeline runner: Implement → Review ⇆ Fix → Merge; Fix is dispatched dynamically on NEEDS_WORK per GC-2026-verdict-states-and-dynamic-cascade). The workflow inside
```

```diff
- // GC-2026-workflow-run: one-shot 5-phase pipeline runner.
+ // GC-2026-workflow-run: one-shot 4-phase pipeline runner.
```

```diff
- # (the orchestrator's 5-phase pipeline runner, GC-2026-workflow-run)
+ # (the orchestrator's 4-phase pipeline runner, GC-2026-workflow-run; Fix dispatched dynamically)
```

```diff
- `TaskCreate({ subject: "Review ${contract.id}", agentType: "Auditor", blockedBy: ["implement"], description: ...
+ `TaskCreate({ subject: "Review ${contract.id}", agentType: "Reviewer", blockedBy: ["implement"], description: ...
```

## What was NOT done

- The `sages-aft-install-test-sUn3QZ/...` path (a test fixture) still has `5-phase` references but is in the .gitignore (auto-generated fixture, excluded).
- The 4 `Auditor` historical mentions in `agent-tool-description.md` and `SKILL.md` are intentional changelog context (explaining "Auditor was renamed to Reviewer per GC-X"). They live in the post-rename world to anchor readers. KEPT.
- The `pi-evaluator/src/extension.ts` `dag_id` back-compat alias (from `GC-2026-evaluator-drift-sweep`) is intentional (test fixtures pre-dating the rename use the old name). KEPT.

## Tests

`pi-orchestrator/test/extension-active-tools.test.ts`, `phase-widget-wiring.test.ts`, `workflow-run.test.ts`, `smoke/gc-2026-073.test.ts` — 58 tests, 0 fail. `bun run typecheck` green.

`bun test` shows the pre-existing baseline (5 GC-2026-precommit-fixes-fixed + 8 pi-tasks fails unchanged). No regressions.

## Verification

| # | Item | Status |
|---|---|---|
| 1 | `workflow_run` tool description: 5-phase → 4-phase | ✓ LLM-facing fix |
| 2 | `extension.ts` top docstring: 5-phase → 4-phase + dynamic Fix note | ✓ |
| 3 | `extension.ts` workflow-run comment: 5-phase → 4-phase | ✓ |
| 4 | `install.sh` workflow-run comment: 5-phase → 4-phase | ✓ |
| 5 | `goal-contract.ts:276` Pipeline pattern example: `Auditor` → `Reviewer` | ✓ LLM-facing fix |
| 6 | 58 tests on affected files pass | ✓ |
| 7 | No regressions | ✓ |

## Effect on the user

- LLM invoking `workflow_run` now sees the correct 4-phase description (was 5-phase — incorrect post-`GC-2026-verdict-states-and-dynamic-cascade`).
- LLM copying the Pipeline pattern example from `goal-contract.ts` next_step no longer gets `Auditor` (which would fail with "unknown agent type"). Now correctly uses `Reviewer`.
- 4 dev-facing comments now consistent with the 4-phase runtime.

## Lessons learned

- **Tool descriptions are LLM-facing surface** — they should be in the drift-sweep scope. The `workflow_run` tool description was the LLM's primary mental model of the pipeline; the 5-phase claim was actively wrong since `GC-2026-verdict-states-and-dynamic-cascade` (Fix dynamic). The fix here is small but high-impact.
- **Pipeline example snippets are LLM-facing surface too.** `goal-contract.ts:276` returns a Pipeline pattern example string. If the LLM copies the example verbatim, it would have hit "unknown agent type 'Auditor'" at runtime. The drift sweep caught this.
- **History mentions vs active use are different categories.** `Auditor` appears in `SKILL.md:54` (changelog list explaining the rename) and in `agent-tool-description.md:10,75` (historical AgentConfig descriptions). These are intentional historical context. The `goal-contract.ts:276` mention was active — an example the LLM would copy. The grep can't distinguish; human judgment at the GC level is needed.

Refs: GC-2026-drift-sweep-v3
