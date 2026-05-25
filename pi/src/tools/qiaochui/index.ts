/**
 * QiaoChui Tools (巧倕) - Technical Expert 
 * 
 * Modularized structure:
 * - index.ts: Tool registration (this file)
 * - review-service.ts: MDD plane review logic
 * - decompose-service.ts: Task decomposition logic
 * - types.ts: Shared type definitions
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { FileService } from "../../services/file-service.js";
import { performDeepReview, generateDeepFeasibilityReport } from "./review-service.js";
import { generateMDDTasks, resolveFileConflicts } from "./decompose-service.js";
import { getUserDefaultModel } from "../../utils/model-helper.js";

const WORKSPACE_DIR = ".sages/workspace";

export function registerQiaoChuiTools(pi: ExtensionAPI): void {
  /**
   * qiaochui_review - Review draft for technical feasibility
   * Review Mode (Read-Only): Only read draft.md
   * 
   * Process: Validate structure → Analyze MDD planes → Identify risks → Calculate score
   * Score thresholds: >80 APPROVED, 50-80 REVISE, <50 REJECTED
   */
  pi.registerTool({
    name: "qiaochui_review",
    label: "Review Draft",
    description: "Review draft for technical feasibility (MDD-aligned plane review). Validates structure, analyzes planes, identifies risks, calculates score (0-100). Verdict: APPROVED/REVISE/REJECTED.",
    parameters: Type.Object({
      draft_path: Type.Optional(Type.String({ description: "Path to draft.md (default: .sages/workspace/draft.md)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const fileService = new FileService(cwd);
      const draft_filename = params.draft_path ? params.draft_path.replace(`${WORKSPACE_DIR}/`, "") : "draft.md";

      try {
        // Validate path to prevent traversal
        if (!fileService.validatePath(draft_filename)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Invalid path: ${draft_filename}` } }) }],
            isError: true,
            details: { draft_filename },
          };
        }

        // Use FileService for safe file reading
        const content = fileService.read(draft_filename);
        
        if (!content) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Draft not found: ${draft_filename}` } }) }],
            isError: true,
            details: { draft_filename },
          };
        }

        // Perform deep MDD-aligned plane review
        const deepResult = performDeepReview(content);

        // Generate detailed feasibility report
        const feasibilityReport = generateDeepFeasibilityReport(deepResult);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              verdict: deepResult.overallStatus,
              score: deepResult.score,
              implementationComplexity: deepResult.implementationComplexity,
              estimatedHours: deepResult.estimatedHours,
              planeCount: deepResult.planeAssessments.length,
              blockers: deepResult.blockers.length,
              recommendations: deepResult.recommendations.slice(0, 5),
              feasibilityReport,
            }),
          }],
          details: { draft_filename, ...deepResult },
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
   * qiaochui_decompose - Decompose approved design into tasks
   * Prerequisites: qiaochui_review completed, score > 80
   * Creates: plan.md (task descriptions), execution.yaml (task config with dependencies)
   */
  pi.registerTool({
    name: "qiaochui_decompose",
    label: "Decompose",
    description: "Decompose design into tasks. Creates plan.md and execution.yaml with MDD plane classification, priorities, dependencies.",
    parameters: Type.Object({
      draft_path: Type.Optional(Type.String({ description: "Path to draft.md (default: .sages/workspace/draft.md)" })),
      max_tasks: Type.Optional(Type.Number({ description: "Maximum number of tasks to generate (default: 10, max: 20)" })),
      use_subagent: Type.Optional(Type.Boolean({ description: "Use isolated subagent mode for parallel execution (default: true)" })),
      max_parallel: Type.Optional(Type.Number({ description: "Maximum parallel subagents (default: 3)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const fileService = new FileService(cwd);
      const draft_filename = params.draft_path ? params.draft_path.replace(`${WORKSPACE_DIR}/`, "") : "draft.md";
      const max_tasks = params.max_tasks || 10;
      const use_subagent = params.use_subagent !== false;
      const max_parallel = params.max_parallel || 3;

      try {
        // Validate path to prevent traversal
        if (!fileService.validatePath(draft_filename)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Invalid path: ${draft_filename}` } }) }],
            isError: true,
            details: { draft_filename },
          };
        }

        // Read draft content
        const content = fileService.read(draft_filename);
        
        if (!content) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Draft not found: ${draft_filename}` } }) }],
            isError: true,
            details: { draft_filename },
          };
        }

        const workspacePath = fileService.getWorkspacePath();

        // Extract plan name from draft
        const planName = extractPlanName(content) || "workflow";
        
        // Generate tasks with MDD plane classification
        const tasks = generateMDDTasks(content, max_tasks);

        // Resolve file conflicts - tasks editing the same file become sequential
        const tasksWithResolvedConflicts = resolveFileConflicts(tasks);

        // Build plan markdown
        let planMarkdown = `# Task Plan

Generated by: QiaoChui (巧倕) - Technical Expert
Timestamp: ${new Date().toISOString()}
Plan: ${planName}

## MDD Task Breakdown

| ID | Description | Plane | Priority | Dependencies |
|----|-------------|-------|----------|--------------|
`;
        for (const task of tasksWithResolvedConflicts) {
          planMarkdown += `| ${task.id} | ${task.description} | ${task.plane} | ${task.priority} | ${task.dependsOn.join(", ") || "-"} |\n`;
        }

        planMarkdown += `\n## Task Details\n\n`;
        for (const task of tasksWithResolvedConflicts) {
          planMarkdown += `### ${task.id}: ${task.description}\n`;
          planMarkdown += `- **Plane**: ${task.plane}\n`;
          planMarkdown += `- **Priority**: ${task.priority}\n`;
          if (task.dependsOn.length > 0) {
            planMarkdown += `- **Depends on**: ${task.dependsOn.join(", ")}\n`;
          }
          if (task.files && task.files.length > 0) {
            planMarkdown += `- **Files**: ${task.files.join(", ")}\n`;
          }
          planMarkdown += "\n";
        }

        const totalTime = tasksWithResolvedConflicts.length * 10;
        planMarkdown += `## Total Estimated Time: ${totalTime} minutes\n`;

        // Build execution YAML (model will be set by SubagentExecutor from user settings)
        const executionYaml = `# Execution Plan
# Generated by QiaoChui (巧倕) - Technical Expert
# Plan: ${planName}
# Created: ${new Date().toISOString()}

name: ${planName}

settings:
  maxParallel: ${max_parallel}
  useSubagent: ${use_subagent}
  maxRetry: 1
  autoCommit: true
  subagentConfig:
    skills:
      - luban
    maxContext: 4000
    timeout: 300

tasks:
${tasksWithResolvedConflicts.map((t) => `  - id: ${t.id}
    description: "${t.description}"
    plane: ${t.plane}
    priority: ${t.priority === "high" ? 1 : t.priority === "medium" ? 2 : 3}
    dependsOn: [${t.dependsOn.map(d => `"${d}"`).join(", ")}]
    files: [${(t.files || []).map(f => `"${f}"`).join(", ")}]`).join("\n")}
`;

        const planPath = "plan.md";
        const executionPath = "execution.yaml";

        fileService.write(planPath, planMarkdown);
        fileService.write(executionPath, executionYaml);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              plan_name: planName,
              plan_path: join(workspacePath, planPath),
              execution_path: join(workspacePath, executionPath),
              task_count: tasksWithResolvedConflicts.length,
              estimated_time: totalTime,
              planes: [...new Set(tasksWithResolvedConflicts.map(t => t.plane))],
              execution_mode: {
                use_subagent: use_subagent,
                max_parallel: max_parallel,
                description: use_subagent
                  ? "Isolated subagent mode - each task runs in a separate pi process"
                  : "Shared context mode - all tasks share the same context",
              },
              workspace: workspacePath,
              note: "Tasks stored in execution.yaml (not tasks.json)",
            }),
          }],
          details: { planName, planPath: join(workspacePath, planPath), executionPath: join(workspacePath, executionPath), taskCount: tasksWithResolvedConflicts.length, useSubagent: use_subagent, maxParallel: max_parallel },
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
}

/**
 * Extract plan name from draft content
 */
function extractPlanName(content: string): string | null {
  const match = content.match(/^#\s*System Design:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}
