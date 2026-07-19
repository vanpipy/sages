/**
 * Four Sages - pi Package (role-based agents)
 *
 * Provides four specialized role-based agents, each with its own
 * simplified tool surface. No orchestrator runtime — the LLM routes
 * between agents via natural language and tool calls.
 *
 *   - Fuxi:     Architectural design using MDD Seven Planes (`fuxi_design`)
 *   - QiaoChui: Design review and task decomposition (`qiaochui_review`, `qiaochui_decompose`)
 *   - LuBan:    TDD-based task execution (`luban_execute_task`)
 *   - GaoYao:   Phase-guided quality audit (`gaoyao_audit`, `gaoyao_observe`, `gaoyao_finalize`)
 *
 * File operations (read/write/edit/grep/bash) are not provided here —
 * they come from pi's built-ins (optionally AFT-backed via
 * `@cortexkit/aft-pi`, installed separately by install.sh).
 *
 * Outputs are persisted to `.sages/workspace/` (draft.md, plan.md,
 * execution.yaml, audit.md) via FileService and the per-tool state managers.
 */

// Re-export the package extension entrypoint so other pi packages can
// compose it (e.g. for tests, or for downstream packages that want to
// mount the four roles).
export { default as default, default as registerSagesExtension } from "./extension.js";

// Tools — the only public API for role-level consumers.
export { registerFuxiTools } from "./tools/fuxi-tools.js";
export { registerQiaoChuiTools } from "./tools/qiaochui/index.js";
export { registerLubanTools } from "./tools/luban/index.js";
export { registerGaoYaoTools } from "./tools/gaoyao-tools.js";

// Per-role runtime support — file I/O with security validation.
// FileService is the only cross-tool utility; each role also maintains
// its own state manager internally (DesignStateManager, TaskStateManager,
// AuditSessionManager).
export { FileService } from "./services/file-service.js";
export { createFileService } from "./services/file-service.js";