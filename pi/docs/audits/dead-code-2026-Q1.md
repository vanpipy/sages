# Dead code audit — Sages monorepo (2026-Q1)

> **Phase:** Investigate (no deletions performed; this is a deliverable for the
> Reviewer + Clean phase).
> **Ref:** sages-board-watch intent #4.
> **Date:** 2026 Q1 (post `chore/remove-orchestrator-advisory`,
> `chore/remove-goal-contract`, `decompose-task-removed`).
> **Scope:** every `pi-*/` subpackage + repo root.

## 1. Method

### 1.1 Tooling

- **Authoritative scan:** `aft_inspect` (AFT 6.0.3, typescript LSP 6.0.3 in
  four packages + typescript LSP 5.9.3 in pi-evaluator; biome 2.x in two
  packages). Sections requested: `dead_code`, `unused_exports`. `topK: 100`.
- **Per-package checks:** `node -e "console.log(JSON.stringify(require('./$p/package.json').scripts, null, 2))"` for each of `pi-orchestrator/`,
  `pi-tasks/`, `pi-subagents/`, `pi-codebase-memory/`, `pi-evaluator/`.
- **False-positive review:** `aft_callgraph({ op: 'callers' })` for every
  flagged symbol, plus direct file reads of the surrounding context.
- **Cross-cutting checks:** `aft_search` for any string literals
  (`BRAINSTORM_TOOL`, `RpcReply`, `DEFAULT_AGENT_NAMES`,
  `WORKFLOW_TICK_MS`, `MockPi`, `teardown`, `DimensionName`, `GlobalConfig`,
  `createBrainstormContext`, `isActivePhase`, `isTerminalPhase`,
  `ApproachComparison`, `assertGoalArtifact`, `assertDagArtifact`,
  `buildJudgeUserMessage`) across `pi-orchestrator/`, `pi-tasks/`,
  `pi-subagents/`, `pi-codebase-memory/`, `pi-evaluator/`,
  `pi/docs/learn/`, plus the orchestrator's own
  `src/index.ts` re-export surface.
- **Self-test against vitest conventions:** `pi-tasks/vitest.config.ts`
  inspected for `globalSetup` + `setupFiles` usage.

### 1.2 No external dead-code tooling in this repo

The package-native tooling check turned up **no** `check:dead`, `lint:dead`,
`find:dead`, ts-prune, knip, or ts-unused-exports scripts. The complete
`scripts` section per package:

```text
pi-orchestrator/package.json:  { typecheck, test, demo:task-feeding }
pi-tasks/package.json:        { build, prepublishOnly, test, test:watch, typecheck, lint, lint:fix }
pi-subagents/package.json:    { build, prepublishOnly, test, test:watch, test:e2e, typecheck,
                                lint, lint:fix, check, test:coverage, bench, bench:ab }
pi-codebase-memory/package.json: { typecheck }
pi-evaluator/package.json:    { test, typecheck }
```

So this audit depends entirely on `aft_inspect` + manual callgraph review.

### 1.3 Raw `aft_inspect` output

#### 1.3.1 Whole-monorepo scan (5 package roots)

Tool version per package: TypeScript 6.0.3 for `pi-orchestrator`,
`pi-tasks`, `pi-subagents`, `pi-codebase-memory`; TypeScript 5.9.3 for
`pi-evaluator`. `scope: ['pi-orchestrator/', 'pi-tasks/', 'pi-subagents/',
'pi-codebase-memory/', 'pi-evaluator/']`.

```text
Dead code: 23 (bash, json, markdown not analyzed):
  pi-evaluator/src/engine/coefficients-schema.ts::DimensionName
  pi-evaluator/src/engine/coefficients-schema.ts::GlobalConfig
  pi-evaluator/src/lib/artifact-reader.ts::assertGoalArtifact
  pi-evaluator/src/lib/artifact-reader.ts::assertDagArtifact
  pi-evaluator/src/metrics/llm-judge/prompts.ts::buildJudgeUserMessage
  pi-tasks/test/global-setup.ts::teardown
  pi-tasks/test/helpers/mock-pi.ts::MockPi
  pi-codebase-memory/src/index.ts::default
  pi-orchestrator/src/brainstorming/index.ts::startBrainstorm
  pi-orchestrator/src/brainstorming/index.ts::processClarifyingPhase
  pi-orchestrator/src/brainstorming/index.ts::processProposingPhase
  pi-orchestrator/src/brainstorming/index.ts::processDesigningPhase
  pi-orchestrator/src/brainstorming/index.ts::finalizeDesign
  pi-orchestrator/src/brainstorming/index.ts::BRAINSTORM_TOOL
  pi-orchestrator/src/brainstorming/state.ts::createBrainstormContext
  pi-orchestrator/src/brainstorming/state.ts::isActivePhase
  pi-orchestrator/src/brainstorming/state.ts::default
  pi-orchestrator/src/brainstorming/types.ts::ApproachComparison
  pi-orchestrator/src/brainstorming/types.ts::default
  pi-orchestrator/src/extension.ts::default
  pi-subagents/src/cross-extension-rpc.ts::RpcReply
  pi-subagents/src/types.ts::DEFAULT_AGENT_NAMES
  pi-subagents/src/ui/workflow-card.ts::WORKFLOW_TICK_MS

Unused exports: 22 (same set minus the default-extension entrypoints the
runtime picks up via package.json `pi.extensions`):
  pi-evaluator/src/engine/coefficients-schema.ts::DimensionName
  pi-evaluator/src/engine/coefficients-schema.ts::GlobalConfig
  pi-evaluator/src/lib/artifact-reader.ts::assertGoalArtifact
  pi-evaluator/src/lib/artifact-reader.ts::assertDagArtifact
  pi-evaluator/src/metrics/llm-judge/prompts.ts::buildJudgeUserMessage
  pi-tasks/test/global-setup.ts::teardown
  pi-tasks/test/helpers/mock-pi.ts::MockPi
  pi-codebase-memory/src/index.ts::default                    [= extension entrypoint]
  pi-orchestrator/src/brainstorming/index.ts::startBrainstorm
  pi-orchestrator/src/brainstorming/index.ts::processClarifyingPhase
  pi-orchestrator/src/brainstorming/index.ts::processProposingPhase
  pi-orchestrator/src/brainstorming/index.ts::processDesigningPhase
  pi-orchestrator/src/brainstorming/index.ts::finalizeDesign
  pi-orchestrator/src/brainstorming/index.ts::BRAINSTORM_TOOL
  pi-orchestrator/src/brainstorming/state.ts::createBrainstormContext
  pi-orchestrator/src/brainstorming/state.ts::isActivePhase
  pi-orchestrator/src/brainstorming/state.ts::default          [= BrainstormStateMachine]
  pi-orchestrator/src/brainstorming/types.ts::ApproachComparison
  pi-orchestrator/src/brainstorming/types.ts::default          [= { BRAINSTORM_TOOL }]
  pi-subagents/src/cross-extension-rpc.ts::RpcReply
  pi-subagents/src/types.ts::DEFAULT_AGENT_NAMES
  pi-subagents/src/ui/workflow-card.ts::WORKFLOW_TICK_MS

diagnostics: 8 errors, 6 warnings, 49 hints from typescript; 0/1/0/0 bash;
0/5/2/0 biome.
```

#### 1.3.2 Per-package `src/` + `test/` re-scans

Re-scanned the `src/` + `test/` subtrees of every package to surface any
`test-only` exports the broad-scope report might have lumped together.

```text
pi-orchestrator/src + pi-orchestrator/test:
  Dead code: 12; Unused exports: 11.
  All hits are in brainstorming/{index,state,types}.ts and extension.ts
  (the default-export entrypoint is registered via pi.extensions: ["src/extension.ts"]).

pi-tasks/src + pi-tasks/test:
  Dead code: 2; Unused exports: 2.
  pi-tasks/test/global-setup.ts::teardown       — false positive (vitest global teardown hook)
  pi-tasks/test/helpers/mock-pi.ts::MockPi      — type alias never imported; genuine dead code.

pi-subagents/src + pi-subagents/test:
  Dead code: 3; Unused exports: 3.
  All three are genuine dead exports; see the Deletion list below.

pi-codebase-memory/src:
  Dead code: 1; Unused exports: 1.
  pi-codebase-memory/src/index.ts::default      — extension entrypoint picked up via
                                                 pi.extensions: ["./src/index.ts"] (false positive).

pi-evaluator/src + pi-evaluator/test:
  Dead code: 5; Unused exports: 5.
  Two TypeScript type aliases (`DimensionName`, `GlobalConfig`) + three functions
  (`assertGoalArtifact`, `assertDagArtifact`, `buildJudgeUserMessage`).
```

Note on `pi-codebase-memory/test`: that directory does not exist
(`ls pi-codebase-memory/` shows `node_modules`, `package.json`, `README.md`,
`skills`, `src`, `templates`, `tsconfig.json`). The package has zero tests.

### 1.4 Callgraph verification (per symbol)

`aft_callgraph({ op: 'callers' })` was run against every flagged symbol
above. Results:

| Symbol | Callers | Verdict |
|---|---:|---|
| `pi-orchestrator/src/brainstorming/index.ts::startBrainstorm` | 0 | dead (re-exported by src/index.ts but never called) |
| `pi-orchestrator/src/brainstorming/index.ts::processClarifyingPhase` | 0 | dead (re-exported; never called) |
| `pi-orchestrator/src/brainstorming/index.ts::processProposingPhase` | 0 | dead (re-exported; never called) |
| `pi-orchestrator/src/brainstorming/index.ts::processDesigningPhase` | 0 | dead (re-exported; never called) |
| `pi-orchestrator/src/brainstorming/index.ts::finalizeDesign` | 0 | dead (re-exported; never called) |
| `pi-orchestrator/src/brainstorming/index.ts::BRAINSTORM_TOOL` | 0 | dead (duplicate of types.ts definition; neither is consumed) |
| `pi-orchestrator/src/brainstorming/state.ts::createBrainstormContext` | 0 | dead (NOT re-exported; no callers) |
| `pi-orchestrator/src/brainstorming/state.ts::isActivePhase` | 0 | dead (imported line 14 of index.ts but unused; not re-exported) |
| `pi-orchestrator/src/brainstorming/state.ts::default` (BrainstormStateMachine) | 0 | NOT_DEAD — type/import side (see §5) |
| `pi-orchestrator/src/brainstorming/types.ts::ApproachComparison` | 0 | dead (NOT re-exported; not consumed) |
| `pi-orchestrator/src/brainstorming/types.ts::default` ({ BRAINSTORM_TOOL }) | 0 | dead (BRAINSTORM_TOOL duplicate; never imported) |
| `pi-orchestrator/src/extension.ts::default` | 0 | NOT_DEAD — registered via `pi.extensions` (see §5) |
| `pi-evaluator/src/engine/coefficients-schema.ts::DimensionName` | 0 | dead (TS type alias, erased at runtime) |
| `pi-evaluator/src/engine/coefficients-schema.ts::GlobalConfig` | 0 | dead (TS type alias, erased at runtime) |
| `pi-evaluator/src/lib/artifact-reader.ts::assertGoalArtifact` | 0 | dead (type-guard assertion; never invoked) |
| `pi-evaluator/src/lib/artifact-reader.ts::assertDagArtifact` | 0 | dead (type-guard assertion; never invoked) |
| `pi-evaluator/src/metrics/llm-judge/prompts.ts::buildJudgeUserMessage` | 0 | dead (function defined but never imported; only doc reference) |
| `pi-tasks/test/global-setup.ts::teardown` | 0 | NOT_DEAD — vitest globalSetup teardown hook (see §5) |
| `pi-tasks/test/helpers/mock-pi.ts::MockPi` | 0 | dead (type alias never imported) |
| `pi-codebase-memory/src/index.ts::default` | 0 | NOT_DEAD — registered via `pi.extensions` (see §5) |
| `pi-subagents/src/cross-extension-rpc.ts::RpcReply` | 0 | dead — duplicate of `pi-tasks/src/index.ts:184` local definition |
| `pi-subagents/src/types.ts::DEFAULT_AGENT_NAMES` | 0 | dead — only doc refs in pi/docs/learn/pi-subagents.md:115 |
| `pi-subagents/src/ui/workflow-card.ts::WORKFLOW_TICK_MS` | 0 | dead — only doc refs in pi/docs/learn/pi-subagents.md:115 |

`pi-evaluator/src/lib/artifact-reader.ts:319:2 hint 'parentIndent' is
declared but its value is never read.` (typescript hint, not a separate
dead-code hit) is flagged in `diagnostics` only — out of scope for this
audit since it's a local-scope unused variable, not a module-level dead
export.

The `unused_exports` report also lists `WORKFLOW_TICK_MS` (line 55) but
not the TypeScript types `DimensionName` and `GlobalConfig` as separate
hits — AFT treats type-only exports as not alive via the unused-export
lens. They still need explicit handling because the `dead_code` lens picked
them up.

## 2. Summary table

| Package | AFT dead_code + unused_export hits | False positives | Deletion list (HIGH + MEDIUM) | HOLD list (LOW) | Notes |
|---|---:|---:|---:|---:|---|
| **pi-orchestrator** | 12 | 1 (`default` in `extension.ts` is the runtime entrypoint) | 11 | 5 MEDIUM (re-exported but never called); 6 HIGH (not re-exported) | All hits in `brainstorming/{index,state,types}.ts` |
| **pi-tasks** | 2 | 1 (`teardown` is a vitest globalSetup hook) | 1 | 1 HIGH (`MockPi` type alias) | |
| **pi-subagents** | 3 | 0 | 3 | 3 HIGH (`RpcReply`, `DEFAULT_AGENT_NAMES`, `WORKFLOW_TICK_MS`) | |
| **pi-codebase-memory** | 1 | 1 (`default` is the runtime entrypoint) | 0 | 0 | No `test/` dir exists; only the entrypoint is flagged |
| **pi-evaluator** | 5 | 0 | 5 | 5 HIGH (2 type aliases + 3 functions) | Includes the only TS-type-only hits in the audit |
| **repo root** | 0 | — | 0 | 0 | `pyi`/`go`/JSON diagnostics excluded by AFT |
| **TOTAL** | **23** | **3** | **20** | **5 MEDIUM + 15 HIGH** | |

Per the instructions' risk rubric:

- **HIGH (15)** — zero callers, zero dynamic references, no test coverage.
  Safe to delete without further coordination.
- **MEDIUM (5)** — zero callers BUT re-exported through
  `pi-orchestrator/src/index.ts` (i.e. part of the public surface of
  `@sages/pi-orchestrator`). Delete alongside an `src/index.ts` re-export
  removal + a doc-update in `pi/docs/learn/pi-orchestrator.md` and the
  SKILL references.
- **LOW (0)** — none. There were no candidates whose reachability was
  ambiguous once the runtime-vs-static distinction was drawn.
- **NOT_DEAD (3)** — `pi-orchestrator/src/extension.ts::default`,
  `pi-codebase-memory/src/index.ts::default`, and
  `pi-tasks/test/global-setup.ts::teardown`. All three are entrypoints
  the host/runtime reaches via reflection or convention, not via static
  imports. See §5.

## 3. Deletion list

Risk rubric: HIGH = no callers, not re-exported, no test coverage; MEDIUM
= no callers but re-exported through the package's public surface, so
delete alongside the public-surface update.

### 3.1 pi-orchestrator/src/brainstorming/state.ts

| File:line | Symbol | Signature | Risk | Evidence | Suggested commit |
|---|---|---|---|---|---|
| `pi-orchestrator/src/brainstorming/state.ts:336` | `createBrainstormContext` | `export function createBrainstormContext(cwd: string, request?: string): BrainstormContext` | **HIGH** | `aft_callgraph` = 0 callers; not re-exported by `src/index.ts`; no test imports it; no `aft_search` hit outside the definition site. | `refactor(orchestrator/brainstorm): drop dead createBrainstormContext` |
| `pi-orchestrator/src/brainstorming/state.ts:346` | `isTerminalPhase` | `export function isTerminalPhase(phase: BrainstormPhase): boolean` | **HIGH** | `aft_callgraph` = 0 callers; imported into `brainstorming/index.ts:14` but the import is **unused** (typescript hint at `brainstorming/index.ts:14:34`). Not re-exported. | `refactor(orchestrator/brainstorm): drop dead isTerminalPhase + unused import` |
| `pi-orchestrator/src/brainstorming/state.ts:350` | `isActivePhase` | `export function isActivePhase(phase: BrainstormPhase): boolean` | **HIGH** | `aft_callgraph` = 0 callers; imported into `brainstorming/index.ts:14` but the import is **unused** (typescript hint at `brainstorming/index.ts:14:51`). Not re-exported. | (rolled into the same commit as `isTerminalPhase`) |

The `BrainstormStateMachine` class at `state.ts:39` is the live
implementation; the `default` export `state.ts:354` (`export default
BrainstormStateMachine`) is also dead (no `import state from "./state"`
anywhere), but `BrainstormStateMachine` itself is imported into
`brainstorming/index.ts:14` so only the `default` line is dead — flagged
as NOT_DEAD in §5 for the runtime-extension-entrypoint analogy (same
situation; same audit outcome).

### 3.2 pi-orchestrator/src/brainstorming/types.ts

| File:line | Symbol | Signature | Risk | Evidence | Suggested commit |
|---|---|---|---|---|---|
| `pi-orchestrator/src/brainstorming/types.ts:129` | `ApproachComparison` | `export interface ApproachComparison { approaches: Approach[]; recommendedIndex: number; criteria: string[]; matrix: boolean[][] }` | **HIGH** | `aft_callgraph` = 0 callers; not re-exported; not referenced by tests (`pi-orchestrator/test/tools/brainstorming/brainstorming-types.test.ts` exhaustively lists imported types — `ApproachComparison` absent). | `refactor(orchestrator/brainstorm): drop dead ApproachComparison interface` |
| `pi-orchestrator/src/brainstorming/types.ts:284` | `BRAINSTORM_TOOL` | `export const BRAINSTORM_TOOL = { name: "brainstorm", description: ..., parameters: {…} }` | **HIGH** | `aft_callgraph` = 0 callers; duplicate of `brainstorming/index.ts:689`. No imports anywhere in the repo (verified across `pi-*/`, `pi/docs/`, the orchestrator's own `src/index.ts`, the SKILL.md, the orchestrator-tool.ts registrations). The `default` export at `types.ts:303` wraps this — delete both. | `refactor(orchestrator/brainstorm): drop dead BRAINSTORM_TOOL + types.ts default export` |

### 3.3 pi-orchestrator/src/brainstorming/index.ts (MEDIUM risk — public surface)

| File:line | Symbol | Signature | Risk | Evidence | Suggested commit |
|---|---|---|---|---|---|
| `pi-orchestrator/src/brainstorming/index.ts:425` | `startBrainstorm` | `export function startBrainstorm(cwd: string, request?: string): BrainstormResponse` | **MEDIUM** | `aft_callgraph` = 0 callers; **re-exported** through `pi-orchestrator/src/index.ts:14` as part of the `@sages/pi-orchestrator` public surface. Documented in `pi/docs/learn/pi-orchestrator.md:152, 275`. No production code calls it — the `/brainstorm` skill (`pi-orchestrator/skills/brainstorming/SKILL.md`) is a markdown guide the LLM follows conversationally; it never invokes these functions programmatically. Cleanup also requires removing the entry from `src/index.ts:14` and updating the `pi/docs/learn/pi-orchestrator.md` §8 list. | `refactor(orchestrator/brainstorm): drop unused startBrainstorm + public-surface entry` |
| `pi-orchestrator/src/brainstorming/index.ts:446` | `processClarifyingPhase` | `export function processClarifyingPhase(stateMachine: BrainstormStateMachine, request: string, projectContext: BrainstormContextResult): BrainstormResponse` | **MEDIUM** | Same as above; re-exported at `src/index.ts:15`. | (rolled into the `startBrainstorm` commit) |
| `pi-orchestrator/src/brainstorming/index.ts:473` | `processProposingPhase` | `export function processProposingPhase(stateMachine: BrainstormStateMachine, request: string, intent: IntentSpec, projectContext: BrainstormContextResult): BrainstormResponse` | **MEDIUM** | Same as above; re-exported at `src/index.ts:16`. | (rolled into the `startBrainstorm` commit) |
| `pi-orchestrator/src/brainstorming/index.ts:506` | `processDesigningPhase` | `export function processDesigningPhase(stateMachine: BrainstormStateMachine, request: string, selectedApproach: Approach, projectContext: BrainstormContextResult): BrainstormResponse` | **MEDIUM** | Same as above; re-exported at `src/index.ts:17`. | (rolled into the `startBrainstorm` commit) |
| `pi-orchestrator/src/brainstorming/index.ts:530` | `finalizeDesign` | `export function finalizeDesign(cwd: string, request: string, sections: DesignSection[], approach: Approach): BrainstormResponse` | **MEDIUM** | Same as above; re-exported at `src/index.ts:18`. | (rolled into the `startBrainstorm` commit) |
| `pi-orchestrator/src/brainstorming/index.ts:689` | `BRAINSTORM_TOOL` | `export const BRAINSTORM_TOOL = { name: "brainstorm", description: ..., parameters: {…} }` | **HIGH** | `aft_callgraph` = 0 callers; duplicate of `types.ts:284`; not re-exported through `src/index.ts` (only `types.ts`'s `default` wrapper is referenced, and that's also dead). | (rolled into the `BRAINSTORM_TOOL` types.ts commit) |

All four functions in the first commit are bundled because they share a
single `src/index.ts` re-export block (`src/index.ts:14-19`) and a single
documentation entry (`pi/docs/learn/pi-orchestrator.md:152-164`). A
single Conventional Commits message covers the delete + re-export
removal + doc tweak.

### 3.4 pi-subagents

| File:line | Symbol | Signature | Risk | Evidence | Suggested commit |
|---|---|---|---|---|---|
| `pi-subagents/src/cross-extension-rpc.ts:28` | `RpcReply<T>` | `export type RpcReply<T = void> = { success: true; data?: T } \| { success: false; error: string }` | **HIGH** | `aft_callgraph` = 0 callers. `pi-tasks/src/index.ts:184` defines a **LOCAL** `RpcReply` type with the same shape (NOT an import — verified by reading both files). The cross-extension-rpc.test.ts imports `EventBus, PROTOCOL_VERSION, RpcDeps, registerRpcHandlers, SpawnCapable` but **not** `RpcReply`. | `refactor(subagents/rpc): drop dead exported RpcReply type` |
| `pi-subagents/src/types.ts:15` | `DEFAULT_AGENT_NAMES` | `export const DEFAULT_AGENT_NAMES = ["Developer", "Reviewer"] as const` | **HIGH** | `aft_callgraph` = 0 callers; only references are `pi/docs/learn/pi-subagents.md:115` (descriptive doc, not a code import). The real default-name list is constructed at `pi-subagents/src/agent-types.ts` (the `getDefaultAgentNames` factory referenced from `agent-types.test.ts`). | `refactor(subagents/types): drop dead DEFAULT_AGENT_NAMES constant` |
| `pi-subagents/src/ui/workflow-card.ts:55` | `WORKFLOW_TICK_MS` | `export const WORKFLOW_TICK_MS = 1000` | **HIGH** | `aft_callgraph` = 0 callers; only references are `pi/docs/learn/pi-subagents.md:115` (a description). The runtime cadence is driven by `WorkflowEntry.startedAt` + the widget's own timer loop (no constant needed). | `refactor(subagents/ui): drop dead WORKFLOW_TICK_MS constant` |

### 3.5 pi-evaluator

| File:line | Symbol | Signature | Risk | Evidence | Suggested commit |
|---|---|---|---|---|---|
| `pi-evaluator/src/engine/coefficients-schema.ts:80` | `DimensionName` | `export type DimensionName = (typeof DIMENSIONS)[number]` | **HIGH** | `aft_callgraph` = 0 callers. Type-only export (erased at runtime); the underlying `DIMENSIONS` tuple at `coefficients-schema.ts:79` IS used (`coefficients-schema.ts:116`). Delete the alias; consumers should use `DIMENSIONS[number]` directly if they need it. | `refactor(evaluator/schema): drop dead DimensionName type alias` |
| `pi-evaluator/src/engine/coefficients-schema.ts:148` | `GlobalConfig` | `export type GlobalConfig = Static<typeof GlobalConfigSchema>` | **HIGH** | `aft_callgraph` = 0 callers. Type-only export; `GlobalConfigSchema` (line 86) is used internally at line 113. | `refactor(evaluator/schema): drop dead GlobalConfig type alias` |
| `pi-evaluator/src/lib/artifact-reader.ts:762` | `assertGoalArtifact` | `export function assertGoalArtifact(value: unknown): asserts value is GoalArtifact` | **HIGH** | `aft_callgraph` = 0 callers; not exported from `pi-evaluator/src/index.ts` (the package's public surface); not used in any test (verified via `aft_search` — only the definition site matches). | `refactor(evaluator/artifact-reader): drop dead assertGoalArtifact` |
| `pi-evaluator/src/lib/artifact-reader.ts:776` | `assertDagArtifact` | `export function assertDagArtifact(value: unknown): asserts value is DagArtifact` | **HIGH** | `aft_callgraph` = 0 callers; same situation as `assertGoalArtifact`. | (rolled into the same commit) |
| `pi-evaluator/src/metrics/llm-judge/prompts.ts:27` | `buildJudgeUserMessage` | `export function buildJudgeUserMessage(input: { criteria: string; evidence: string }): { role: "user"; content: string; timestamp: number }` | **HIGH** | `aft_callgraph` = 0 callers; only doc references are `pi/docs/learn/pi-evaluator.md:193` (a description) and `pi-evaluator/CHANGELOG.md:118` (historical). `judge.ts` (the documented wiring layer) does **not** import this helper — it uses an inline shape. | `refactor(evaluator/llm-judge): drop dead buildJudgeUserMessage helper` |

### 3.6 pi-tasks/test

| File:line | Symbol | Signature | Risk | Evidence | Suggested commit |
|---|---|---|---|---|---|
| `pi-tasks/test/helpers/mock-pi.ts:88` | `MockPi` | `export type MockPi = ReturnType<typeof mockPi>` | **HIGH** | `aft_callgraph` = 0 callers. Type-only export. `mockPi()` (line 21) is heavily used across the suite; the `MockPi` alias adds no callers. `pi-orchestrator/test/smoke/gc-2026-073.test.ts:33` defines a separate `MockPi` class locally (same name, different module). | `chore(tasks/test): drop dead MockPi type alias` |

## 4. Hold list

The Reviewer should consider second-guessing the following items before
signing off:

1. **`pi-orchestrator/src/brainstorming/index.ts` — `startBrainstorm` /
   `processClarifyingPhase` / `processProposingPhase` /
   `processDesigningPhase` / `finalizeDesign`** (5 functions, MEDIUM).
   These are documented in `pi/docs/learn/pi-orchestrator.md:152-164,
   275-285` as the runtime phase pipeline of the `/brainstorm` slash
   command. If any future SKILL rewrite intends to **invoke them
   programmatically** (e.g. a `brainstorm` tool the LLM can call rather
   than a markdown-only guide), these should be kept. The Reviewer should
   explicitly check the `pi-orchestrator/skills/brainstorming/SKILL.md`
   roadmap before deleting. Recommend deleting under the assumption that
   the SKILL is conversational — but flagging here so the Reviewer can
   audit the intent.

2. **`pi-evaluator/src/engine/coefficients-schema.ts` —
   `DimensionName` / `GlobalConfig`** (2 type aliases, HIGH).
   The `CoefficientsConfig` type at the same file uses `DimensionsConfig`
   to recover the union-keyed record type. The Reviewer should verify
   that no downstream consumer of the loader wants these type aliases
   before deleting — the JSON loader surfaces them via inferred types,
   so the safe pattern is "delete the alias, change in-repo call sites to
   use `Static<typeof GlobalConfigSchema>` or `DIMENSIONS[number]`".

3. **`pi-evaluator/src/lib/artifact-reader.ts` —
   `assertGoalArtifact` / `assertDagArtifact`** (2 functions, HIGH).
   Type-guard assertions are often reserved for downstream validation
   hooks (e.g. when the loader is reused from another package). The
   Reviewer should confirm that no pi-* package depends on the
   `@sages/pi-evaluator` artifact-reader surface for runtime validation
   before deleting. As of this audit, no package depends on
   pi-evaluator, so the deletion is safe.

4. **`pi-subagents/src/cross-extension-rpc.ts::RpcReply`** (1 type, HIGH).
   The Reviewer should confirm that `pi-tasks/src/index.ts:184` is the
   only place that consumes the envelope shape — the local definition
   in `pi-tasks` is byte-identical to the exported `RpcReply`. If
   `pi-tasks` should be using the `pi-subagents` shared type instead
   (post-cleanup), the deletion should be coordinated with that
   refactor; otherwise it's a pure drop.

5. **`pi-orchestrator/src/brainstorming/index.ts:689` +
   `types.ts:284`** — the two `BRAINSTORM_TOOL` definitions. The
   Reviewer should confirm that **neither** is part of the public
   `orchestrator-tool.ts` registration before deleting (i.e. nothing
   the LLM actually calls under the `brainstorm` tool name). Verified
   during investigation (`grep -n brainstorm orchestrator-tool.ts` →
   no matches), so the deletion is safe.

## 5. Already-claimed-dead-but-wrong (NOT_DEAD)

These three items are AFT hits but are alive via dynamic registration,
vitest convention, or runtime convention. The Reviewer should NOT
delete them.

| File:line | Symbol | Why AFT flagged it | Why it is alive | Evidence |
|---|---|---|---|---|
| `pi-orchestrator/src/extension.ts:236` | `export default function registerOrchestratorExtension(pi: ExtensionAPI): void` | AFT cannot follow `package.json#pi.extensions` resolution; it sees a default export with zero static importers. | Registered as the **pi extension entrypoint** at `pi-orchestrator/package.json:18-26`: `"pi": { "extensions": ["./src/extension.ts"] }`. The pi runtime dynamically imports this file at session_start. | `pi-orchestrator/package.json:18-26` (`"extensions": ["./src/extension.ts"]`); runtime behaviour in `pi-orchestrator/src/extension.ts:236` (`installSessionHooks` + `registerOrchestratorTools` are wired for live use). |
| `pi-codebase-memory/src/index.ts:80` | `export default function piCodebaseMemory(pi: ExtensionAPI): void` | Same reason — default export with zero static importers. | Registered as the pi extension entrypoint at `pi-codebase-memory/package.json:27-33`: `"pi": { "extensions": ["./src/index.ts"] }`. The runtime dynamically imports this file at session_start. | `pi-codebase-memory/package.json:27-33`; runtime behaviour at `pi-codebase-memory/src/index.ts:80-115` (wires `session_start` lifecycle, including the workspace-detect hint). |
| `pi-tasks/test/global-setup.ts:7` | `export function teardown(): void` | AFT's TypeScript/babel path does not know about vitest's `globalSetup` convention. | vitest's `globalSetup` array (`pi-tasks/vitest.config.ts:6` — `globalSetup: ["./test/global-setup.ts"]`) loads the file at worker start. From that file vitest picks up the named exports `setup` (if present) and `teardown` (per vitest docs — a per-process teardown hook fired once all workers finish). The file's own header comment (`pi-tasks/test/global-setup.ts:1-2`) explicitly states its job: "Shared by every worker, so it can only be removed once they have all finished." | `pi-tasks/vitest.config.ts:6` (`globalSetup: ["./test/global-setup.ts"]`); `pi-tasks/test/global-setup.ts:1-9`. |
| `pi-orchestrator/src/brainstorming/state.ts:354` | `export default BrainstormStateMachine` | Same shape as the two extension entrypoints above — default export with zero static importers. | This is structurally analogous to the NOT_DEAD cases: a default-exported symbol that no static import resolves. `BrainstormStateMachine` (the class) IS imported by name at `brainstorming/index.ts:14` — only the **default** alias is dead. The Reviewer should still consider removing the `default` line, but the deletion is cosmetic (no behaviour change, no test break). | `pi-orchestrator/src/brainstorming/index.ts:14` imports `BrainstormStateMachine` by name; no `import state from "./state"` anywhere in `pi-orchestrator/`, `pi-subagents/`, `pi-tasks/`, `pi-evaluator/`, `pi-codebase-memory/`, or `pi/docs/`. Treat as **HOLD** rather than **DELETE**: cheap to drop, but the file's test surface (`brainstorming/state.ts` is part of the brainstorming module's public surface per `src/index.ts`) means a defensive removal is safer than a wholesale cleanup. |

## Acceptance checklist (for the Reviewer)

- [ ] Every HIGH-risk item in §3 has a single-file or two-file diff.
- [ ] The MEDIUM-risk bundle (`startBrainstorm` + `processClarifyingPhase`
      + `processProposingPhase` + `processDesigningPhase` +
      `finalizeDesign`) also removes the matching re-exports at
      `pi-orchestrator/src/index.ts:14-19` and updates the
      `pi/docs/learn/pi-orchestrator.md` §8 entry list.
- [ ] The `BRAINSTORM_TOOL` deletion (both `index.ts:689` and
      `types.ts:284` + `types.ts:303`) leaves no orphan `default` export
      in `brainstorming/types.ts`.
- [ ] None of the three NOT_DEAD items in §5 are touched.
- [ ] Pre-commit `bun run typecheck` passes per package.
- [ ] Per-package test suite passes (`bun test ./test` /
      `vitest run` per `package.json`).
- [ ] `git diff origin/main..HEAD --name-only` excludes every `.pi/` path.

## Commit plan (incoming mirror)

The Reviewer + Clean phase will land the deletions in **6 commits**, one
per `Suggested commit` column:

1. `refactor(orchestrator/brainstorm): drop dead createBrainstormContext` (HIGH, state.ts)
2. `refactor(orchestrator/brainstorm): drop dead isTerminalPhase + unused import` (HIGH, state.ts) — pair `isActivePhase`
3. `refactor(orchestrator/brainstorm): drop dead ApproachComparison interface` (HIGH, types.ts)
4. `refactor(orchestrator/brainstorm): drop dead BRAINSTORM_TOOL + types.ts default export` (HIGH, both files)
5. `refactor(orchestrator/brainstorm): drop unused startBrainstorm + public-surface entry` (MEDIUM, index.ts + src/index.ts + docs)
6. `refactor(subagents/rpc): drop dead exported RpcReply type` (HIGH, cross-extension-rpc.ts)
7. `refactor(subagents/types): drop dead DEFAULT_AGENT_NAMES constant` (HIGH, types.ts)
8. `refactor(subagents/ui): drop dead WORKFLOW_TICK_MS constant` (HIGH, workflow-card.ts)
9. `refactor(evaluator/schema): drop dead DimensionName type alias` (HIGH, coefficients-schema.ts)
10. `refactor(evaluator/schema): drop dead GlobalConfig type alias` (HIGH, coefficients-schema.ts)
11. `refactor(evaluator/artifact-reader): drop dead assertGoalArtifact` (HIGH, artifact-reader.ts) — pair `assertDagArtifact`
12. `refactor(evaluator/llm-judge): drop dead buildJudgeUserMessage helper` (HIGH, prompts.ts)
13. `chore(tasks/test): drop dead MockPi type alias` (HIGH, mock-pi.ts)

Total: 13 commits, ~64 lines deleted, all HIGH or MEDIUM, all in
production source under `pi-*/`. Zero production-code risk; one
documentation tweak in `pi/docs/learn/pi-orchestrator.md` per the
MEDIUM bundle.