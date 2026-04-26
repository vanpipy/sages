/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 Sages Tool Registry - OpenCode On-The-Fly Compilation 🜄            ║
 * ║                                                                           ║
 * ║   Exports all Four Sages Agents tools for OpenCode tool discovery        ║
 * ║   Place this file in your OpenCode config: tool/sages.ts                  ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * USAGE:
 * Copy or symlink this directory to your OpenCode config:
 *   ~/.config/opencode/tool/sages/
 *
 * Or reference from your opencode.json:
 *   { "tool": { "sages": "path/to/sages/src/tools/sages-registry.ts" } }
 */

// =============================================================================
// Fuxi Tools - Eight Trigrams Design
// =============================================================================

export { fuxi_create_draft, fuxi_get_draft } from "./fuxi-tools.js";
export { fuxi_orchestrate, fuxi_get_status, fuxi_resume, fuxi_generate_report } from "./fuxi-tools.js";

// =============================================================================
// QiaoChui Tools - Divine Mechanist
// =============================================================================

export { qiaochui_review, qiaochui_decompose } from "./qiaochui-tools.js";

// =============================================================================
// LuBan Tools - Master Craftsman
// =============================================================================

export { luban_execute_task, luban_get_status, luban_release_locks, luban_execute_workflow } from "./luban-tools.js";

// =============================================================================
// GaoYao Tools - Supreme Judge
// =============================================================================

export { gaoyao_review, gaoyao_check_security } from "./gaoyao-tools.js";

// =============================================================================
// Tool Registry Map
// =============================================================================

/**
 * Complete registry of all Sages tools.
 * This is used by OpenCode to discover and register tools.
 */
export const SAGESTOOLS = {
  // Fuxi tools
  fuxi_create_draft: () => import("./fuxi-tools.js").then(m => m.fuxi_create_draft),
  fuxi_get_draft: () => import("./fuxi-tools.js").then(m => m.fuxi_get_draft),
  fuxi_orchestrate: () => import("./fuxi-tools.js").then(m => m.fuxi_orchestrate),
  fuxi_get_status: () => import("./fuxi-tools.js").then(m => m.fuxi_get_status),
  fuxi_resume: () => import("./fuxi-tools.js").then(m => m.fuxi_resume),
  fuxi_generate_report: () => import("./fuxi-tools.js").then(m => m.fuxi_generate_report),

  // QiaoChui tools
  qiaochui_review: () => import("./qiaochui-tools.js").then(m => m.qiaochui_review),
  qiaochui_decompose: () => import("./qiaochui-tools.js").then(m => m.qiaochui_decompose),

  // LuBan tools
  luban_execute_task: () => import("./luban-tools.js").then(m => m.luban_execute_task),
  luban_get_status: () => import("./luban-tools.js").then(m => m.luban_get_status),
  luban_release_locks: () => import("./luban-tools.js").then(m => m.luban_release_locks),
  luban_execute_workflow: () => import("./luban-tools.js").then(m => m.luban_execute_workflow),

  // GaoYao tools
  gaoyao_review: () => import("./gaoyao-tools.js").then(m => m.gaoyao_review),
  gaoyao_check_security: () => import("./gaoyao-tools.js").then(m => m.gaoyao_check_security),
} as const;

export type SagesToolName = keyof typeof SAGESTOOLS;
