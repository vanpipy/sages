/**
 * index.ts — Public exports for @sages/pi-minimax.
 *
 * Post-2026-07-19 simplification: the L1 `minimax_exec` escape hatch was
 * removed. The LLM now uses mmx directly via the AFT-backed `bash` tool
 * (or the mmx-cli skill at ~/.pi/agent/skills/mmxc-cli/SKILL.md for command
 * reference). pi-minimax retains only the two tools that benefit from
 * TypeBox-typed schemas and auto-auth: `minimax_auth_status` and
 * `minimax_search_query`.
 */

export { registerMinimaxTools } from "./tools/index.js";
export { findMmx, clearMmxCache, type MmxLocation, type MmxSource } from "./services/binary-finder.js";
export { execMmx, EXEC_TIMEOUT_MS, type ExecMmxArgs, type ExecMmxResult, type FlatValue } from "./services/exec.js";
export { parseAuthStatus, isAuthed, type AuthStatus } from "./services/auth-status.js";
export { ensureAuth, clearAuthState, AUTH_CACHE_TTL_MS, NotAuthedError, BootstrapFailedError } from "./services/auth-bootstrap.js";
export {
    detectRegionFix,
    clearRegionFixCache,
    readMmxConfig,
    CORRECTED_CN_BASE_URL,
    type MmxConfigSnapshot,
    type RegionFixReader,
    type RegionFixState,
} from "./services/region-fix.js";
export type { ToolError, ToolErrorCode, ToolFailure } from "./services/result.js";
export { runAuthStatusTool } from "./tools/auth.js";
export { runSearchQuery } from "./tools/search.js";
