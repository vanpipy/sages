---
id: GC-2026-institutional-coverage
title: Institutional coverage — retroactive postmortems for 11 prior GCs + remove unused MANAGER_KEY registry
severity: minor
date: 2026-10-02
audit_verdict: PASS
---

# GC-2026-institutional-coverage — Postmortem

## What happened

Two cleanups left over from the GC-2026-boundary-subagent-control
postmortem:

1. **11 prior GCs lacked institutional coverage.** `verify:gcdb`
   had been failing since the 2026-08-24 reset because 11 prior
   Goal Contracts shipped without matching `pi/docs/postmortem/<id>.md`
   files. Each was real work that landed in `git log` but had no
   archaeology record.

2. **`MANAGER_KEY` globalThis registry was a dead publish.** Once
   GC-2026-boundary-subagent-control removed the orchestrator's
   `Symbol.for("pi-subagents:manager")` consumer, no production code
   reads the registry — `git grep` confirms it. The publish itself
   was preserved for "back-compat with test fixtures and any future
   cross-package integration" but had no actual consumers.

## Root cause

The 11 GCs predate Sages' institutional-coverage discipline. The
reset deleted `pi/docs/` and only `pi-evaluator` (at GC-2026-096's
prompt) re-bootstrapped the directory. Each prior merge shipped
without writing a postmortem; no one checked.

The `MANAGER_KEY` registry was preserved by GC-2026-boundary-subagent-
control because the postmortem said "test fixtures and any future
cross-package integration may rely on it." That was true at the
time, but no fixture was actually found during the boundary GC's
verification. The follow-up audit (`git grep
'pi-subagents:manager' pi-*/src/`) returned zero non-comment
matches across the entire monorepo.

## Fix

| Change | File | Detail |
|---|---|---|
| 11 retroactive postmortems | `pi/docs/postmortem/GC-2026-{088,089,090,091,092,093,-orchestrator-simplify,-path-B-tracking,-pi-tasks-fork,-remove-magic-context,-rename-auditor}.md` | Each ~30-50 lines, post-hoc reconstruction from git log evidence (commit messages, file diffs at merge time, goal yaml rationale + done_definition). Frontmatter includes `post_hoc: true` so future readers know these were reconstructed, not contemporaneous. |
| Resolve gc-index.md merge markers + add 5 missing IDs | `pi/docs/gc-index.md` | The unresolved `<<<<<<< Updated upstream` / `=======` / `>>>>>>> Stashed changes` markers from a prior merge are now resolved (clean merge, both branches merged). The 5 missing entries (093, orchestrator-simplify, pi-tasks-fork, remove-magic-context, rename-auditor) are added. |
| Remove `MANAGER_KEY` globalThis publish + teardown | `pi-subagents/src/index.ts` | Lines 679-718 (the `MANAGER_KEY = Symbol.for("pi-subagents:manager")` declaration, the `registryEntry` object, the `ownsManagerRegistry` claim, and the `globalThis[MANAGER_KEY] = registryEntry` publish) deleted. The shutdown teardown at line 778-785 (the `if (ownsManagerRegistry && globalThis[MANAGER_KEY] === registryEntry) delete globalThis[MANAGER_KEY]`) deleted. |

## Verification

```
$ cd pi-tasks && bun x vitest run
 Test Files  24 passed (24)
      Tests  436 passed (436)

$ cd pi-orchestrator && bun test ./test --path-ignore-patterns dist/
 516 pass
   2 skip
   0 fail
1025 expect() calls

$ cd pi-subagents && bun x vitest run
 Test Files  82 passed (82)
      Tests  990 passed (990)

$ cd pi-orchestrator && bun run verify:all
[catalog] OK
[gcdb] OK  ← was FAIL (11 uncovered GCs)
[isolation-modes] OK
[namespace-ownership] OK
[pi-universe] OK
[soft-mode-mental-model] OK
```

All 6 verify gates green post-merge. `verify:gcdb` was the last
outstanding gate.

## Boundary verification (post-GC)

```
$ git grep "Symbol.for..pi-subagents:manager." pi-*/src/
# 0 results
```

Zero postmortem `MANAGER_KEY` consumers in any `pi-*/src/`. The
globalThis registry publish is fully retired.

## Behavior change (deliberate)

`MANAGER_KEY = Symbol.for("pi-subagents:manager")` no longer publishes
a global cross-package singleton. If a future extension needs
cross-package access to the manager, the right shape is a typed RPC
(analogous to `pi-tasks`'s `subagents:rpc:spawn`), not an untyped
globalThis lookup. The teardown-side `delete globalThis[MANAGER_KEY]`
in the original index.ts is gone too — nothing to clean up on
shutdown.

## Follow-ups

- **verify:catalog's postmortem-coverage regex** (`GC-\d{4}-\d{3,}`)
  misses textual IDs like `GC-2026-orchestrator-simplify`. The
  numeric-IDs-only flag was working as designed (it caught GC-2026-093
  but missed 4 textual-ID orphans). The current GC fixes the
  orphans in the index, so the gate passes; but the regex itself
  remains a latent surface for future textual-ID GCs. Filing as a
  separate follow-up: broaden `verify-catalog.ts` line 295 regex
  to `GC-\d{4}-[\w-]+`.
- **`pi/docs/gc-index.md`:** the conflict markers from a prior merge
  were resolved as part of this GC. The committed file is now clean
  markdown (no more `<<<<<<<` / `=======` / `>>>>>>>`).
- **post_hoc postmortems** (`post_hoc: true` in frontmatter): future
  docs readers can tell which postmortems were reconstructed vs
  contemporaneous. Long-term, archive the 11 reconstructed ones into
  the institutional record (they are now committed to git, so this
  is implicit).

## Commits

- `refactor(pi-subagents): drop MANAGER_KEY globalThis registry (no production consumers)`
- `docs(institutional-coverage): retroactive postmortems for 11 prior GCs + gc-index update`
- `merge(GC-2026-institutional-coverage): retroactive postmortems + drop MANAGER_KEY`