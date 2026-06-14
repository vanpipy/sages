/**
 * index.ts — Public exports for @sages/pi-minimax.
 */

export { registerMinimaxTools } from "./tools/index.js";
export { findMmx, clearMmxCache, type MmxLocation, type MmxSource } from "./services/binary-finder.js";
export { execMmx, type ExecMmxArgs, type ExecMmxResult, type FlatValue } from "./services/exec.js";
export { parseAuthStatus, isAuthed, type AuthStatus } from "./services/auth-status.js";
export { ensureAuth, clearAuthState, NotAuthedError, BootstrapFailedError } from "./services/auth-bootstrap.js";
export { runAuthStatusTool } from "./tools/auth.js";
export { runExecTool } from "./tools/exec.js";
export { runSearchQuery } from "./tools/search.js";
