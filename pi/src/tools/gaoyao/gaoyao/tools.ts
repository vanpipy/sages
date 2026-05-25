/**
 * GaoYao Tools Registration
 * 
 * Phase-guided audit tools for the Four Sages workflow.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectAnalyzer } from "../utils/analyzer/index.js";

import {
  AuditSessionManager,
  AuditPhase,
  AuditFinding,
  AuditSession,
  PHASE_ORDER,
  PHASE_LABELS,
  PHASE_CATEGORY_MAP,
  REQUIRED_FILES_PER_PHASE,
  calculateScoresFromFindings,
  calculateVerdict,
  getVerdictAction,
} from "./session.js";

import {
  enumerateSourceFiles,
  generateEnumerationGuidance,
  generatePhaseGuidance,
  generateFinalAuditReport,
} from "./phases.js";

import type { Verdict } from "./session.js";

const WORKSPACE_DIR = ".sages/workspace";

// ============================================================================
// Tool Registrations
// ============================================================================

/**
 * Register all GaoYao tools
 * @param pi - Extension API
 */
export function registerGaoYaoTools(pi: ExtensionAPI): void {

  /**
   * gaoyao_init - Initialize audit session with file enumeration
   */
  pi.registerTool({
    name: "gaoyao_init",
    label: "Init Audit",
    description: "Initialize phase-guided audit session. Enumerates files and returns Phase 1 guidance. Must call before other gaoyao tools.",
    parameters: Type.Object({
      review_mode: Type.Optional(Type.Union([
        Type.Literal("quick", { description: "Fast triage - only critical checks" }),
        Type.Literal("full", { description: "Complete 5-audit deep analysis (default)" })
      ], { description: "Review depth" })),
      plan_name: Type.Optional(Type.String({ description: "Plan name (optional)" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { review_mode = "full", plan_name } = params;
      const sessionManager = new AuditSessionManager(ctx.cwd);

      // Check for existing session
      const existingSession = sessionManager.load();
      if (existingSession) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              resumed: true,
              sessionId: existingSession.id,
              phase: existingSession.phase,
              reviewMode: existingSession.reviewMode,
              filesEnumerated: existingSession.filesEnumerated.length,
              filesRead: existingSession.filesRead.length,
              findingsRecorded: existingSession.findings.length,
              summary: `Resumed audit session. Current phase: ${PHASE_LABELS[existingSession.phase]}. ${existingSession.filesRead.length} files read.`,
              nextAction: `Call \`gaoyao_execute_phase --phase ${existingSession.phase}\` to continue.`,
            }),
          }],
          details: {
            session: existingSession,
            guidance: generatePhaseGuidance(
              existingSession.phase,
              existingSession.projectContext,
              existingSession.filesRead.map(f => f.path),
              existingSession.findings.filter(f => f.phase === existingSession.phase)
            ),
          },
        };
      }

      const analyzer = new ProjectAnalyzer();

      try {
        const projectContext = await analyzer.analyze(ctx.cwd);
        const files = enumerateSourceFiles(ctx.cwd, projectContext);
        
        const session = sessionManager.create(review_mode, plan_name);
        session.projectContext = projectContext;
        session.phase = "ENUMERATE";
        session.filesEnumerated = files;
        sessionManager.save();

        const workspacePath = join(ctx.cwd, WORKSPACE_DIR);
        const planPath = join(workspacePath, "plan.md");
        let designContext = null;
        
        if (existsSync(planPath)) {
          designContext = readFileSync(planPath, "utf-8").slice(0, 1000);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              resumed: false,
              sessionId: session.id,
              phase: "ENUMERATE",
              reviewMode: review_mode,
              project: {
                language: projectContext.language,
                framework: projectContext.framework,
                type: projectContext.projectType,
              },
              filesEnumerated: files.length,
              summary: `Audit initialized. ${files.length} files enumerated. Begin Phase 1: ENUMERATE.`,
              nextAction: "Read each file, then call gaoyao_execute_phase --phase ENUMERATE",
            }),
          }],
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
          content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: msg } }) }],
          isError: true,
          details: { error: msg },
        };
      }
    },
  });

  /**
   * gaoyao_record_file_read - Record that a file was read
   */
  pi.registerTool({
    name: "gaoyao_record_file_read",
    label: "Record File Read",
    description: "Record that a file was read. Required before recording findings. Tracks phase progress.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file that was read" }),
      lines: Type.Optional(Type.Number({ description: "Number of lines in the file" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { path, lines = 0 } = params;
      const sessionManager = new AuditSessionManager(ctx.cwd);
      const session = sessionManager.load();

      if (!session) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active audit session. Call gaoyao_init first." }) }],
          isError: true,
          details: { error: "No session" },
        };
      }

      sessionManager.recordFileRead(path, lines);
      const updatedSession = sessionManager.load()!;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            fileRecorded: path,
            totalFilesRead: updatedSession.filesRead.length,
            requiredForCurrentPhase: REQUIRED_FILES_PER_PHASE[session.phase],
            summary: `Recorded read: ${path}. ${updatedSession.filesRead.length}/${REQUIRED_FILES_PER_PHASE[session.phase]} files read for ${PHASE_LABELS[session.phase]}.`,
          }),
        }],
        details: {
          file: path,
          filesRead: updatedSession.filesRead.length,
          required: REQUIRED_FILES_PER_PHASE[session.phase],
        },
      };
    },
  });

  /**
   * gaoyao_execute_phase - Complete current phase and get next guidance
   */
  pi.registerTool({
    name: "gaoyao_execute_phase",
    label: "Execute Phase",
    description: "Complete current phase and advance. Validates file reads and findings before advancing.",
    parameters: Type.Object({
      phase: Type.Union([
        Type.Literal("ENUMERATE"),
        Type.Literal("INK"),
        Type.Literal("NOSE"),
        Type.Literal("FOOT"),
        Type.Literal("CASTRATION"),
        Type.Literal("DEATH"),
      ], { description: "Phase to complete and advance from" }),
      notes: Type.Optional(Type.String({ description: "Optional notes for this phase" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { phase, notes } = params;
      const sessionManager = new AuditSessionManager(ctx.cwd);
      const session = sessionManager.load();

      if (!session) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active audit session. Call gaoyao_init first." }) }],
          isError: true,
          details: { error: "No session" },
        };
      }

      if (phase !== session.phase) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `Invalid phase. Current phase is ${session.phase}. Cannot complete ${phase}.`,
              currentPhase: session.phase,
              requestedPhase: phase,
            }),
          }],
          isError: true,
          details: { currentPhase: session.phase, requestedPhase: phase },
        };
      }

      const { canAdvance, reason } = sessionManager.canAdvancePhase();
      if (!canAdvance) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: reason,
              phase: session.phase,
              filesRead: session.filesRead.length,
              required: REQUIRED_FILES_PER_PHASE[session.phase],
              findingsRecorded: session.findings.filter(f => f.phase === session.phase).length,
            }),
          }],
          isError: true,
          details: { reason, phase: session.phase },
        };
      }

      const completion = sessionManager.completePhase(phase, notes);

      const currentIndex = PHASE_ORDER.indexOf(phase);
      const nextPhase = PHASE_ORDER[currentIndex + 1];

      if (nextPhase === "FINAL") {
        sessionManager.setPhase("FINAL");
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              phaseCompleted: phase,
              allPhasesComplete: true,
              summary: `Phase ${PHASE_LABELS[phase]} complete. All audit phases finished. Call gaoyao_finalize for verdict.`,
              nextAction: "Call gaoyao_finalize to generate final verdict.",
            }),
          }],
          details: {
            completedPhase: phase,
            completion,
            findingsSummary: {
              ink: session.findings.filter(f => f.category === "ink").length,
              nose: session.findings.filter(f => f.category === "nose").length,
              foot: session.findings.filter(f => f.category === "foot").length,
              castration: session.findings.filter(f => f.category === "castration").length,
              death: session.findings.filter(f => f.category === "death").length,
            },
          },
        };
      }

      sessionManager.setPhase(nextPhase);
      const updatedSession = sessionManager.load()!;

      const filesForPhase = updatedSession.filesRead.map(f => f.path);
      const findingsForPhase = updatedSession.findings.filter(f => f.phase === nextPhase);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            phaseCompleted: phase,
            nextPhase,
            summary: `Phase ${PHASE_LABELS[phase]} complete. Now starting ${PHASE_LABELS[nextPhase]}.`,
            nextAction: `Analyze files for ${PHASE_LABELS[nextPhase]}, record findings, then call gaoyao_execute_phase --phase ${nextPhase}`,
          }),
        }],
        details: {
          completedPhase: phase,
          nextPhase,
          completion,
          guidance: generatePhaseGuidance(nextPhase, updatedSession.projectContext, filesForPhase, findingsForPhase),
        },
      };
    },
  });

  /**
   * gaoyao_record_finding - Record a finding (PHASE-GUARDED)
   */
  pi.registerTool({
    name: "gaoyao_record_finding",
    label: "Record Finding",
    description: "Record a finding. Must have read the file first (gaoyao_record_file_read). Phase-guarded.",
    parameters: Type.Object({
      category: Type.Union([
        Type.Literal("ink", { description: "墨刑 - Code style" }),
        Type.Literal("nose", { description: "劓刑 - Naming/doc" }),
        Type.Literal("foot", { description: "剕刑 - Architecture" }),
        Type.Literal("castration", { description: "宫刑 - Security" }),
        Type.Literal("death", { description: "大辟 - Critical defect" }),
      ], { description: "Audit category" }),
      severity: Type.Union([
        Type.Literal("critical", { description: "Must fix immediately" }),
        Type.Literal("major", { description: "Should fix before release" }),
        Type.Literal("minor", { description: "Can fix later" }),
      ], { description: "Issue severity" }),
      file: Type.Optional(Type.String({ description: "File path with issue" })),
      line: Type.Optional(Type.Number({ description: "Line number" })),
      issue: Type.String({ description: "Description of the issue" }),
      evidence: Type.Optional(Type.String({ description: "Code snippet or reference" })),
      recommendation: Type.String({ description: "How to fix this issue" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { category, severity, file, line, issue, evidence, recommendation } = params;
      const sessionManager = new AuditSessionManager(ctx.cwd);
      const session = sessionManager.load();

      if (!session) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active audit session. Call gaoyao_init first." }) }],
          isError: true,
          details: { error: "No session" },
        };
      }

      const expectedPhase = PHASE_CATEGORY_MAP[session.phase];
      if (expectedPhase !== category) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `Invalid category '${category}' for current phase '${session.phase}'. Expected category: '${expectedPhase}'`,
              currentPhase: session.phase,
              expectedCategory: expectedPhase,
              providedCategory: category,
            }),
          }],
          isError: true,
          details: { phase: session.phase, expectedCategory: expectedPhase, providedCategory: category },
        };
      }

      if (file && !sessionManager.isFileRead(file)) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `File '${file}' has not been read yet. Call gaoyao_record_file_read --path '${file}' first.`,
              file,
              filesRead: session.filesRead.map(f => f.path),
            }),
          }],
          isError: true,
          details: { file, filesRead: session.filesRead.map(f => f.path) },
        };
      }

      const finding: AuditFinding = {
        category,
        severity,
        file,
        line,
        issue,
        evidence,
        recommendation,
        phase: session.phase,
        recordedAt: new Date().toISOString(),
      };

      sessionManager.addFinding(finding);
      const updatedSession = sessionManager.load()!;
      const findingsInPhase = updatedSession.findings.filter(f => f.phase === session.phase);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            findingRecorded: {
              category,
              severity,
              issue,
              file: file ? `${file}:${line || "?"}` : "N/A",
            },
            phaseFindingsCount: findingsInPhase.length,
            totalFindings: updatedSession.findings.length,
            summary: `Recorded: [${category}] ${severity} - ${issue}${file ? ` (${file}:${line || "?"})` : ""}`,
          }),
        }],
        details: { finding, phase: session.phase, findingsInPhase: findingsInPhase.length },
      };
    },
  });

  /**
   * gaoyao_finalize - Generate final verdict
   */
  pi.registerTool({
    name: "gaoyao_finalize",
    label: "Finalize Audit",
    description: "Generate final verdict and audit report. Requires all phases completed.",
    parameters: Type.Object({
      notes: Type.Optional(Type.String({ description: "Overall assessment notes" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { notes } = params;
      const sessionManager = new AuditSessionManager(ctx.cwd);
      const session = sessionManager.load();

      if (!session) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "No active audit session." }) }],
          isError: true,
          details: { error: "No session" },
        };
      }

      if (session.phase !== "FINAL") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `Audit not complete. Current phase: ${session.phase}. Complete all phases before finalizing.`,
              currentPhase: session.phase,
              remainingPhases: PHASE_ORDER.slice(PHASE_ORDER.indexOf(session.phase) + 1, -1),
            }),
          }],
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
        notes
      );

      const workspacePath = join(ctx.cwd, WORKSPACE_DIR);
      writeFileSync(join(workspacePath, "audit.md"), report);

      sessionManager.delete();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            verdict,
            score,
            totalFindings: session.findings.length,
            byCategory: {
              ink: session.findings.filter(f => f.category === "ink").length,
              nose: session.findings.filter(f => f.category === "nose").length,
              foot: session.findings.filter(f => f.category === "foot").length,
              castration: session.findings.filter(f => f.category === "castration").length,
              death: session.findings.filter(f => f.category === "death").length,
            },
            bySeverity: {
              critical: session.findings.filter(f => f.severity === "critical").length,
              major: session.findings.filter(f => f.severity === "major").length,
              minor: session.findings.filter(f => f.severity === "minor").length,
            },
            summary: `Audit finalized: ${verdict} (${score}%). ${session.findings.length} findings.`,
            action: getVerdictAction(verdict),
          }),
        }],
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

  /**
   * gaoyao_status - Get current audit status
   */
  pi.registerTool({
    name: "gaoyao_status",
    label: "Audit Status",
    description: "Get current audit session status without modifying state.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionManager = new AuditSessionManager(ctx.cwd);
      const session = sessionManager.load();

      if (!session) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              hasSession: false,
              summary: "No active audit session.",
            }),
          }],
          details: { hasSession: false },
        };
      }

      const { canAdvance, reason } = sessionManager.canAdvancePhase();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            hasSession: true,
            sessionId: session.id,
            phase: session.phase,
            phaseLabel: PHASE_LABELS[session.phase],
            reviewMode: session.reviewMode,
            progress: {
              filesEnumerated: session.filesEnumerated.length,
              filesRead: session.filesRead.length,
              findingsTotal: session.findings.length,
              findingsByPhase: {
                ENUMERATE: session.findings.filter(f => f.phase === "ENUMERATE").length,
                INK: session.findings.filter(f => f.phase === "INK").length,
                NOSE: session.findings.filter(f => f.phase === "NOSE").length,
                FOOT: session.findings.filter(f => f.phase === "FOOT").length,
                CASTRATION: session.findings.filter(f => f.phase === "CASTRATION").length,
                DEATH: session.findings.filter(f => f.phase === "DEATH").length,
              },
              phasesCompleted: session.completedPhases.length,
              phasesTotal: 6,
            },
            canAdvance,
            advanceBlockingReason: reason,
            summary: `Phase: ${PHASE_LABELS[session.phase]}. ${session.filesRead.length} files read. ${session.findings.length} findings.`,
          }),
        }],
        details: { session },
      };
    },
  });

  /**
   * gaoyao_reset - Reset audit session
   */
  pi.registerTool({
    name: "gaoyao_reset",
    label: "Reset Audit",
    description: "Reset/clear the current audit session. Use with caution - all progress will be lost.",
    parameters: Type.Object({
      confirm: Type.Boolean({ description: "Must be true to confirm reset" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { confirm } = params;

      if (!confirm) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Reset not confirmed. Pass confirm: true to actually reset.",
            }),
          }],
          isError: true,
          details: { error: "Not confirmed" },
        };
      }

      const sessionManager = new AuditSessionManager(ctx.cwd);
      const session = sessionManager.load();

      if (!session) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              summary: "No session to reset.",
            }),
          }],
          details: {},
        };
      }

      sessionManager.delete();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            summary: `Audit session ${session.id} has been reset.`,
          }),
        }],
        details: { deletedSessionId: session.id },
      };
    },
  });

  // ==========================================================================
  // Legacy tools (deprecated)
  // ==========================================================================

  pi.registerTool({
    name: "gaoyao_review",
    label: "[Deprecated] Full Audit",
    description: "DEPRECATED: Use gaoyao_init instead for phase-guided auditing.",
    parameters: Type.Object({
      plan_name: Type.Optional(Type.String()),
      review_mode: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("full")])),
    }),
    async execute() {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "gaoyao_review is deprecated. Use gaoyao_init instead for phase-guided auditing.",
            hint: "Call gaoyao_init to start a new phase-guided audit session.",
          }),
        }],
        isError: true,
        details: { deprecated: true },
      };
    },
  });

  pi.registerTool({
    name: "gaoyao_quick_check",
    label: "[Deprecated] Quick Check",
    description: "DEPRECATED: Use gaoyao_init with review_mode: 'quick' instead.",
    parameters: Type.Object({
      files: Type.Array(Type.String()),
    }),
    async execute() {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "gaoyao_quick_check is deprecated. Use gaoyao_init with review_mode: 'quick' instead.",
            hint: "Call gaoyao_init --review_mode quick to start a quick audit.",
          }),
        }],
        isError: true,
        details: { deprecated: true },
      };
    },
  });

  pi.registerTool({
    name: "gaoyao_check_security",
    label: "[Deprecated] Security Scan",
    description: "DEPRECATED: Security is now part of phase-guided audit (CASTRATION phase).",
    parameters: Type.Object({
      files: Type.Optional(Type.Array(Type.String())),
    }),
    async execute() {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "gaoyao_check_security is deprecated. Security is now the CASTRATION phase in phase-guided auditing.",
            hint: "Call gaoyao_init, advance through phases to CASTRATION for security analysis.",
          }),
        }],
        isError: true,
        details: { deprecated: true },
      };
    },
  });
}
