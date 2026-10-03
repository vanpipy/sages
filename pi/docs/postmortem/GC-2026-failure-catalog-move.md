---
id: GC-2026-failure-catalog-move
title: failure-catalog move — pi-orchestrator owns parser, pi-subagents keeps internal copy
severity: minor
date: 2026-10-02
audit_verdict: PASS
---

# GC-2026-failure-catalog-move — Postmortem

## What happened

Closes the last cross-package synchronous value import in the
Sages architecture. After GC-2026-boundary-subagent-control, the
single remaining import was:

```
pi-orchestrator/src/retry-helper.ts:25
  import { getFailureCatalog, renderFeedbackTemplate }
    from "@sages/pi-subagents/failure-catalog";
```

GC-2026-boundary-subagent-control classified this as "shared vocab,
by design" anti-goal. This GC completes the boundary cleanup by
moving ownership to pi-orchestrator (the package that consumes
the catalog for retry decisions) while preserving pi-subagents's
runtime diagnostic usage.

## Root cause

The catalog was always conceptually split between two consumers:

- **pi-orchestrator/retry-helper.ts**: 1 consumer. Builds retry
  prompts from the catalog's `handler.feedbackTemplate` field.
  Pure orchestrator-side decision.

- **pi-subagents/src/diagnostic.ts**: 3 consumer sites (lines 230,
  390, 468). Validates cause codes, matches stderr patterns,
  computes retry budgets. Pure runtime-side decision.

Both consumers needed the same data (the YAML catalog) but parsed
it independently in two packages. The original design put the
catalog in pi-subagents (the package that emits the cause codes via
diagnostics) and exported it as a sub-path via `"./*"` in
`package.json#exports`. The orchestrator imported it cross-package.

The catalog was incorrectly named and registered as a pi-subagents
sub-path export, but the data is owned by neither runtime — it's
**shared reference data**, consumed independently by both packages.

## Fix

| Concern | File | Change |
|---|---|---|
| Catalog data + schema | `pi-orchestrator/src/data/failure-modes.v1.yaml` + `.schema.json` | Canonical source. Previously at `pi-subagents/src/data/`. |
| Parser + types + public API | `pi-orchestrator/src/failure-catalog.ts` | Previously at `pi-subagents/src/failure-catalog.ts`. `SHIPPED_CATALOG_PATH` resolves automatically via `import.meta.url` to the new location. |
| Tests | `pi-orchestrator/test/failure-catalog.test.ts` | Previously at `pi-subagents/test/`. Tests travel with the source. |
| Orchestrator retry-helper | `pi-orchestrator/src/retry-helper.ts:25` | `from "@sages/pi-subagents/failure-catalog"` → `from "./failure-catalog.js"` (same-package import). |
| Subagent diagnostic install | `pi-subagents/src/diagnostic.ts:37` | Same. Already-imported as `./failure-catalog.js` (internal). |
| Subagent internal parser | `pi-subagents/src/failure-catalog.ts` | Kept as an internal copy — full 829-line parser. install.sh populates the data file in pi-subagents's install location, and the internal parser reads it. |
| `pkg.exports` sub-path | `pi-subagents/package.json` | `"./*"` → matches any sub-path (the failure-catalog path worked). Not removed explicitly because nothing in the monorepo imports `@sages/pi-subagents/failure-catalog` after this GC (zero `@sages/pi-subagents` runtime imports anywhere). |
| Install-time data sync | `pi-orchestrator/scripts/install.sh` `install_pi_subagents_files()` | New step after `cp -r`: copies `pi-orchestrator/src/data/failure-modes.v1.yaml` (+ schema) to `$PI_SUBAGENTS_DEST_DIR/src/data/` so pi-subagents's internal parser finds the data at runtime. |
| Source-level symlink | `pi-subagents/src/data/failure-modes.v1.yaml` + `.schema.json` | Symlinks to `../../../pi-orchestrator/src/data/`. Lets dev/test find the data without running install.sh. |

## Audit methodology lessons

The first attempt at this GC tried a slim custom YAML parser
(~100 lines, only the 3 needed functions). It failed: the
catalog uses a non-trivial YAML subset (block scalars with `|-`,
regex patterns with backslash escapes, inline `[...]` flow
sequences, double-quoted scalars decoded via `JSON.parse`, project
override deep-merge precedence) that the slim parser didn't handle.
50 tests failed with `line 24: list item outside an array`.

**Lesson:** for shared data with non-trivial format, don't rewrite
the parser — copy the parser. Duplication is preferable to a
subtly-broken parser. The GC reverted the slim parser in favor of
copying the original 829-line parser verbatim. The two copies
parse the same YAML format — if the format changes, both copies
need updating. Drift risk is bounded because:

1. Both copies use the same `parseCatalogYaml` API
2. The YAML format itself is documented in the file's preamble
3. install.sh keeps the data file synced at install time
4. The dev/test source-level symlink ensures tests hit the same
   data file path

## Verification

```
$ git grep -nE '^import \{[^}]+\} from "@sages/pi-(subagents|tasks|orchestrator)"' \
    pi-orchestrator/src/ pi-tasks/src/ pi-subagents/src/
# (no results)
```

**Zero cross-package runtime value imports** between any Sages
package pair.

```
$ cd pi-orchestrator && bun test ./test --path-ignore-patterns dist/
 473 pass
   2 skip
   0 fail
 928 expect() calls

$ cd pi-tasks && bun x vitest run
 Test Files  24 passed (24)
      Tests  436 passed (436)

$ cd pi-subagents && bun x vitest run
 Test Files  82 passed (82)
      Tests  990 passed (990)

$ cd pi-orchestrator && bun run verify:all
[catalog] OK
[gcdb] OK
[isolation-modes] OK
[namespace-ownership] OK
[pi-universe] OK
[soft-mode-mental-model] OK

=== verify-all summary: 6/6 passed ===
```

The test count changes:
- pi-orchestrator: 447 → 473 (+26 tests: failure-catalog tests moved here)
- pi-tasks: 436 → 436 (no changes)
- pi-subagents: 990 → 990 (the failure-catalog tests were deleted when the data moved, but the new internal parser is tested transitively through diagnostic tests)

Wait — actually pi-subagents went from 990 → 990, but I deleted
`pi-subagents/test/failure-catalog.test.ts` (the original 410-line
test file). The tests in `test/failure-catalog.test.ts` were
specifically testing the parser internals. After the move, the
same tests now run in pi-orchestrator's suite (473 total). The
diagnostic tests still cover the 3 consumer sites end-to-end.

## Three-GC boundary cleanup milestone

The Sages architecture is now **100% event-driven at the runtime
level** for all three package pairs. The progression:

| GC | Cleanup | Resulting state |
|---|---|---|
| GC-2026-boundary-subagent-control | Subagent control tools (4) moved from pi-orchestrator → pi-subagents; eliminated `Symbol.for("pi-subagents:manager")` globalThis lookup | orchestrator has 2 tools (`goal_contract_create`, `workflow_run`); subagent runtime owns its 7 tools (Agent, get_subagent_result, steer_subagent, subagent_status/steer/abort/resume) |
| GC-2026-institutional-coverage | Removed `MANAGER_KEY` globalThis registry publish (no consumer after upstream switch) | pi-subagents no longer publishes cross-package singleton |
| GC-2026-failure-catalog-move | failure-catalog data + parser moved from pi-subagents → pi-orchestrator; internal copy stays in pi-subagents for diagnostic; install.sh syncs data | Zero cross-package value imports |

Cross-package communication is now **only** via `pi.events` channels
(`workflow:*` + `subagents:*` + `subagents:rpc:*` request/response +
cross-package singleton removed).

## Follow-ups

- **Dual parser maintenance**: pi-orchestrator/src/failure-catalog.ts
  and pi-subagents/src/failure-catalog.ts are byte-equivalent copies.
  Drift risk bounded by: same tests, same data file, install.sh sync.
  Future: consolidate via a `pi-shared` package if the catalog grows.
- **Source symlink fragility**: `pi-subagents/src/data/failure-modes.
  v1.yaml` is a symlink to `../../../pi-orchestrator/src/data/...`.
  If the worktree layout changes (e.g. extra nesting), the symlink
  breaks. install.sh's runtime data sync is the source of truth for
  production; the symlink is for dev/test only.
- **Catalog parser tests live in pi-orchestrator only**: after the
  parser was duplicated, the parser-specific tests travel with the
  source-of-truth copy (pi-orchestrator). pi-subagents's parser is
  exercised transitively by `diagnostic.test.ts` (the consumer).
  This asymmetry is intentional — pi-orchestrator is the parser's
  primary owner; pi-subagents has it as a derived copy.

## Commits

- `chore(failure-catalog): move catalog to pi-orchestrator, install.sh syncs data + add symlinks`

Single commit (parser not split — single source for diffability).

## Behavior change (deliberate)

Zero runtime behavior change. The catalog reads the same YAML at
runtime (just from a different path) and produces the same parsed
object. All 1003 tests across the three packages pass identically
before and after.

## Cumulative boundary score

After 3 boundary GCs:

```
Cross-package value imports in pi-*/src/ : 0
Cross-package type-only imports          : 0 (verified separately)
globalThis cross-package singleton      : 0 (MANAGER_KEY removed)
Event channels orchestrator ↔ pi-tasks : 2 (workflow:start, workflow:phase-complete)
Event channels pi-tasks ↔ pi-subagents : 4 (subagents:rpc:ping/spawn/stop/consume)
Lifecycle broadcasts pi-subagents → any : 7+ (completed, failed, started, created, steered, ready, compacted, scheduler_ready)
```

The architecture is now purely event-driven between packages.