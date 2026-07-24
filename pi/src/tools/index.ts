/**
 * Tools Index — re-exports the orchestrator tool registrar.
 *
 * The legacy four-sage role tools (Fuxi / QiaoChui / LuBan / GaoYao) were
 * removed; the orchestrator is now the sole in-process workflow surface.
 * Subagent execution is delegated to the Agent tool.
 */

export { registerOrchestratorTools } from "./orchestrator/index.js";