/**
 * Tools Index — compatibility shim during PR 2 transition.
 *
 * The 4-stage DAG orchestrator + brainstorming + observability + project
 * analyzer have moved to the `@sages/pi-orchestrator` package
 * (sibling monorepo at `../pi-orchestrator/`). The pi extension entry
 * point (`src/extension.ts`) calls the orchestrator package's
 * `registerOrchestratorTools` directly; this re-export exists for
 * legacy code paths that still import `registerOrchestratorTools` from
 * `@/tools/index.js`.
 *
 * PR 3 will delete this shim and the orchestrator package will be the
 * sole source of truth.
 */

export { registerOrchestratorTools } from "../../../pi-orchestrator/src/index.js";