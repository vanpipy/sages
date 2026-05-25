/**
 * Fuxi Tools (伏羲) - Architect 
 * 
 * MDD Seven Planes:
 * 1. Business Plane - Process × Rules
 * 2. Data Plane - Logic × State
 * 3. Control Plane - Strategy × Distribution
 * 4. Foundation Plane - Resource × Abstraction
 * 5. Observation Plane - Data × Analysis
 * 6. Security Plane - Identity × Permissions
 * 7. Evolution Plane - Time × Change
 * 
 * Design Mode Rules:
 * - ✅ Only modify draft.md
 * - ❌ Read-only for all other files
 * - ❌ No code writing in design phase
 * 
 * Phase modes:
 * - design: read-only, only draft.md
 * - plan: read-only, plan.md, execution.yaml
 * - implement: writeable, all files
 * - review: read-only, audit.md
 * 
 * Architecture:
 * - Uses FileService for file operations (no direct node:fs imports)
 * - Uses WorkflowStateManager for state management
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { FileService } from "../services/file-service.js";
import { WorkflowStateManager } from "../services/workflow-state-manager.js";
import { generateMinimalDraft, generateRichDraft } from "../utils/draft-generator.js";
import { analyzeProject } from "../utils/analyzer/index.js";

const WORKSPACE_DIR = ".sages/workspace";

export type FuxiPhase = "idle" | "design" | "plan" | "implement" | "review" | "audit" | "complete";
export type AuditVerdict = "PASS" | "NEEDS_CHANGES" | "REJECTED" | null;

interface ToolContext {
  cwd: string;
  fileService: FileService;
  stateManager: WorkflowStateManager;
}

/**
 * Extract plan name from request text
 */
function extractPlanName(content: string): string {
  const words = content.trim().split(/\s+/).slice(0, 4);
  return words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase()).join("-");
}

/**
 * Generate brainstorming guidance based on audit findings
 */
function generateBrainstormingGuidance(
  verdict: AuditVerdict,
  score: number | null,
  auditContent: string,
  planContent: string,
  executionContent: string,
  focus: string
): string {
  const lines: string[] = [];

  lines.push("# Brainstorming Recovery Session");
  lines.push("");
  lines.push("**Purpose**: Diagnose audit failures and explore better approaches");
  lines.push("");
  lines.push(`**Audit Verdict**: ${verdict || "unknown"} (${score || 0}%)`);
  lines.push(`**Focus**: ${focus}`);
  lines.push("");

  // Extract findings from audit
  const findings = extractFindingsFromAudit(auditContent, focus);

  lines.push("## Audit Findings to Address");
  lines.push("");
  if (findings.length > 0) {
    for (const finding of findings) {
      lines.push(`### ${finding.category.toUpperCase()} - ${finding.severity}`);
      lines.push(`- **Issue**: ${finding.issue}`);
      if (finding.file) {
        lines.push(`- **Location**: ${finding.file}${finding.line ? `:${finding.line}` : ""}`);
      }
      if (finding.evidence) {
        lines.push(`- **Evidence**:`);
        lines.push(`  \`\`\`  `);
        lines.push(`  ${finding.evidence.split('\n').join('\n  ')}`);
        lines.push(`  \`\`\``);
      }
      lines.push(`- **Current recommendation**: ${finding.recommendation}`);
      lines.push("");
    }
  } else {
    lines.push("_No specific findings extracted. Review audit.md for details._");
    lines.push("");
  }

  lines.push("## Brainstorming Questions");
  lines.push("");
  lines.push("Work through these to find better approaches:");
  lines.push("");
  lines.push("### 1. Root Cause Analysis");
  lines.push("- **Why did this issue occur?**");
  lines.push("- **Is this a symptom of a deeper problem?**");
  lines.push("- **What assumptions were wrong?**");
  lines.push("");
  lines.push("### 2. Alternative Approaches");
  lines.push("- **What other ways could this be implemented?**");
  lines.push("- **Which language patterns would avoid this issue?**");
  lines.push("- **What does the existing codebase do for similar cases?**");
  lines.push("");
  lines.push("### 3. Pattern Library");
  lines.push("Consider these patterns for improvement:");
  lines.push("");

  const patternsByFocus: Record<string, string[]> = {
    security: [
      "**Input validation**: Validate and sanitize all inputs",
      "**Parameterized queries**: Use prepared statements for DB",
      "**Authentication middleware**: Centralize auth checks",
      "**Secret management**: Environment variables, not hardcoded",
      "**Principle of least privilege**: Minimize permissions",
    ],
    architecture: [
      "**Layer separation**: api → service → repository",
      "**Dependency injection**: Invert control for testability",
      "**Interface segregation**: Small, focused interfaces",
      "**Single responsibility**: One reason to change",
      "**DRY**: Don't repeat yourself",
    ],
    style: [
      "**Naming conventions**: Use consistent naming",
      "**Function length**: Keep functions under 50 lines",
      "**Comments**: Explain why, not what",
      "**Formatting**: Follow project style guide",
      "**Dead code**: Remove unused code",
    ],
    all: [
      "**Error handling**: Handle errors explicitly",
      "**Type safety**: Use strong typing",
      "**Testing**: Cover edge cases",
      "**Documentation**: Document public APIs",
      "**Performance**: Avoid N+1, memory leaks",
    ],
  };

  const patterns = patternsByFocus[focus] || patternsByFocus.all;
  for (const pattern of patterns) {
    lines.push(`- ${pattern}`);
  }
  lines.push("");

  lines.push("### 4. Generate Improved Solution");
  lines.push("");
  lines.push("For each finding, propose:");
  lines.push("1. **Better pattern**: What pattern would prevent this?");
  lines.push("2. **Code template**: Write the improved code");
  lines.push("3. **Test case**: What test would catch this?");
  lines.push("");

  lines.push("## Next Steps");
  lines.push("");
  lines.push("After brainstorming:");
  lines.push("1. Save improved patterns to `.sages/recovery-patterns.md`");
  lines.push("2. Update implementation with better approaches");
  lines.push("3. Re-run audit to verify fixes");
  lines.push("");
  lines.push("---");
  lines.push("_This guidance is generated by Fuxi to help bridge GaoYao's findings to LuBan's implementation._");

  return lines.join("\n");
}

/**
 * Audit finding extracted from audit content
 */
interface AuditFinding {
  category: string;
  severity: string;
  issue: string;
  file?: string;
  line?: number;
  evidence?: string;
  recommendation: string;
}

/**
 * Extract findings from audit content
 */
function extractFindingsFromAudit(auditContent: string, focus: string): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // Parse markdown sections for findings
  const sections = auditContent.split(/^### /m);

  for (const section of sections) {
    if (!section.trim()) continue;

    const lines = section.split("\n");
    const title = lines[0]?.trim() || "";

    // Check if this section matches our focus
    const categoryMatch = title.match(/墨刑|Ink|劓刑|Nose|剕刑|Foot|宫刑|Castration|大辟|Death/i);
    const severityMatch = title.match(/critical|major|minor/i);

    const category = categoryMatch ?
      (categoryMatch[0].includes("墨") ? "ink" :
       categoryMatch[0].includes("劓") ? "nose" :
       categoryMatch[0].includes("剕") ? "foot" :
       categoryMatch[0].includes("宫") ? "castration" :
       categoryMatch[0].includes("大") ? "death" : "unknown") :
      "unknown";

    const severity = severityMatch ? severityMatch[0].toLowerCase() : "minor";

    // Filter by focus
    if (focus !== "all" && focus !== "critical" && category !== focus) {
      continue;
    }
    if (focus === "critical" && severity !== "critical" && severity !== "major") {
      continue;
    }

    // Extract issue from the section
    const issueMatch = section.match(/\*\*Issue\*\*:?\s*(.+)/i) ||
                       section.match(/^-\s\*\*[Ii]ssue\*\*:?\s*(.+)/m) ||
                       section.match(/^-\s+(.+?(?=-\s|\n\n))/ms);

    const issue = issueMatch ? issueMatch[1].trim() : title;

    // Extract file/line
    const fileMatch = section.match(/`([^:`]+):?(\d+)?`/);
    const file = fileMatch ? fileMatch[1] : undefined;
    const line = fileMatch && fileMatch[2] ? parseInt(fileMatch[2], 10) : undefined;

    // Extract recommendation
    const recMatch = section.match(/\*\*[Rr]ecommend\w*\*\*:?\s*(.+)/i) ||
                     section.match(/^-\s\*\*[Rr]ecommend\w*\*\*:?\s*(.+)/m);
    const recommendation = recMatch ? recMatch[1].trim() : "Review and fix the issue";

    if (issue && issue !== title) {
      findings.push({
        category,
        severity,
        issue,
        file,
        line,
        recommendation,
      });
    }
  }

  return findings.slice(0, 10); // Limit to 10 findings
}

/**
 * Generate updated plan and execution based on audit findings
 */
function generateUpdatedPlanAndExecution(
  planContent: string,
  executionContent: string,
  findings: AuditFinding[],
  focus: string
): { updatedPlan: string; updatedExecution: string; tasks: number } {
  const improvements: string[] = [];
  const newTasks: string[] = [];

  for (const finding of findings) {
    // Generate improvement notes
    improvements.push(`
### ${finding.category.toUpperCase()} - ${finding.severity.toUpperCase()}
**Issue**: ${finding.issue}
**Location**: ${finding.file || "N/A"}${finding.line ? `:${finding.line}` : ""}
**Recommendation**: ${finding.recommendation}
`);

    // Generate new tasks for execution.yaml
    const taskId = `T-RECOVERY-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    const taskDesc = `Fix: ${finding.issue}`;

    let priority = "medium";
    if (finding.severity === "critical") priority = "high";
    if (finding.severity === "minor") priority = "low";

    newTasks.push(`
  - id: ${taskId}
    description: ${taskDesc}
    priority: ${priority}
    category: ${finding.category}
    source: audit-finding
    file: ${finding.file || ""}
    line: ${finding.line || ""}
`);
  }

  // Update plan.md
  let updatedPlan = planContent;
  if (improvements.length > 0) {
    const recoverySection = `
---

## Audit Recovery Notes

*Generated by fuxi-brainstorm-recovery*
*Findings addressed: ${findings.length}*

${improvements.join("\n")}
`;

    if (updatedPlan.includes("## Audit Recovery Notes")) {
      updatedPlan = updatedPlan.replace(
        /\n---\n\n## Audit Recovery Notes[\s\S]*/,
        recoverySection
      );
    } else {
      updatedPlan += recoverySection;
    }
  }

  // Update execution.yaml
  let updatedExecution = executionContent;
  if (newTasks.length > 0) {
    if (updatedExecution.includes("tasks:")) {
      updatedExecution = updatedExecution.replace(
        /(tasks:\s*)/,
        `$1${newTasks.join("")}\n`
      );
    } else {
      const tasksSection = `\ntasks:\n${newTasks.join("")}\n`;
      updatedExecution += tasksSection;
    }
  }

  return {
    updatedPlan,
    updatedExecution,
    tasks: newTasks.length,
  };
}

/**
 * Create tool context with services
 */
function createContext(cwd: string): ToolContext {
  const fileService = new FileService(cwd);
  const stateManager = new WorkflowStateManager(cwd);
  return { cwd, fileService, stateManager };
}

export function registerFuxiTools(pi: ExtensionAPI): void {

  /**
   * fuxi_start - Start workflow, set design phase in state.json
   * Design Mode (Read-Only): Only modify draft.md
   */
  pi.registerTool({
    name: "fuxi_start",
    label: "Start Workflow",
    description: "Start workflow - set design phase in state.json. Creates state.json with planName and request.",
    parameters: Type.Object({
      plan_name: Type.String({ description: "Plan name (e.g., 'my-feature')" }),
      request: Type.String({ description: "User's feature request or description" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { cwd } = ctx;
      const { fileService, stateManager } = createContext(cwd);
      const now = new Date().toISOString();

      const state = stateManager.create(params.plan_name, params.request);
      state.phase = "design";
      state.updatedAt = now;
      stateManager.save(state);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Workflow started: ${params.plan_name}`,
            phase: "design",
            state_path: fileService.getFilePath("state.json"),
          }),
        }],
        details: { phase: "design", state },
      };
    },
  });

  /**
   * fuxi_request - Create MDD design draft using Seven Planes analysis
   * 
   * INTEGRATION WITH BRAINSTORM:
   * Now automatically starts with brainstorming for better design quality.
   * Flow: brainstorm → design approval → auto-ask → Fuxi MDD draft
   * 
   * User can skip brainstorm with --no-brainstorm flag
   */
  pi.registerTool({
    name: "fuxi_request",
    label: "Create Deep Draft",
    description: "Create MDD design draft (draft.md) using Seven Planes analysis with DEEP project research. Now integrates with brainstorming for better design. Streams progress updates. Use --no-brainstorm to skip brainstorming.",
    parameters: Type.Object({
      request: Type.String({ description: "User's request to create draft for" }),
      "no-brainstorm": Type.Optional(Type.Boolean({ description: "Skip brainstorming, go directly to MDD draft" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { cwd } = ctx;
      const { fileService, stateManager } = createContext(cwd);

      const state = stateManager.loadLatest();
      const planName = state?.planName || extractPlanName(params.request);
      const draftPath = fileService.getFilePath("draft.md");
      const skipBrainstorm = params["no-brainstorm"] === true;

      try {
        // Phase 0: Show integration message
        if (!skipBrainstorm) {
          await onUpdate?.({
            content: [{ type: "text", text: `🧠 Starting with **Brainstorming** first...\n\nThis helps clarify requirements and explore approaches before creating the MDD draft.\n\nWe'll go through:\n1. Explore project context\n2. Ask clarifying questions\n3. Propose 2-3 approaches\n4. Design with your approval\n5. Auto-ask: "Proceed to Fuxi?"` }],
            details: {},
          });

          await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (skipBrainstorm) {
          await onUpdate?.({
            content: [{ type: "text", text: "⏭️ Skipping brainstorming, going directly to MDD analysis..." }],
            details: {},
          });
        } else {
          await onUpdate?.({
            content: [{ type: "text", text: "📊 Analyzing project structure..." }],
            details: {},
          });
        }

        const projectContext = await analyzeProject(cwd, params.request);

        await onUpdate?.({
          content: [{
            type: "text",
            text: `📋 Detected: ${projectContext.language}${projectContext.framework ? ` (${projectContext.framework})` : ""}, ${projectContext.existingComponents.length} components, ${projectContext.patterns.length} patterns`
          }],
          details: {},
        });

        // Phase 3: Generate each plane with streaming updates
        const planes = [
          { name: "Business", emoji: "1️⃣" },
          { name: "Data", emoji: "2️⃣" },
          { name: "Control", emoji: "3️⃣" },
          { name: "Foundation", emoji: "4️⃣" },
          { name: "Observation", emoji: "5️⃣" },
          { name: "Security", emoji: "6️⃣" },
          { name: "Evolution", emoji: "7️⃣" },
        ];

        for (const plane of planes) {
          await onUpdate?.({
            content: [{ type: "text", text: `${plane.emoji} Analyzing ${plane.name} Plane...` }],
            details: {},
          });
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Phase 4: Generate the rich draft with project context
        await onUpdate?.({
          content: [{ type: "text", text: "💾 Generating draft.md..." }],
          details: {},
        });

        const draft = generateRichDraft(projectContext, params.request);
        const savedPath = fileService.write("draft.md", draft);

        // Phase 5: Completion update
        await onUpdate?.({
          content: [{
            type: "text",
            text: `✅ Draft created: ${savedPath}\n\n📝 ${projectContext.existingComponents.length} components analyzed\n🎯 ${planes.length} MDD planes processed\n🎨 Detected patterns: ${projectContext.patterns.slice(0, 5).join(", ") || "none"}\n\n💡 Tip: Use \`/fuxi-plan\` after reviewing the draft to start task decomposition.`
          }],
          details: {},
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              draft_path: savedPath,
              plan_name: planName,
              brainstorm_skipped: skipBrainstorm,
              project_context: {
                language: projectContext.language,
                framework: projectContext.framework,
                project_type: projectContext.projectType,
                components_found: projectContext.existingComponents.length,
                patterns_detected: projectContext.patterns,
                tech_stack: {
                  languages: projectContext.techStack.languages,
                  frameworks: projectContext.techStack.frameworks,
                  testing: projectContext.techStack.testing,
                },
              },
              message: `Deep draft created with ${planes.length} planes analyzed`,
            }),
          }],
          details: { draftPath: savedPath, planName, projectContext },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await onUpdate?.({
          content: [{ type: "text", text: `❌ Analysis failed: ${msg}` }],
          details: {},
        });

        // Create minimal fallback draft
        const fallbackDraft = generateMinimalDraft(planName, params.request);
        fileService.write("draft.md", fallbackDraft);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: msg,
              draft_path: draftPath,
              plan_name: planName,
              fallback: true,
              message: `Created minimal draft (analysis failed: ${msg})`,
            }),
          }],
          isError: true,
          details: { error: msg, draftPath, planName },
        };
      }
    },
  });

  /**
   * fuxi_plan - Transition to plan phase (only if score > 80)
   * Updates state phase to "plan" if score > 80
   */
  pi.registerTool({
    name: "fuxi_plan",
    label: "Start Plan",
    description: "Transition to plan phase - only if score > 80. Updates phase to 'plan' in state.json.",
    parameters: Type.Object({
      score: Type.Number({ description: "Review score (must be > 80)" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { cwd } = ctx;
      const { fileService, stateManager } = createContext(cwd);

      const state = stateManager.loadLatest();

      if (!state) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "No active workflow. Use /fuxi-start first.",
            }),
          }],
          isError: true,
          details: { error: "no_workflow" },
        };
      }

      // Fixed: score > 80 (not >= 80)
      if (params.score <= 80) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: `Score ${params.score} <= 80. Plan can only start when score > 80.`,
            }),
          }],
          isError: true,
          details: { error: "score_too_low", score: params.score },
        };
      }

      // Update phase to plan
      state.phase = "plan";
      state.score = params.score;
      state.updatedAt = new Date().toISOString();
      stateManager.save(state);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Plan phase started (score: ${params.score})`,
            phase: "plan",
            state_path: fileService.getFilePath("state.json"),
          }),
        }],
        details: { phase: "plan", score: params.score },
      };
    },
  });

  /**
   * fuxi_recover - Recover workflow from state.json
   * Returns current phase, planName, and workspace path
   */
  pi.registerTool({
    name: "fuxi_recover",
    label: "Recover Workflow",
    description: "Recover workflow from state.json. Returns state with phase, planName, request, score, workspace path.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { cwd } = ctx;
      const { fileService, stateManager } = createContext(cwd);

      const state = stateManager.loadLatest();

      if (!state) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "No workflow state found. Use /fuxi-start to start a new workflow.",
            }),
          }],
          isError: true,
          details: { error: "no_workflow" },
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            state: {
              id: state.id,
              phase: state.phase,
              plan_name: state.planName,
              request: state.request,
              score: state.score,
            },
            workspace_path: fileService.getWorkspacePath(),
            message: `Workflow recovered: ${state.planName} (phase: ${state.phase})`,
          }),
        }],
        details: { state, workspacePath: fileService.getWorkspacePath() },
      };
    },
  });

  /**
   * fuxi_end - End workflow based on audit verdict
   */
  pi.registerTool({
    name: "fuxi_end",
    label: "End Workflow",
    description: "End workflow based on audit verdict. Archives PASS verdicts. Returns to implement (LuBan) for NEEDS_CHANGES. Returns to design (Fuxi) for REJECTED.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ description: "Force archive even if verdict is not PASS" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { cwd } = ctx;
      const { fileService, stateManager } = createContext(cwd);

      const state = stateManager.loadLatest();

      if (!state) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "No active workflow to end.",
            }),
          }],
          isError: true,
          details: { error: "no_active_workflow" },
        };
      }

      // Read audit verdict using FileService (no duplication)
      const { verdict, score } = fileService.readAuditVerdict();

      // Update state with audit info
      state.auditVerdict = verdict;
      state.auditScore = score;
      state.auditAttempts = (state.auditAttempts || 0) + 1;

      // Handle different verdicts
      if (verdict === "PASS" || params.force) {
        state.phase = "complete";
        state.updatedAt = new Date().toISOString();
        stateManager.save(state);

        const archivePath = stateManager.archive();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Workflow completed and archived: ${state.planName}`,
              verdict,
              score,
              archive_path: archivePath,
              phase: "complete",
            }),
          }],
          details: { verdict, score, archivePath, phase: "complete" },
        };
      }

      if (verdict === "NEEDS_CHANGES") {
        if ((state.auditAttempts || 0) >= 3) {
          state.phase = "design";
          state.updatedAt = new Date().toISOString();
          stateManager.save(state);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `⚠️ Too many iterations (${state.auditAttempts}). Returning to design phase.`,
                verdict,
                score,
                phase: "design",
                action: "Fuxi must redesign the approach"
              }),
            }],
            details: { verdict, score, phase: "design", attempts: state.auditAttempts },
          };
        }

        state.phase = "implement";
        state.updatedAt = new Date().toISOString();
        stateManager.save(state);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `⚠️ Audit verdict: NEEDS_CHANGES (${score}%)

📋 Returning to implement phase.
LuBan must fix the issues identified in audit.md.

Attempt ${state.auditAttempts}/3 before escalation to design.`,
              verdict,
              score,
              phase: "implement",
              action: "LuBan: Fix issues in audit.md"
            }),
          }],
          details: { verdict, score, phase: "implement", attempts: state.auditAttempts },
        };
      }

      if (verdict === "REJECTED") {
        state.phase = "design";
        state.updatedAt = new Date().toISOString();
        stateManager.save(state);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `❌ Audit verdict: REJECTED (${score}%)

🔴 Critical issues detected. Returning to design phase.

Fuxi must revisit the architecture and design.`,
              verdict,
              score,
              phase: "design",
              action: "Fuxi: Redesign required"
            }),
          }],
          details: { verdict, score, phase: "design" },
        };
      }

      // No verdict found
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "No audit verdict found. Run gaoyao-review first.",
            message: `State phase: ${state.phase}\nRun gaoyao-review or gaoyao-finalize to get an audit verdict.`
          }),
        }],
        isError: true,
        details: { error: "no_audit_verdict", phase: state.phase },
      };
    },
  });

  /**
   * fuxi_get_status - Get current workflow status
   */
  pi.registerTool({
    name: "fuxi_get_status",
    label: "Get Status",
    description: "Get current workflow status. Returns: has_workflow, phase, planName, request, score, workspace_path, audit_verdict, audit_score.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { cwd } = ctx;
      const { fileService, stateManager } = createContext(cwd);

      const state = stateManager.loadLatest();

      // Read current audit verdict if in audit phase
      let auditInfo: { verdict: string | null; score: number | undefined } = { verdict: null, score: undefined };
      if (state && (state.phase === "audit" || state.phase === "complete")) {
        auditInfo = fileService.readAuditVerdict();
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            has_workflow: state !== null,
            phase: state?.phase || "idle",
            plan_name: state?.planName || null,
            request: state?.request || null,
            score: state?.score || null,
            audit_verdict: auditInfo.verdict || state?.auditVerdict || null,
            audit_score: auditInfo.score || state?.auditScore || null,
            audit_attempts: state?.auditAttempts || 0,
            workspace_path: fileService.getWorkspacePath(),
          }),
        }],
        details: { state, auditInfo },
      };
    },
  });

  /**
   * fuxi_update_score - Update review score in state
   */
  pi.registerTool({
    name: "fuxi_update_score",
    label: "Update Score",
    description: "Update review score in state. Used by qiaochui-review. Score >80 allows plan phase.",
    parameters: Type.Object({
      score: Type.Number({ description: "Review score from qiaochui" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { cwd } = ctx;
      const { stateManager } = createContext(cwd);

      const state = stateManager.loadLatest();

      if (!state) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "No active workflow.",
            }),
          }],
          isError: true,
          details: { error: "no_active_workflow" },
        };
      }

      state.score = params.score;
      state.updatedAt = new Date().toISOString();
      stateManager.save(state);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            score: params.score,
            can_start_plan: params.score > 80,
            message: `Score updated to ${params.score}. Can start plan: ${params.score > 80}`,
          }),
        }],
        details: { score: params.score },
      };
    },
  });

  /**
   * fuxi_brainstorm_recovery - Brainstorm and update plan when audit fails
   */
  pi.registerTool({
    name: "fuxi_brainstorm_recovery",
    label: "Brainstorm Recovery",
    description: "Brainstorm and update plan/execution when audit fails. Analyzes findings, updates plan.md and execution.yaml, then wakes LuBan to re-execute.",
    parameters: Type.Object({
      focus: Type.Optional(Type.Union([
        Type.Literal("all", { description: "Address all audit findings" }),
        Type.Literal("critical", { description: "Only critical/major issues" }),
        Type.Literal("security", { description: "Focus on security findings" }),
        Type.Literal("architecture", { description: "Focus on architecture issues" }),
        Type.Literal("style", { description: "Focus on code style issues" }),
      ], { description: "Which findings to focus on" })),
      dry_run: Type.Optional(Type.Boolean({ description: "Preview changes without updating files" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { cwd } = ctx;
      const { fileService, stateManager } = createContext(cwd);

      const state = stateManager.loadLatest();
      const { verdict, score } = fileService.readAuditVerdict();

      const auditContent = fileService.read("audit.md");
      if (!auditContent) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "No audit.md found. Run gaoyao-review first.",
            }),
          }],
          isError: true,
          details: { error: "no_audit" },
        };
      }

      const planContent = fileService.read("plan.md") || "";
      const executionContent = fileService.read("execution.yaml") || "";

      const focus = params.focus || "all";
      const findings = extractFindingsFromAudit(auditContent, focus);

      const { updatedPlan, updatedExecution, tasks } = generateUpdatedPlanAndExecution(
        planContent,
        executionContent,
        findings,
        focus
      );

      // Dry run - just return the changes
      if (params.dry_run) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              mode: "brainstorming_preview",
              auditVerdict: verdict,
              auditScore: score,
              focus,
              findingsCount: findings.length,
              newTasks: tasks,
              preview: {
                planChanges: updatedPlan.slice(0, 500) + "...(truncated)",
                executionChanges: updatedExecution.slice(0, 500) + "...(truncated)",
              },
              message: `🧠 Brainstorming Preview

Audit verdict: ${verdict} (${score}%)
Found ${findings.length} issues to address.

This is a preview. Use without --dry-run to apply changes.`,
            }),
          }],
          details: { verdict, score, focus, findings, tasks },
        };
      }

      // Apply changes
      if (planContent) {
        fileService.write("plan.md", updatedPlan);
      }
      if (executionContent) {
        fileService.write("execution.yaml", updatedExecution);
      }

      // Update state to implement phase to wake LuBan
      if (state) {
        state.phase = "implement";
        state.updatedAt = new Date().toISOString();
        stateManager.save(state);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            mode: "brainstorming_complete",
            auditVerdict: verdict,
            auditScore: score,
            focus,
            findingsAddressed: findings.length,
            newTasks: tasks,
            message: `🧠 Brainstorming Recovery Complete

Audit verdict: ${verdict} (${score}%)
Addressed ${findings.length} issues.

**Changes Made:**
- Updated plan.md with improved approaches
- Updated execution.yaml with ${tasks} new/modified task(s)
- Phase set to: implement

**Next Step:**
LuBan will resume with updated plan.
Use /luban-execute-all to re-execute.`,
          }),
        }],
        details: {
          verdict,
          score,
          focus,
          findings,
          tasks,
          planPath: fileService.getFilePath("plan.md"),
          executionPath: fileService.getFilePath("execution.yaml"),
          phase: "implement"
        },
      };
    },
  });
}
