/**
 * GaoYao - Phase-Guided Auditor
 * 
 * Structured prompt chain audit using Xie Zhi methodology.
 * Enforces sequential phase completion to ensure thorough analysis.
 * 
 * @example
 * import { registerGaoYaoTools } from "./gaoyao";
 * registerGaoYaoTools(pi);
 */

export { registerGaoYaoTools } from "./tools.js";
export { AuditSessionManager } from "./session.js";
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
} from "./session.js";
export {
  PHASE_ORDER,
  PHASE_LABELS,
  PHASE_CATEGORY_MAP,
  REQUIRED_FILES_PER_PHASE,
  calculateScoresFromFindings,
  calculateVerdict,
  getVerdictAction,
} from "./session.js";
export {
  enumerateSourceFiles,
  generateEnumerationGuidance,
  generatePhaseGuidance,
  generateFinalAuditReport,
} from "./phases.js";
