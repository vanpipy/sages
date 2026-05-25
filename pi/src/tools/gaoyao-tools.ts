/**
 * GaoYao Tools (皋陶) - Phase-Guided Auditor
 * 
 * DEPRECATED: This file now re-exports from ./gaoyao/ module.
 * The modular structure improves maintainability and testability.
 * 
 * Audit Reports: .sages/workspace/audit.md
 * Session State: .sages/workspace/.gaoyao-session.json
 * 
 * Phase Flow:
 * INIT → ENUMERATE → INK → NOSE → FOOT → CASTRATION → DEATH → FINAL
 */

// Re-export from modular structure
export { registerGaoYaoTools } from "./gaoyao/index.js";
export { AuditSessionManager } from "./gaoyao/session.js";

export type {
  AuditPhase,
  AuditCategory,
  AuditSeverity,
  AuditFinding,
  FileReadRecord,
  PhaseCompletion,
  AuditSession,
  FiveAuditResults,
  Verdict,
} from "./gaoyao/session.js";

export {
  PHASE_ORDER,
  PHASE_LABELS,
  PHASE_CATEGORY_MAP,
  REQUIRED_FILES_PER_PHASE,
  calculateScoresFromFindings,
  calculateVerdict,
  getVerdictAction,
} from "./gaoyao/session.js";

export {
  enumerateSourceFiles,
  generateEnumerationGuidance,
  generatePhaseGuidance,
  generateFinalAuditReport,
} from "./gaoyao/phases.js";
