/**
 * GaoYao Session Management
 * 
 * Handles audit session state persistence and validation.
 * Session persists to: .sages/workspace/.gaoyao-session.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

/**
 * Audit phase state machine
 * Each phase must be completed before advancing to the next
 */
export type AuditPhase = 
  | "INIT"           // Audit initialized, ready to enumerate
  | "ENUMERATE"      // Phase 1: Enumerate and read all files
  | "INK"            // Phase 2: Analyze code style
  | "NOSE"           // Phase 3: Analyze naming & documentation
  | "FOOT"           // Phase 4: Analyze architecture
  | "CASTRATION"     // Phase 5: Analyze security
  | "DEATH"           // Phase 6: Analyze critical defects
  | "FINAL";         // All phases complete, ready to finalize

/**
 * Finding category mapped to Five Audits (五刑审核)
 */
export type AuditCategory = "ink" | "nose" | "foot" | "castration" | "death";

/**
 * Issue severity levels
 */
export type AuditSeverity = "critical" | "major" | "minor";

/**
 * A single audit finding with evidence
 */
export interface AuditFinding {
  /** Category from Five Audits */
  category: AuditCategory;
  /** Issue severity */
  severity: AuditSeverity;
  /** File path with issue */
  file?: string;
  /** Line number */
  line?: number;
  /** Clear description of the issue */
  issue: string;
  /** Code snippet or reference */
  evidence?: string;
  /** How to fix */
  recommendation: string;
  /** Phase when finding was recorded */
  phase: AuditPhase;
  /** Timestamp */
  recordedAt: string;
}

/**
 * Record of a file that was read
 */
export interface FileReadRecord {
  /** Absolute file path */
  path: string;
  /** When file was read */
  readAt: string;
  /** Number of lines */
  lines: number;
}

/**
 * Record of a completed phase
 */
export interface PhaseCompletion {
  /** Phase that was completed */
  phase: AuditPhase;
  /** When phase was completed */
  completedAt: string;
  /** Files analyzed during this phase */
  filesAnalyzed: string[];
  /** Findings recorded during this phase */
  findingsRecorded: number;
  /** Optional notes */
  notes?: string;
}

/**
 * Active audit session state
 */
export interface AuditSession {
  /** Unique session ID */
  id: string;
  /** Current phase */
  phase: AuditPhase;
  /** Review mode */
  reviewMode: "full" | "quick";
  /** Optional plan name */
  planName?: string;
  /** Project context from analyzer */
  projectContext?: any;
  /** Files enumerated for this audit */
  filesEnumerated: string[];
  /** Files that were read */
  filesRead: FileReadRecord[];
  /** All findings recorded */
  findings: AuditFinding[];
  /** Completed phases */
  completedPhases: PhaseCompletion[];
  /** Session creation time */
  createdAt: string;
  /** Last update time */
  updatedAt: string;
}

/**
 * Score results for each of Five Audits
 */
export interface FiveAuditResults {
  ink: { passed: boolean; score: number; findings: AuditFinding[] };
  nose: { passed: boolean; score: number; findings: AuditFinding[] };
  foot: { passed: boolean; score: number; findings: AuditFinding[] };
  castration: { passed: boolean; score: number; findings: AuditFinding[] };
  death: { passed: boolean; score: number; findings: AuditFinding[] };
}

/**
 * Audit verdict
 */
export type Verdict = "PASS" | "NEEDS_CHANGES" | "REJECTED";

// ============================================================================
// Constants
// ============================================================================

const WORKSPACE_DIR = ".sages/workspace";
const SESSION_FILE = ".sages/workspace/.gaoyao-session.json";

/**
 * Phase execution order
 */
export const PHASE_ORDER: AuditPhase[] = [
  "INIT",
  "ENUMERATE",
  "INK",
  "NOSE",
  "FOOT",
  "CASTRATION",
  "DEATH",
  "FINAL"
];

/**
 * Maps phase to its finding category
 */
export const PHASE_CATEGORY_MAP: Record<AuditPhase, AuditCategory | null> = {
  INIT: null,
  ENUMERATE: null,
  INK: "ink",
  NOSE: "nose",
  FOOT: "foot",
  CASTRATION: "castration",
  DEATH: "death",
  FINAL: null,
};

/**
 * Human-readable phase labels
 */
export const PHASE_LABELS: Record<AuditPhase, string> = {
  INIT: "Initialization",
  ENUMERATE: "文件枚举 (File Enumeration)",
  INK: "墨刑 (Code Style)",
  NOSE: "劓刑 (Naming & Documentation)",
  FOOT: "剕刑 (Architecture)",
  CASTRATION: "宫刑 (Security)",
  DEATH: "大辟 (Critical Defects)",
  FINAL: "Finalization",
};

/**
 * Minimum files required to read before completing each phase
 */
export const REQUIRED_FILES_PER_PHASE: Record<AuditPhase, number> = {
  INIT: 0,
  ENUMERATE: 5,    // Must read at least 5 files
  INK: 3,          // Must read 3 files for style check
  NOSE: 2,         // Must read 2 files for doc check
  FOOT: 3,         // Must read 3 files for architecture check
  CASTRATION: 3,   // Must read 3 files for security check
  DEATH: 2,        // Must read 2 files for critical check
  FINAL: 0,
};

// ============================================================================
// Session Manager
// ============================================================================

/**
 * Manages audit session state and persistence
 */
export class AuditSessionManager {
  private cwd: string;
  private session: AuditSession | null = null;

  /**
   * Create a new session manager
   * @param cwd - Current working directory
   */
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Get session file path
   */
  private getSessionPath(): string {
    return join(this.cwd, SESSION_FILE);
  }

  /**
   * Ensure workspace directory exists
   */
  private ensureWorkspace(): void {
    const workspacePath = join(this.cwd, WORKSPACE_DIR);
    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
    }
  }

  /**
   * Create a new audit session
   * @param reviewMode - Full or quick audit
   * @param planName - Optional plan name
   * @returns New audit session
   */
  create(reviewMode: "full" | "quick", planName?: string): AuditSession {
    this.ensureWorkspace();
    
    const session: AuditSession = {
      id: `gaoyao-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      phase: "INIT",
      reviewMode,
      planName,
      filesEnumerated: [],
      filesRead: [],
      findings: [],
      completedPhases: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.session = session;
    this.save();
    return session;
  }

  /**
   * Load existing session from disk
   * @returns Loaded session or null if none exists
   */
  load(): AuditSession | null {
    const path = this.getSessionPath();
    if (!existsSync(path)) return null;

    try {
      const content = readFileSync(path, "utf-8");
      this.session = JSON.parse(content) as AuditSession;
      return this.session;
    } catch {
      return null;
    }
  }

  /**
   * Get current session
   * @returns Current session or null
   */
  get(): AuditSession | null {
    return this.session;
  }

  /**
   * Save current session to disk
   */
  save(): void {
    if (!this.session) return;
    this.ensureWorkspace();
    
    this.session.updatedAt = new Date().toISOString();
    writeFileSync(this.getSessionPath(), JSON.stringify(this.session, null, 2));
  }

  /**
   * Update session phase
   * @param phase - New phase
   */
  setPhase(phase: AuditPhase): void {
    if (!this.session) return;
    this.session.phase = phase;
    this.save();
  }

  /**
   * Set project context
   * @param context - Project analyzer context
   */
  setProjectContext(context: any): void {
    if (!this.session) return;
    this.session.projectContext = context;
    this.save();
  }

  /**
   * Add enumerated files to session
   * @param files - File paths to add
   */
  addEnumeratedFiles(files: string[]): void {
    if (!this.session) return;
    this.session.filesEnumerated.push(...files);
    this.save();
  }

  /**
   * Record that a file was read
   * @param path - File path
   * @param lines - Number of lines
   */
  recordFileRead(path: string, lines: number): void {
    if (!this.session) return;
    
    // Avoid duplicates
    if (this.session.filesRead.some(f => f.path === path)) return;
    
    this.session.filesRead.push({
      path,
      readAt: new Date().toISOString(),
      lines,
    });
    this.save();
  }

  /**
   * Check if file was read
   * @param path - File path to check
   * @returns true if file was read
   */
  isFileRead(path: string): boolean {
    if (!this.session) return false;
    return this.session.filesRead.some(f => f.path === path);
  }

  /**
   * Add a finding to the session
   * @param finding - Finding to add
   */
  addFinding(finding: AuditFinding): void {
    if (!this.session) return;
    this.session.findings.push(finding);
    this.save();
  }

  /**
   * Mark a phase as completed
   * @param phase - Phase to complete
   * @param notes - Optional notes
   * @returns Phase completion record
   */
  completePhase(phase: AuditPhase, notes?: string): PhaseCompletion {
    if (!this.session) throw new Error("No active session");

    const completion: PhaseCompletion = {
      phase,
      completedAt: new Date().toISOString(),
      filesAnalyzed: this.session.filesRead.map(f => f.path),
      findingsRecorded: this.session.findings.filter(f => f.phase === phase).length,
      notes,
    };

    this.session.completedPhases.push(completion);
    this.save();
    return completion;
  }

  /**
   * Get files read for a specific phase
   * @param phase - Phase to get files for
   * @returns Array of file paths
   */
  getFilesReadForPhase(phase: AuditPhase): string[] {
    if (!this.session) return [];
    
    const phaseIndex = PHASE_ORDER.indexOf(phase);
    const nextPhase = PHASE_ORDER[phaseIndex + 1];
    
    // Files read up to and including this phase
    return this.session.filesRead
      .filter((_, idx) => idx <= phaseIndex)
      .map(f => f.path);
  }

  /**
   * Get findings for a specific phase
   * @param phase - Phase to get findings for
   * @returns Array of findings
   */
  getFindingsForPhase(phase: AuditPhase): AuditFinding[] {
    if (!this.session) return [];
    return this.session.findings.filter(f => f.phase === phase);
  }

  /**
   * Delete session from disk
   */
  delete(): void {
    const path = this.getSessionPath();
    if (existsSync(path)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(path);
    }
    this.session = null;
  }

  /**
   * Get current required phase
   * @returns Current phase
   */
  getCurrentRequiredPhase(): AuditPhase {
    if (!this.session) return "INIT";
    return this.session.phase;
  }

  /**
   * Check if can advance to next phase
   * @returns Object with canAdvance flag and reason if blocked
   */
  canAdvancePhase(): { canAdvance: boolean; reason?: string } {
    if (!this.session) {
      return { canAdvance: false, reason: "No active session" };
    }

    const currentPhase = this.session.phase;
    const requiredReads = REQUIRED_FILES_PER_PHASE[currentPhase];

    if (requiredReads > 0 && this.session.filesRead.length < requiredReads) {
      return {
        canAdvance: false,
        reason: `Phase ${currentPhase} requires reading at least ${requiredReads} files. Currently read: ${this.session.filesRead.length}`,
      };
    }

    // Check if at least some findings were recorded for current phase (except INIT and ENUMERATE)
    if (currentPhase !== "INIT" && currentPhase !== "ENUMERATE") {
      const findingsInPhase = this.session.findings.filter(f => f.phase === currentPhase);
      if (findingsInPhase.length === 0) {
        return {
          canAdvance: false,
          reason: `Phase ${PHASE_LABELS[currentPhase]} requires at least one finding. Use gaoyao_record_finding to record issues.`,
        };
      }
    }

    return { canAdvance: true };
  }
}

// ============================================================================
// Score Calculation
// ============================================================================

/**
 * Severity penalty values
 */
const PENALTY_MAP: Record<AuditSeverity, number> = {
  critical: 30,
  major: 15,
  minor: 5,
};

/**
 * Calculate scores from findings
 * @param findings - All findings
 * @returns Scores for each audit category
 */
export function calculateScoresFromFindings(findings: AuditFinding[]): FiveAuditResults {
  const audits: FiveAuditResults = {
    ink: { passed: true, score: 100, findings: [] },
    nose: { passed: true, score: 100, findings: [] },
    foot: { passed: true, score: 100, findings: [] },
    castration: { passed: true, score: 100, findings: [] },
    death: { passed: true, score: 100, findings: [] },
  };

  const categoryMap: Record<string, keyof FiveAuditResults> = {
    ink: "ink",
    nose: "nose",
    foot: "foot",
    castration: "castration",
    death: "death",
  };

  for (const finding of findings) {
    const category = categoryMap[finding.category];
    if (!category) continue;

    audits[category].findings.push(finding);
    audits[category].score = Math.max(0, audits[category].score - (PENALTY_MAP[finding.severity] || 15));
  }

  for (const key of Object.keys(audits) as Array<keyof FiveAuditResults>) {
    audits[key].passed = audits[key].score >= 70;
  }

  return audits;
}

/**
 * Calculate final verdict from scores
 * @param fiveAudits - Scores for each audit
 * @returns Verdict and score
 */
export function calculateVerdict(fiveAudits: FiveAuditResults): { verdict: Verdict; score: number } {
  // Death penalty is absolute rejection
  if (!fiveAudits.death.passed) {
    return { verdict: "REJECTED", score: Math.min(fiveAudits.death.score, 49) };
  }

  // Security issues require changes
  if (!fiveAudits.castration.passed) {
    return { verdict: "NEEDS_CHANGES", score: fiveAudits.castration.score };
  }

  // Calculate average score
  const scores = [
    fiveAudits.ink.score,
    fiveAudits.nose.score,
    fiveAudits.foot.score,
    fiveAudits.castration.score,
  ];

  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const finalScore = Math.round(avgScore);

  let verdict: Verdict;
  if (finalScore >= 70) {
    verdict = "PASS";
  } else if (finalScore >= 50) {
    verdict = "NEEDS_CHANGES";
  } else {
    verdict = "REJECTED";
  }

  return { verdict, score: finalScore };
}

/**
 * Get action text for verdict
 * @param verdict - The verdict
 * @returns Action text
 */
export function getVerdictAction(verdict: Verdict): string {
  switch (verdict) {
    case "PASS":
      return "Archive workflow. Ready for deployment.";
    case "NEEDS_CHANGES":
      return "Return to LuBan for fixes based on audit findings.";
    case "REJECTED":
      return "Critical issues require redesign. Return to Fuxi.";
  }
}
