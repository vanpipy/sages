/**
 * GaoYao Tools Registration — Simplified 3-tool surface
 *
 * Per the simplify-actions principle (sages.simplify_principle):
 *   - gaoyao_audit    (init / resume / reset / status — all in one)
 *   - gaoyao_observe  (file_read + finding, with auto-advance)
 *   - gaoyao_finalize (produces audit.md, unchanged)
 *
 * Each tool returns the contract shape: {status, intent, validation}.
 * Phases auto-advance when their requirements are met — the LLM never
 * has to call a separate "advance phase" tool.
 *
 * Deprecated stubs return isError with a redirect hint to the new tools.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectAnalyzer } from "../../utils/analyzer";

import {
  AuditSessionManager,
  AuditFinding,
  AuditSession,
  PHASE_ORDER,
  PHASE_LABELS,
  PHASE_CATEGORY_MAP,
  REQUIRED_FILES_PER_PHASE,
  calculateScoresFromFindings,
  calculateVerdict,
  getVerdictAction,
} from "./session";

import {
  enumerateSourceFiles,
  generateEnumerationGuidance,
  generatePhaseGuidance,
  generateFinalAuditReport,
} from "./phases";

const WORKSPACE_DIR = ".sages/workspace";

/**
 * Build the standard intent string for a phase.
 */
function buildIntent(
  phase: import("./session").AuditPhase,
  filesReadCount: number,
  filesRequired: number,
  findingsInPhase: number,
  findingsMin: number,
): string {
  const labels = PHASE_LABELS[phase];
  if (phase === "ENUMERATE") {
    return `Read each enumerated file (${filesReadCount}/${filesRequired} done). After reading all files, the audit will auto-advance.`;
  }
  return `Phase ${labels}: analyze files for this category. Findings so far: ${findingsInPhase}${findingsMin > 0 ? ` (need ≥${findingsMin} to advance)` : ""}. Record findings with gaoyao_observe.`;
}

/**
 * Build the standard validation block for a phase.
 */
function buildValidation(
  phase: import("./session").AuditPhase,
  session: AuditSession,
): Record<string, unknown> {
  const v: Record<string, unknown> = {
    files_required: REQUIRED_FILES_PER_PHASE[phase],
    files_read: session.filesRead.length,
  };
  const cat = PHASE_CATEGORY_MAP[phase];
  if (cat) {
    v.category_required = cat;
    v.findings_required_min = 1;
    v.findings_in_phase = session.findings.filter((f) => f.phase === phase).length;
  }
  return v;
}

/**
 * Register all GaoYao tools.
 */
export function registerGaoYaoTools(pi: ExtensionAPI): void {

  // ───────────────────────────────────────────────────────────────────────
  // gaoyao_audit: init / resume / reset / status (one tool)
  // ───────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gaoyao_audit",
    label: "Audit",
    description: "Start, resume, reset, or query the audit session. On first call (or with reset:true) initializes a new session. Otherwise resumes the current session and returns current phase guidance. Use this instead of the old gaoyao_init/gaoyao_status/gaoyao_reset tools.",
    parameters: Type.Object({
      reset: Type.Optional(Type.Boolean({ description: "Discard any existing session and start fresh" })),
      plan_name: Type.Optional(Type.String({ description: "Plan name (optional)" })),
      review_mode: Type.Optional(Type.Union([
        Type.Literal("quick", { description: "Fast triage - only critical checks" }),
        Type.Literal("full", { description: "Complete 5-audit deep analysis (default)" }),
      ], { description: "Review depth (only applies when initializing)" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionManager = new AuditSessionManager(ctx.cwd);

      // Handle reset: clear any existing session first.
      if (params.reset) {
        sessionManager.delete();
      }

      // If a session exists (and we weren't asked to reset), resume it.
      const existing = sessionManager.load();
      if (existing) {
        const payload = {
          status: "in_progress",
          resumed: true,
          session_id: existing.id,
          phase: existing.phase,
          phase_label: PHASE_LABELS[existing.phase],
          intent: buildIntent(
            existing.phase,
            existing.filesRead.length,
            REQUIRED_FILES_PER_PHASE[existing.phase],
            existing.findings.filter((f) => f.phase === existing.phase).length,
            PHASE_CATEGORY_MAP[existing.phase] ? 1 : 0,
          ),
          validation: buildValidation(existing.phase, existing),
          progress: {
            files_enumerated: existing.filesEnumerated.length,
            files_read: existing.filesRead.length,
            findings_total: existing.findings.length,
            phases_completed: existing.completedPhases.length,
          },
          files_read: existing.filesRead.map((f) => f.path),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: { session: existing },
        };
      }

      // No existing session — initialize a new one.
      const review_mode = params.review_mode ?? "full";
      const analyzer = new ProjectAnalyzer();

      try {
        const projectContext = await analyzer.analyze(ctx.cwd);
        const files = enumerateSourceFiles(ctx.cwd, projectContext);

        const session = sessionManager.create(review_mode, params.plan_name);
        session.projectContext = projectContext;
        session.phase = "ENUMERATE";
        session.filesEnumerated = files;
        sessionManager.save();

        const payload = {
          status: "in_progress",
          resumed: false,
          session_id: session.id,
          phase: "ENUMERATE",
          phase_label: PHASE_LABELS["ENUMERATE"],
          intent: buildIntent("ENUMERATE", 0, REQUIRED_FILES_PER_PHASE["ENUMERATE"], 0, 0),
          validation: buildValidation("ENUMERATE", session),
          files_enumerated: files.length,
          files_read: [],
        };

        const workspacePath = join(ctx.cwd, WORKSPACE_DIR);
        const planPath = join(workspacePath, "plan.md");
        let designContext: string | null = null;
        if (existsSync(planPath)) {
          designContext = readFileSync(planPath, "utf-8").slice(0, 1000);
        }

        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: {
            session,
            files: files.slice(0, 20),
            totalFiles: files.length,
            guidance: generateEnumerationGuidance(files, projectContext),
            designContext,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: { message: msg },
          }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // gaoyao_observe: file_read + finding with auto-advance
  // ───────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gaoyao_observe",
    label: "Observe",
    description: "Record a file read OR a finding, with auto-advance when the current phase is complete. Discriminated union: pass either {file_read: {...}} or {finding: {...}}. Replaces the old gaoyao_record_file_read, gaoyao_record_finding, and gaoyao_execute_phase tools.",
    parameters: Type.Object({
      file_read: Type.Optional(Type.Object({
        path: Type.String({ description: "Path to the file that was read" }),
        lines: Type.Optional(Type.Number({ description: "Number of lines in the file" })),
      }, { description: "Record a file read for the current phase" })),
      finding: Type.Optional(Type.Object({
        category: Type.Union([
          Type.Literal("ink"),
          Type.Literal("nose"),
          Type.Literal("foot"),
          Type.Literal("castration"),
          Type.Literal("death"),
        ], { description: "Audit category (must match current phase)" }),
        severity: Type.Union([
          Type.Literal("critical"),
          Type.Literal("major"),
          Type.Literal("minor"),
        ], { description: "Issue severity" }),
        file: Type.Optional(Type.String()),
        line: Type.Optional(Type.Number()),
        issue: Type.String(),
        evidence: Type.Optional(Type.String()),
        recommendation: Type.String(),
      }, { description: "Record an audit finding" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionManager = new AuditSessionManager(ctx.cwd);
      const session = sessionManager.load();

      if (!session) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: "No active audit session. Call gaoyao_audit first.",
          }) }],
          isError: true,
          details: { error: "No session" },
        };
      }

      // Discriminated union: must have exactly one of file_read / finding.
      if (!params.file_read && !params.finding) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: "Provide either file_read or finding",
          }) }],
          isError: true,
          details: { error: "missing field" },
        };
      }
      if (params.file_read && params.finding) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: "Provide exactly one of file_read or finding, not both",
          }) }],
          isError: true,
          details: { error: "both fields" },
        };
      }

      // ── file_read path ──
      if (params.file_read) {
        const { path: filePath, lines = 0 } = params.file_read;
        sessionManager.recordFileRead(filePath, lines);
        const updated = sessionManager.load()!;

        // Auto-advance check.
        const { canAdvance, reason } = sessionManager.canAdvancePhase();
        if (canAdvance) {
          const nextPhase = advancePhase(sessionManager);
          if (nextPhase) {
            const adv = sessionManager.load()!;
            return {
              content: [{ type: "text", text: JSON.stringify({
                status: "in_progress",
                phase: nextPhase,
                phase_label: PHASE_LABELS[nextPhase],
                intent: buildIntent(
                  nextPhase,
                  adv.filesRead.length,
                  REQUIRED_FILES_PER_PHASE[nextPhase],
                  adv.findings.filter((f) => f.phase === nextPhase).length,
                  PHASE_CATEGORY_MAP[nextPhase] ? 1 : 0,
                ),
                validation: buildValidation(nextPhase, adv),
                files_read: adv.filesRead.length,
                auto_advanced: true,
                observation: "file_read",
              }) }],
              details: {
                observation: "file_read",
                auto_advanced: true,
                next_phase: nextPhase,
                session: adv,
              },
            };
          }
        }

        // No advance.
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "in_progress",
            phase: updated.phase,
            phase_label: PHASE_LABELS[updated.phase],
            files_read: updated.filesRead.length,
            files_required: REQUIRED_FILES_PER_PHASE[updated.phase],
            auto_advanced: false,
            observation: "file_read",
            blocked_reason: canAdvance ? undefined : reason,
          }) }],
          details: {
            observation: "file_read",
            auto_advanced: false,
            session: updated,
          },
        };
      }

      // ── finding path ──
      const f = params.finding!;
      const expectedPhase = PHASE_CATEGORY_MAP[session.phase];

      if (!expectedPhase) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: `Phase '${session.phase}' has no category mapped and cannot accept findings. Record file_reads to advance to a numbered phase first.`,
            current_phase: session.phase,
            expected_category: expectedPhase,
          }) }],
          isError: true,
          details: { phase: session.phase },
        };
      }

      if (f.category !== expectedPhase) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: `Invalid category '${f.category}' for current phase '${session.phase}'. Expected category: '${expectedPhase}'.`,
            current_phase: session.phase,
            expected_category: expectedPhase,
            provided_category: f.category,
          }) }],
          isError: true,
          details: { phase: session.phase, expectedCategory: expectedPhase, providedCategory: f.category },
        };
      }

      if (f.file && !sessionManager.isFileRead(f.file)) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: `File '${f.file}' has not been read yet. Call gaoyao_observe with file_read first.`,
            file: f.file,
            files_read: session.filesRead.map((x) => x.path),
          }) }],
          isError: true,
          details: { file: f.file, filesRead: session.filesRead.map((x) => x.path) },
        };
      }

      const finding: AuditFinding = {
        category: f.category,
        severity: f.severity,
        file: f.file,
        line: f.line,
        issue: f.issue,
        evidence: f.evidence,
        recommendation: f.recommendation,
        phase: session.phase,
        recordedAt: new Date().toISOString(),
      };

      sessionManager.addFinding(finding);
      const updated = sessionManager.load()!;
      const findingsInPhase = updated.findings.filter((x) => x.phase === session.phase);

      // Auto-advance check.
      const { canAdvance, reason } = sessionManager.canAdvancePhase();
      if (canAdvance) {
        const nextPhase = advancePhase(sessionManager);
        if (nextPhase) {
          const adv = sessionManager.load()!;
          return {
            content: [{ type: "text", text: JSON.stringify({
              status: "in_progress",
              phase: nextPhase,
              phase_label: PHASE_LABELS[nextPhase],
              intent: buildIntent(
                nextPhase,
                adv.filesRead.length,
                REQUIRED_FILES_PER_PHASE[nextPhase],
                adv.findings.filter((x) => x.phase === nextPhase).length,
                PHASE_CATEGORY_MAP[nextPhase] ? 1 : 0,
              ),
              validation: buildValidation(nextPhase, adv),
              findings_recorded: findingsInPhase.length,
              findings_total: updated.findings.length,
              auto_advanced: true,
              observation: "finding",
            }) }],
            details: {
              observation: "finding",
              auto_advanced: true,
              next_phase: nextPhase,
              session: adv,
              finding_recorded: finding,
            },
          };
        }
      }

      // No advance.
      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "in_progress",
          phase: session.phase,
          phase_label: PHASE_LABELS[session.phase],
          findings_recorded: findingsInPhase.length,
          findings_total: updated.findings.length,
          auto_advanced: false,
          observation: "finding",
          blocked_reason: canAdvance ? undefined : reason,
        }) }],
        details: {
          observation: "finding",
          auto_advanced: false,
          session: updated,
          finding_recorded: finding,
        },
      };
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // gaoyao_finalize (unchanged behavior, shape simplified)
  // ───────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gaoyao_finalize",
    label: "Finalize Audit",
    description: "Generate final verdict and audit report. Requires all phases completed (auto-advance from DEATH).",
    parameters: Type.Object({
      notes: Type.Optional(Type.String({ description: "Overall assessment notes" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { notes } = params;
      const sessionManager = new AuditSessionManager(ctx.cwd);
      const session = sessionManager.load();

      if (!session) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: "No active audit session.",
          }) }],
          isError: true,
          details: { error: "No session" },
        };
      }

      if (session.phase !== "FINAL") {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            error: `Audit not complete. Current phase: ${session.phase}. Continue observing until DEATH is done — it auto-advances to FINAL.`,
            current_phase: session.phase,
            remaining_phases: PHASE_ORDER.slice(PHASE_ORDER.indexOf(session.phase) + 1, -1),
          }) }],
          isError: true,
          details: { currentPhase: session.phase },
        };
      }

      const fiveAudits = calculateScoresFromFindings(session.findings);
      const { verdict, score } = calculateVerdict(fiveAudits);

      const report = generateFinalAuditReport(
        session.projectContext,
        fiveAudits,
        session.findings,
        verdict,
        score,
        notes,
      );

      const workspacePath = join(ctx.cwd, WORKSPACE_DIR);
      writeFileSync(join(workspacePath, "audit.md"), report);

      sessionManager.delete();

      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "complete",
          verdict,
          score,
          total_findings: session.findings.length,
          by_category: {
            ink: session.findings.filter((f) => f.category === "ink").length,
            nose: session.findings.filter((f) => f.category === "nose").length,
            foot: session.findings.filter((f) => f.category === "foot").length,
            castration: session.findings.filter((f) => f.category === "castration").length,
            death: session.findings.filter((f) => f.category === "death").length,
          },
          by_severity: {
            critical: session.findings.filter((f) => f.severity === "critical").length,
            major: session.findings.filter((f) => f.severity === "major").length,
            minor: session.findings.filter((f) => f.severity === "minor").length,
          },
          summary: `Audit finalized: ${verdict} (${score}%). ${session.findings.length} findings.`,
          action: getVerdictAction(verdict),
          audit_path: join(workspacePath, "audit.md"),
        }) }],
        details: {
          verdict,
          score,
          findings: session.findings,
          auditPath: join(workspacePath, "audit.md"),
          completedPhases: session.completedPhases,
        },
      };
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // Deprecated stubs — keep old tool names alive with redirect hints
  // ───────────────────────────────────────────────────────────────────────

  const stubs: Array<{
    name: string;
    hint: string;
    deprecationNote: string;
  }> = [
    { name: "gaoyao_init", hint: "Use gaoyao_audit instead.", deprecationNote: "merged into gaoyao_audit" },
    { name: "gaoyao_record_file_read", hint: "Use gaoyao_observe { file_read: {...} } instead.", deprecationNote: "merged into gaoyao_observe" },
    { name: "gaoyao_record_finding", hint: "Use gaoyao_observe { finding: {...} } instead.", deprecationNote: "merged into gaoyao_observe" },
    { name: "gaoyao_execute_phase", hint: "gaoyao_observe auto-advances phases when their requirements are met.", deprecationNote: "auto-advance is now built-in" },
    { name: "gaoyao_status", hint: "Use gaoyao_audit (without reset) to query the current session state.", deprecationNote: "merged into gaoyao_audit" },
    { name: "gaoyao_reset", hint: "Use gaoyao_audit { reset: true } instead.", deprecationNote: "merged into gaoyao_audit" },
    { name: "gaoyao_review", hint: "Use gaoyao_audit instead.", deprecationNote: "superseded by phase-guided gaoyao_audit" },
    { name: "gaoyao_quick_check", hint: "Use gaoyao_audit { review_mode: 'quick' } instead.", deprecationNote: "superseded by phase-guided gaoyao_audit" },
    { name: "gaoyao_check_security", hint: "Security is the CASTRATION phase in the phase-guided audit. Use gaoyao_audit then advance through phases to CASTRATION.", deprecationNote: "security is now CASTRATION phase" },
  ];

  for (const stub of stubs) {
    pi.registerTool({
      name: stub.name,
      label: `[Deprecated] ${stub.name}`,
      description: `DEPRECATED (${stub.deprecationNote}): ${stub.hint}`,
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: JSON.stringify({
            success: false,
            error: `${stub.name} is deprecated. ${stub.hint}`,
            hint: stub.hint,
            deprecated: true,
            replacement: stub.hint.match(/Use (\w+)/)?.[1] ?? null,
          }) }],
          isError: true,
          details: { deprecated: true, replacement: stub.hint },
        };
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Advance the current phase. Returns the new phase, or null if at end.
 * Mutates the session via sessionManager.
 */
function advancePhase(sessionManager: AuditSessionManager): import("./session").AuditPhase | null {
  const session = sessionManager.load();
  if (!session) return null;
  const currentIndex = PHASE_ORDER.indexOf(session.phase);
  const nextPhase = PHASE_ORDER[currentIndex + 1];
  if (!nextPhase) return null;

  sessionManager.completePhase(session.phase);
  sessionManager.setPhase(nextPhase);
  return nextPhase;
}