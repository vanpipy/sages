---
id: GC-2026-boundary-subagent-control
title: Boundary cleanup — subagent control tools move from pi-orchestrator to pi-subagents
severity: minor
date: 2026-10-02
audit_verdict: PASS
---

# GC-2026-boundary-subagent-control — Postmortem

## What happened

The three-layer Sages architecture (pi-orchestrator → pi-tasks → pi-subagents)
had drifted in two places after GC-2026-073 added the 4 subagent lifecycle
control tools (`subagent_status` / `subagent_steer` / `subagent_abort` /
`subagent_resume`):

1. The control tools lived in `pi-orchestrator/src/subagent-control.ts`,
   but they are runtime controls over the `AgentManager` singleton. The
   orchestrator reached across the package boundary twice to access them:
   - `Symbol.for("pi-subagents:manager")` globalThis lookup to grab the
     manager.
   - `import type { AgentRecord } from "@sages/pi-subagents/types"` — a
     type-only cross-package import (harmless at runtime, but planning
     shouldn't need to know runtime shapes).

2. `pi-tasks/src/phase-prompts.ts` (the four `implementPrompt` /
   `reviewPrompt` / `fixPrompt` / `mergePrompt` builders) was dead code.
   Only `pi-tasks/test/phase-prompts.test.ts` imported it; the actual
   workflow uses inline builders in `pi-tasks/src/workflow-graph.ts` (the
   path-B-swap canonical implementation superseded the first attempt).

This GC cleans both. Subagent control tools now live in
`pi-subagents/src/subagent-control-tools.ts`, registered by the runtime
that owns the manager (via direct `registerSubagentControlTools(pi, manager)`
call — no globalThis lookup, no cross-package type import). The dead
phase-prompts.ts and its test are deleted.

## Root cause

GC-2026-073 (the original commit that added the 4 control tools) followed
the path of least resistance: pi-orchestrator already had
`Symbol.for("pi-subagents:manager")` consumers (via shared globalThis
registry pattern from the AgentManager itself), and the cross-package type
import was harmless. The orchestrator-side placement made sense at the
time because the tools were originally designed to be called by the
orchestrator's planning loop.

But the tools don't touch planning state. They inspect, query, or
terminate subagents — pure runtime lifecycle operations. The runtime
that owns the manager should own the tools that operate on it.

The phase-prompts dead code came from path-B-swap. The path-B-tracking
GC created `phase-prompts.ts` as the prompt builder for the new path-B
workflow; path-B-swap landed `workflow-graph.ts` instead as the canonical
implementation. The earlier file was left in place and its test kept
green-locking the dead module.

## Fix

| Concern | File | Change |
|---|---|---|
| Subagent control tools | `pi-subagents/src/subagent-control-tools.ts` (NEW) | Copied from `pi-orchestrator/src/subagent-control.ts` minus the globalThis singleton lookup. The 4 executor functions and 4 TypeBox schemas move here. `registerSubagentControlTools(pi, manager)` takes the manager instance as a parameter (no Symbol.for lookup). |
| Wiring | `pi-subagents/src/index.ts` | Calls `registerSubagentControlTools(pi, manager)` after the manager is initialized in the extension default function. Re-exports `registerSubagentControlTools` from `./subagent-control-tools.js` for downstream consumers. Updated the registry comment at line 695 to clarify the orchestrator no longer depends on the globalThis registry. |
| Orchestrator cleanup | `pi-orchestrator/src/extension.ts` | Removed `import { registerSubagentControlTools } from "./subagent-control.js"` and the `registerSubagentControlTools(pi)` call from `registerOrchestratorTools`. Kept `SUBAGENT_CONTROL_TOOLS` constant (still used by `setActiveTools` for LLM visibility gating). Updated header docstring + comment block to reflect the boundary ownership. |
| Orchestrator cleanup | `pi-orchestrator/src/index.ts` | Removed `export { registerSubagentControlTools } from "./subagent-control.js"`. Added a comment explaining where to import from now. |
| Source move | `pi-orchestrator/src/subagent-control.ts` | DELETED. |
| Stale test | `pi-orchestrator/test/tools/orchestrator/subagent-control.test.ts` | DELETED (tested the old orchestrator-owned implementation; the new test lives in pi-subagents/test/subagent-control-tools.test.ts). |
| Smoke update | `pi-orchestrator/test/smoke/gc-2026-073.test.ts` | SMOKE-073-1 updated to expect 2 tools from orchestrator's default export (down from 6). Comment updated to reflect the boundary ownership. |
| Dead code | `pi-tasks/src/phase-prompts.ts` | DELETED. |
| Dead code | `pi-tasks/test/phase-prompts.test.ts` | DELETED. |

## Deliberately out of scope (with rationale)

- **`pi-orchestrator/src/retry-helper.ts` imports `getFailureCatalog` /
  `renderFeedbackTemplate` from `@sages/pi-subagents/failure-catalog`.**
  The catalog is reference shape (failure cause codes + handler
  strategies) shared between planning and runtime. It is not a runtime
  state. Moving it would require either (a) duplicating the catalog in
  pi-orchestrator (shared vocab drift risk) or (b) an RPC channel for
  static data (overhead outweighs benefit). The existing import is type-
  clean and the file already documents the design choice.

- **`MANAGER_KEY` globalThis registry in `pi-subagents/src/index.ts`.**
  Other consumers (test fixtures, possibly future cross-package
  integration) may rely on it. Removing it is a separate cleanup
  outside this GC's scope. The boundary cleanup removes the orchestrator's
  *use* of it; the registry itself stays.

- **`PI_SUBAGENT_TOOLS` whitelist + `setActiveTools` gating in
  `pi-orchestrator/src/extension.ts`.** Removing `PI_SUBAGENT_TOOLS`
  from the active toolset would expose the `Agent` tool to the main LLM
  unconditionally — a behavior change, not a boundary cleanup. The
  current gating is a deliberate design choice (orchestrator decides
  whether the main LLM can spawn subagents directly) and is preserved.

## Tests added

- `pi-subagents/test/subagent-control-tools.test.ts` (NEW, 3 tests):
  1. **Registration contract**: `registerSubagentControlTools(pi, manager)`
     registers all 4 tool names on the pi extension.
  2. **No globalThis lookup**: pre-poisons the global registry with a
     sentinel manager that throws if called; the registered tool still
     works correctly (returns the real manager's `listAgents()` result,
     not the sentinel's). This is the load-bearing test for the
     boundary cleanup.
  3. **Export reachable**: `import("../src/index.js")` exposes
     `registerSubagentControlTools` as a function — confirms the
     re-export wiring.

## Behavior change (deliberate)

Before: the 4 subagent control tools were registered only when
**pi-orchestrator** extension loaded alongside **pi-subagents**.

After: the 4 tools are registered whenever **pi-subagents** loads,
regardless of whether **pi-orchestrator** is present.

This matches the "runtime owns the runtime surface" design intent. The
`setActiveTools` gating in `pi-orchestrator/src/extension.ts:session_start`
(line 188-200) still controls LLM-side visibility, so non-orchestrator
sessions that load pi-subagents can opt out by not calling `setActiveTools`
on `SUBAGENT_CONTROL_TOOLS`. The change is purely about registration
ownership; visibility semantics are preserved.

## Verification

```
$ cd pi-orchestrator && bun test ./test --path-ignore-patterns dist/
 518 pass
   2 skip
   0 fail
1025 expect() calls
   Duration  7.35s

$ cd pi-tasks && bun x vitest run
 Test Files  24 passed (24)
      Tests  436 passed (436)
   Duration  9.65s

$ cd pi-subagents && bun x vitest run
 Test Files  82 passed (82)
      Tests  990 passed (990)
   Duration  25.29s

$ cd pi-orchestrator && bun run verify:all
[catalog] catalogs/ vs source files ... OK
[gcdb] FAIL (pre-existing baseline: 11 uncovered GCs from prior work)
[isolation-modes] OK
[namespace-ownership] OK
[pi-universe] OK
[soft-mode-mental-model] OK
```

The `gcdb` failure is **pre-existing baseline** — 11 older GCs lack
postmortems in `pi/docs/postmortem/`. Not caused by this GC; my new GC
contributes a fresh goal yaml + a matching postmortem. Filed as a
follow-up.

## Boundary verification (post-GC)

```
$ git grep "@sages/pi-subagents" pi-orchestrator/src/
# 3 results — all comments or the deliberate retry-helper shared-vocab
# import. NO runtime symbol imports.

$ git grep "Symbol.for(..pi-subagents:manager." pi-orchestrator/
# 1 result — comment in extension.ts explaining the historical context.
# NO runtime symbol use.
```

Runtime imports from pi-subagents into pi-orchestrator: **0 non-comment
references, 0 `Symbol.for`** lookups. Boundary is clean.

## Commits

- `f6d94aa refactor(boundary): move subagent control tools to pi-subagents + delete dead phase-prompts`
- `702180e merge(GC-2026-boundary-subagent-control): move subagent control tools + delete dead phase-prompts`

## Follow-ups

- **Pre-existing gcdb baseline**: 11 older GCs (088, 089, 090, 091, 092, 093,
  orchestrator-simplify, path-B-tracking, pi-tasks-fork,
  remove-magic-context, rename-auditor) lack postmortems. Filing as a
  separate cleanup GC.
- **`MANAGER_KEY` registry in pi-subagents**: still published for back-
  compat. Once the 11-GC follow-up lands, this registry has no
  production consumer and can be removed.
- **install.sh `--sync-only` mode**: postmortem for `GC-2026-pi-tasks-cascade-agentid`
  flagged this. Not achieved here either; consistent with the prior GC.