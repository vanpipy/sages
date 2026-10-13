# `pi-evaluator` — opt-in reward-mode evaluator

> Source: `pi-evaluator/` (workspaces member; npm namespace
> `@sages/pi-evaluator`).
> File count: ~20 source files in `src/` (engine/, lib/, metrics/,
> signals/, tools/, plus `extension.ts`, `prompts.ts`, `settings.ts`,
> `state.ts`, `types.ts`). Tests under `test/`. Also ships a SKILL at
> `skills/evaluator/SKILL.md`.

## Purpose

`pi-evaluator` is the opt-in **reward mode** extension. When the
user sets `sages.rewardMode: true` in `~/.pi/agent/settings.json`, the
extension surfaces two LLM-facing tools — `eval_score` and
`eval_trend` — that let the orchestrator self-evaluate an active
Sages workflow. The shape is locked by GC-2026-019:

- `eval_score` returns the running workflow's `total_score` (0–100)
  plus a 5-dimension breakdown (`goal`, `dag`, `implement`, `audit`,
  `coordination`) with per-dimension `score` and `evidence[]` pointing
  at the artifact + location to fix.
- `eval_trend` compares the active workflow against historical
  similar workflows (sample size, trend direction, percentile).

The extension is **off by default** — the `session_start` listener
in `extension.ts` reads the setting, sets `state.mode = "on" | "off"`
once per session, and never toggles mid-session. Hot-switching via
`/reward` etc. is explicitly OUT OF SCOPE (GC-2026-019 anti-goal).

The evaluator is currently path-A-shaped (per `README.md`). Path B
(the full signal-engine wiring into orchestrator events) is being
developed; for now, the lazy self-cook path in `eval-score.ts:96`
runs `scoreWorkflow(workflowPath, coefficients, cwd)` on demand when
`active_workflow_path` is set but `active_workflow` is null.

## Entry points

Per `pi-evaluator/package.json:20–25`:

```jsonc
"pi": {
  "extensions": [ "./src/extension.ts" ],
  "skills":     [ "./skills" ]
}
```

The package's pi entry point is `src/extension.ts`, which exports
`registerEvaluatorExtension` as default
(`pi-evaluator/src/extension.ts:97`). `package.json:14` declares
`"main": "src/extension.ts"` for non-pi consumers.

The two reward-mode tools are registered by
`registerEvalTools(pi, state, historical)` at
`pi-evaluator/src/tools/index.ts:29`.

## Key symbols

Top 10, ordered by importance:

1. **`registerEvaluatorExtension`** (default export) —
   `pi-evaluator/src/extension.ts:97`. Wires:
   - `state = createEvalState()` (`state.ts:117`) — initial state
     with default coefficients loaded from
     `~/.pi/agent/evaluator-log/coefficients.json` (or built-in
     defaults).
   - `registerEvalTools(pi, state, historical)` (`tools/index.ts:29`)
     registers both `eval_score` and `eval_trend`.
   - `pi.on("session_start", ...)` (`:107`) — reads
     `readSagesRewardMode()` (`settings.ts:63`) once, sets
     `state.mode = "on" | "off"`. Then `reloadCoefficients(state)`
     (`state.ts:134`) re-reads the user's coefficients file at
     session start so mid-session edits are honored on next session.
   - `pi.on("before_agent_start", ...)` (`:117`) — appends
     `REWARD_MODE_SYSTEM_PROMPT` (`prompts.ts:18`) to the system
     prompt when `state.mode === "on"`.
   - `pi.on("tool_call", ...)` (`:139`) — tracks active workflow for
     the lazy `eval-score` self-cook path. Only fires for the 4
     Sages orchestrator tool names
     (`goal_contract_create` / `dag_synthesize` / `task_dispatch`
     / `orchestrator_audit` — see `ORCHESTRATOR_TOOL_NAMES` at
     `extension.ts:37`).

2. **`makeEvalScoreTool`** — `pi-evaluator/src/tools/eval-score.ts:175`.
   The `eval_score` tool definition (TypeBox schema
   `EvalScoreParams` at `:35`, lock-shaped output
   `EvalScoreOutput` at `:42`). Backed by the pure
   `computeEvalScore(state)` (`eval-score.ts:85`) which:
   - Returns `{ status: "blocked", intent: "reward mode is off…", ... }`
     when `state.mode === "off"`.
   - Lazy-cooks a workflow via
     `scoreWorkflow(state.active_workflow_path, state.coefficients, cwd)`
     when `state.active_workflow === null && active_workflow_path` is
     set; caches the result back into `state.active_workflow`.
   - Returns an all-zero dimensions map
     (`emptyDimensions` at `:60`) when no workflow is active.
   - Otherwise returns a defensive copy of the cached workflow's
     dimensions + total.

3. **`makeEvalTrendTool`** — `pi-evaluator/src/tools/eval-trend.ts`
   (see `tools/index.ts:30`). The companion `eval_trend` tool.
   Compares the active workflow against a `historical: HistoricalReport[]`
   (T2 ships an empty feed; T3 will load from disk). Returns
   `sample_size`, `trend` (`UP` / `DOWN` / `STABLE` / `INSUFFICIENT_DATA`),
   `trend_delta`, percentile by total + per dimension.

4. **`scoreWorkflow` / `scoreDimension` / `globalScore`** —
   `pi-evaluator/src/engine/scoring-engine.ts:88 / 63 / 106`. The
   pure scoring engine:
   - `scoreWorkflow(workflowPath, coefficients, cwd)` (`:106`) iterates
     the 5 dimensions (`DIMENSIONS` from
     `engine/coefficients-schema.ts:79`), calls `scoreDimension` on each.
   - `scoreDimension(signals, ctx)` (`:67`) runs each signal via
     `computeSignalValue` (from `signals/metric-runner.ts`), applies
     `norm` + `direction` (`NORM_TABLE` / `DIRECTION_TABLE` at
     `:21` / `:30`), accumulates weighted sums, returns
     `{ score: 0–100, evidence: EvidenceRef[] }`. `data_missing`
     signals are excluded from the sum.
   - `globalScore(dims, coefficients)` (`:122`) sums
     `dims.X.score * weights.X` weighted by
     `coefficients.global.dimension_weights`, returns 0 when total
     weight is 0.

5. **`EvalState`** — `pi-evaluator/src/state.ts:74`. The mutable
   closure shared between event handlers and tool factories. Fields:
   - `mode: "on" | "off"` (`:80`)
   - `coefficients: CoefficientsConfig` (`:88`, loaded from
     `~/.pi/agent/evaluator-log/coefficients.json` via
     `engine/coefficients.ts:211`)
   - `coefficients_warning?: VersionMismatchWarning` (`:93`)
   - `active_workflow: WorkflowScoreState | null` (`:113`)
   - `active_workflow_path?: string` (`:118`, set by
     `extension.ts:tool_call` for the 4 orchestrator tool names)
   - `active_workflow_id?: string` (`:122`)
   - `createEvalState()` (`:131`) is the constructor — loads
     coefficients and falls back to `DEFAULT_COEFFICIENTS`
     (`engine/coefficients-defaults.ts`).
   - `reloadCoefficients(state)` (`:140`) re-loads on `session_start`;
     a malformed file falls back to defaults rather than crashing the
     session.

6. **`Dimension` + `DimensionScore` + `EvidenceRef`** —
   `pi-evaluator/src/types.ts:58 / state.ts:38 / state.ts:28`. The
   canonical 5-dimension union (`goal` / `dag` / `implement` /
   `audit` / `coordination`), the `{ score, evidence }` per-dim
   shape, and the `{ artifact, location, note }` evidence pointer
   that ties a low score back to the artifact to fix.

7. **`CoefficientsConfig` + loaders** —
   `pi-evaluator/src/engine/coefficients-schema.ts`,
   `engine/coefficients.ts`, `engine/coefficients-defaults.ts`,
   `engine/package-version.ts`. The scoring engine's inputs:
   - `loadCoefficients()` (`:211`) and
     `loadCoefficientsAt(path)` (`:138`) parse the user's file,
     validating invariants (`validateInvariants` at `:83`) and
     surfacing a `VersionMismatchWarning` when the file's `version`
     differs from `pi-evaluator/package.json#version`.
   - `COEFFICIENTS_RELATIVE_PATH = "evaluator-log/coefficients.json"`
     (`:50`).
   - Norm / direction types are part of the TypeBox schema.

8. **`Metrics` registry** — `pi-evaluator/src/metrics/registry.ts`.
   - `registerMetric(m)` (`:26`)
   - `getMetric(id)` (`:33`)
   - `listMetricIds()` (`:37`)
   - `clearMetrics()` (`:42`)
   - `registerBuiltinMetrics()` (`:59`) — registers all the built-in
     metric implementations on import.
   Per-dim metric implementations live in
   `metrics/{argument-correctness,goal-accuracy,plan-adherence,plan-quality,step-efficiency,task-completion,tool-adoption,tool-correctness,tool-correctness-internals,tool-use}.ts`,
   plus `metrics/llm-judge/{judge,prompts,seam}.ts` for the LLM-as-
   judge path.

9. **`Signal<T>` + metric-runner** —
   `pi-evaluator/src/types.ts:39` and
   `src/signals/metric-runner.ts`. The
   `computeSignalValue(name, cfg, ctx)` is the engine's adapter
   between a `SignalConfig` (from coefficients) and the metric
   registry. The `Signal<T>` shape is
   `{ value, evidence }` — `evidence` is the human-readable
   trail back to the artifact.

10. **`artifact-reader.ts` + `jsonl-reader.ts`** —
    `pi-evaluator/src/lib/artifact-reader.ts` and
    `src/lib/jsonl-reader.ts`. The pure-data readers that pull
    workflow artifacts from disk:
    - `parseYaml(input)` (`:301`) — the YAML parser used to read
      `goal-*.yaml`, `dag-*.yaml`, `task-*.yaml` artifacts.
    - `assertGoalArtifact` (`:762`), `assertDagArtifact` (`:776`),
      `parseAuditReport` (`:707`) — typed loaders.
    - `readSessionIter(path)` (`:79`) — async iterator over
      `session.jsonl`, returning `SessionIterItem`s.

## Dependencies

From `pi-evaluator/package.json`:

- **peerDependencies** (`:26–30`):
  `@earendil-works/pi-coding-agent *`,
  `@earendil-works/pi-ai *`,
  `@earendil-works/pi-tui *`.
- **dependencies**: `none`.
- **devDependencies** (`:32–36`):
  `typebox ^1.3.34`, `@types/bun latest`, `bun-types latest`,
  `typescript ^5.0.0`.

The package is intentionally dependency-free at runtime. The whole
scoring engine is pure data + pure functions; only the TypeBox
schemas and the host-extension wiring touch external packages.

## Key flows

### Reward mode off

1. `session_start` fires; `readSagesRewardMode()` returns `false`.
2. `state.mode = "off"`.
3. `before_agent_start` skips the system-prompt augmentation.
5. If the LLM calls `eval_score` regardless: `computeEvalScore`
   returns `{ status: "blocked", intent: "reward mode is off; set
   sages.rewardMode=true in ~/.pi/agent/settings.json to enable",
   ... }` (`eval-score.ts:88`). `eval_trend` is gated similarly.

### Reward mode on, no active workflow

1. `session_start` sets `state.mode = "on"`, reloads coefficients.
2. `before_agent_start` appends `REWARD_MODE_SYSTEM_PROMPT`
   (`prompts.ts:18`) — instructs the LLM when to call the tools
   (after DAG design, after key task reports, before finalizing).
4. LLM calls `eval_score` → `computeEvalScore` finds
   `active_workflow === null && active_workflow_path === undefined`
   → all-zero dimensions, `workflow_id: null`, `intent: "no active
   Sages workflow; all dimensions zero"`.

### Reward mode on, active workflow

1. `tool_call` fires for one of the 4 orchestrator tool names
   (`ORCHESTRATOR_TOOL_NAMES` at `extension.ts:37`). The listener
   (`:139`) extracts the workflow id via `extractWorkflowId(toolName, input)`
   (`:68`) and sets `state.active_workflow_path` /
   `state.active_workflow_id`.
2. LLM calls `eval_score`. `computeEvalScore` sees
   `active_workflow === null && active_workflow_path` set →
   dynamically imports `engine/scoring-engine.ts` and runs
   `scoreWorkflow(...)`. The result is cached into
   `state.active_workflow` for subsequent calls (`:104`).
3. The output is the locked `EvalScoreOutput` shape: `status: "ok"`,
   `intent: "scored 5 dimensions for <id>: <score>/100"`, `workflow_id`,
   `total_score`, `dimensions: { goal, dag, implement, audit, coordination }`.
4. The LLM reads the `evidence[]` array on low-scoring dimensions
   and fixes the artifacts at the indicated `artifact` + `location`.

### Coefficients mismatch

When the user's `coefficients.json` has a different `version` than
the package's `package.json#version`, `loadCoefficientsAt` returns a
`VersionMismatchWarning` (`:138` of `engine/coefficients.ts`). That
warning rides on the state as `state.coefficients_warning`
(`state.ts:93`) and surfaces in the `eval_score` output as
`coefficients_warning: { file_version, package_version, note }`
(`eval-score.ts:44` for the type, populated at `:93` in the blocked branch, `:127` in the lazy-fail branch, and `:139` in the empty-workflow branch). The user sees a single
notification that their coefficients may describe a different
release's algorithm.

### Settings persistence

`readSagesRewardModeAt(path)` (`settings.ts:33`) is the pure helper
that reads `sages.rewardMode` from a specific settings.json. Strict
`=== true` check — any non-boolean truthy returns false (intentional
explicit opt-in). The env-driven wrapper `readSagesRewardMode()`
(`settings.ts:63`) reads `$HOME/.pi/agent/settings.json`. Reads
`process.env.HOME` first so unit tests can override it (Bun's
`os.homedir()` ignores in-process overrides).

## Verification

- `cd pi-evaluator && bun run typecheck` — TS check.
- `cd pi-evaluator && bun test` — bun test, ~ multiple suites under
  `pi-evaluator/test/`.

## Where to learn more

- [`pi-orchestrator.md`](./pi-orchestrator.md) — the orchestrator's
  constitution primes the LLM to read this package's `evidence[]`
  arrays.
- [`root.md`](./root.md) — the soft-mode policy under which reward
  mode is opt-in.
- `pi-evaluator/README.md` — package README.
- `pi-evaluator/CHANGELOG.md` — historical spec changes.
- `pi-evaluator/skills/evaluator/SKILL.md` — the LLM-facing skill.
- `pi-evaluator/src/types.ts` — the locked GC-2026-019 type
  contracts (`Dimension`, `ToolBase`, `ToolStatus`, `VerdictStatus`,
  every `*Input` / `*Validation` pair).