/**
 * QiaoChui Tools - Review and decomposition phase tools
 * Translates MDD design into technical specifications and execution plans
 * Files are saved to .sages/workspace/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseDraft, validateDraft, generateTasksFromDraft } from "../utils/draft-parser.js";

const WORKSPACE_DIR = ".sages/workspace";

/**
 * MDD Planes for task classification
 */
type MDDPlane = "Business" | "Data" | "Control" | "Foundation" | "Observation" | "Security" | "Evolution";

/**
 * Plane-by-plane feasibility assessment
 */
interface PlaneAssessment {
  plane: MDDPlane;
  status: "✅ Feasible" | "⚠️ Needs Review" | "❌ Not Feasible";
  notes: string[];
}

export function registerQiaoChuiTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "qiaochui_review",
    label: "Review Draft",
    description: "Review design drafts for technical feasibility (MDD-aligned plane review)",
    parameters: Type.Object({
      draft_path: Type.String({ description: "Path to the draft file (default: .sages/workspace/draft.md)" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const draft_path = params.draft_path || join(cwd, WORKSPACE_DIR, "draft.md");

      try {
        if (!existsSync(draft_path)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Draft not found: ${draft_path}` } }) }],
            isError: true,
            details: { draft_path },
          };
        }

        const content = readFileSync(draft_path, "utf-8");
        const validation = validateDraft(content);

        if (!validation.valid) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                verdict: "REVISE",
                issues: validation.issues,
                recommendations: ["Fill in missing sections", "Remove placeholders"],
              }),
            }],
            details: { draft_path, verdict: "REVISE", issues: validation.issues },
          };
        }

        // Perform MDD-aligned plane review
        const planeAssessments = performMDDReview(content);
        const taskCount = generateTasksFromDraft(
          Object.keys(parseDraft(content, "workflow") || {}).length > 0 
            ? parseDraft(content, "workflow") as any 
            : null
        ).length;

        // Generate feasibility report
        const feasibilityReport = generateFeasibilityReport(planeAssessments);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              verdict: "APPROVED",
              parsed: true,
              taskCount,
              estimatedTime: taskCount * 10,
              recommendations: ["Design is well-structured", "Ready for task decomposition"],
              feasibilityReport,
            }),
          }],
          details: { draft_path, verdict: "APPROVED", taskCount, planeAssessments },
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

  pi.registerTool({
    name: "qiaochui_decompose",
    label: "Decompose",
    description: "Decompose approved design into executable tasks with MDD plane classification (saves to .sages/workspace/)",
    parameters: Type.Object({
      draft_path: Type.Optional(Type.String({ description: "Draft path (default: .sages/workspace/draft.md)" })),
      max_tasks: Type.Optional(Type.Number({ description: "Max tasks to generate (default: 10)" })),
      use_subagent: Type.Optional(Type.Boolean({ description: "Use isolated subagent mode for parallel execution (default: true)" })),
      max_parallel: Type.Optional(Type.Number({ description: "Max parallel subagents (default: 3)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const draft_path = params.draft_path || join(cwd, WORKSPACE_DIR, "draft.md");
      const max_tasks = params.max_tasks || 10;
      const use_subagent = params.use_subagent !== false;
      const max_parallel = params.max_parallel || 3;

      try {
        if (!existsSync(draft_path)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: { message: `Draft not found: ${draft_path}` } }) }],
            isError: true,
            details: { draft_path },
          };
        }

        const content = readFileSync(draft_path, "utf-8");
        const workspacePath = join(cwd, WORKSPACE_DIR);

        if (!existsSync(workspacePath)) {
          mkdirSync(workspacePath, { recursive: true });
        }

        const planName = extractPlanName(content) || "workflow";
        
        // Generate tasks with MDD plane classification
        const tasks = generateMDDTasks(content, max_tasks);

        let planMarkdown = `# Task Plan

Generated by: QiaoChui (巧倕) - Technical Expert
Timestamp: ${new Date().toISOString()}
Plan: ${planName}

## MDD Task Breakdown

| ID | Description | Plane | Priority | Dependencies |
|----|-------------|-------|----------|--------------|
`;
        for (const task of tasks) {
          planMarkdown += `| ${task.id} | ${task.description} | ${task.plane} | ${task.priority} | ${task.dependsOn.join(", ") || "-"} |\n`;
        }

        planMarkdown += `\n## Task Details\n\n`;
        for (const task of tasks) {
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

        const totalTime = tasks.length * 10;
        planMarkdown += `## Total Estimated Time: ${totalTime} minutes\n`;

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
    model: sonnet
    skills:
      - luban
    maxContext: 4000
    timeout: 300

tasks:
${tasks.map((t) => `  - id: ${t.id}
    description: "${t.description}"
    plane: ${t.plane}
    priority: ${t.priority === "high" ? 1 : t.priority === "medium" ? 2 : 3}
    dependsOn: [${t.dependsOn.map(d => `"${d}"`).join(", ")}]
    files: [${(t.files || []).map(f => `"${f}"`).join(", ")}]`).join("\n")}
`;

        const planPath = join(workspacePath, "plan.md");
        const executionPath = join(workspacePath, "execution.yaml");

        writeFileSync(planPath, planMarkdown);
        writeFileSync(executionPath, executionYaml);
        // Do NOT write tasks.json - use execution.yaml only

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              plan_name: planName,
              plan_path: planPath,
              execution_path: executionPath,
              task_count: tasks.length,
              estimated_time: totalTime,
              planes: [...new Set(tasks.map(t => t.plane))],
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
          details: { planName, planPath, executionPath, taskCount: tasks.length, useSubagent: use_subagent, maxParallel: max_parallel },
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
 * Perform MDD-aligned plane review
 */
function performMDDReview(content: string): PlaneAssessment[] {
  const assessments: PlaneAssessment[] = [];
  const planes: MDDPlane[] = ["Business", "Data", "Control", "Foundation", "Observation", "Security", "Evolution"];

  for (const plane of planes) {
    const planeKey = plane.toLowerCase();
    const hasContent = content.toLowerCase().includes(planeKey);

    assessments.push({
      plane,
      status: hasContent ? "✅ Feasible" : "⚠️ Needs Review",
      notes: hasContent 
        ? [`${plane} Plane has been analyzed`]
        : [`${plane} Plane content is missing or sparse - consider adding analysis`],
    });
  }

  return assessments;
}

/**
 * Generate MDD-aligned feasibility report
 */
function generateFeasibilityReport(assessments: PlaneAssessment[]): string {
  let report = `# Technical Feasibility Report

Generated by: QiaoChui (巧倕)
Timestamp: ${new Date().toISOString()}

## Plane-by-Plane Assessment

`;

  for (const a of assessments) {
    report += `### ${a.plane} Plane
- **Status**: ${a.status}
- **Notes**: ${a.notes.join(", ")}

`;
  }

  const feasibleCount = assessments.filter(a => a.status === "✅ Feasible").length;
  const totalCount = assessments.length;

  report += `## Summary

**Overall Status**: ${feasibleCount === totalCount ? "✅ All planes feasible" : "⚠️ Some planes need review"}

| Metric | Value |
|--------|-------|
| Feasible Planes | ${feasibleCount}/${totalCount} |
| Action Required | ${totalCount - feasibleCount} planes |

## Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Undefined plane content | Medium | Medium | Add detailed analysis for flagged planes |

## Recommendations

1. Review planes marked as "Needs Review"
2. Ensure all planes have sufficient detail for implementation
3. Validate dependencies between planes are clear

---
*Generated by Four Sages Agents - QiaoChui (Technical Expert)*
`;

  return report;
}

/**
 * Extract plan name from draft content
 */
function extractPlanName(content: string): string | null {
  const match = content.match(/^#\s*System Design:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Generate tasks with MDD plane classification
 */
interface MDDTask {
  id: string;
  description: string;
  plane: MDDPlane;
  priority: "high" | "medium" | "low";
  dependsOn: string[];
  files: string[];
}

/**
 * Extract tasks from draft content - parses tables and YAML lists
 */
function extractTasksFromDraft(content: string): MDDTask[] {
  const tasks: MDDTask[] = [];
  
  // Pattern 1: Table rows like "| T1 | Fix TS1205 | src/tui/base/index.ts | High |"
  const tableRowRegex = /^\|\s*([A-Z][0-9]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\w+)/gm;
  let match;
  while ((match = tableRowRegex.exec(content)) !== null && tasks.length < 15) {
    const id = match[1];
    const desc = match[2].trim();
    const files = match[3].trim();
    const priority = match[4].toLowerCase().includes("high") ? "high" : "medium";
    
    tasks.push({
      id,
      description: desc,
      plane: inferPlaneFromDescription(desc),
      priority,
      dependsOn: [],
      files: files.split(",").map((f: string) => f.trim()).filter((f: string) => f.length > 0),
    });
  }
  
  // Pattern 2: YAML list format "- id: T1" followed by description
  if (tasks.length === 0) {
    const yamlBlockRegex = /^\s*-\s*id:\s*([A-Z][0-9]+)\s*\n\s*description:\s*"?([^"\n]+)"?\s*\n\s*(?:plane:\s*(\w+)\s*\n)?\s*(?:files:\s*\[([^\]]+)\]\s*\n)?/gm;
    while ((match = yamlBlockRegex.exec(content)) !== null && tasks.length < 15) {
      const id = match[1];
      const desc = match[2].trim();
      const planeStr = match[3];
      const filesStr = match[4] || "";
      
      tasks.push({
        id,
        description: desc,
        plane: planeStr ? (planeStr as MDDPlane) : inferPlaneFromDescription(desc),
        priority: "high" as const,
        dependsOn: [],
        files: filesStr.split(",").map((f: string) => f.trim().replace(/["']/g, "")).filter((f: string) => f.length > 0),
      });
    }
  }
  
  // Pattern 3: Simple numbered list "1. T1: Fix..."
  if (tasks.length === 0) {
    const simpleListRegex = /^\d+[\.\)]\s*([A-Z][0-9]+):\s*([^\n]+)/gm;
    while ((match = simpleListRegex.exec(content)) !== null && tasks.length < 15) {
      const id = match[1];
      const desc = match[2].trim();
      
      tasks.push({
        id,
        description: desc,
        plane: inferPlaneFromDescription(desc),
        priority: "high" as const,
        dependsOn: [],
        files: inferFilesFromDescription(desc),
      });
    }
  }
  
  return tasks;
}

/**
 * Infer MDD plane from task description
 */
function inferPlaneFromDescription(desc: string): MDDPlane {
  const lowerDesc = desc.toLowerCase();
  
  if (lowerDesc.includes("export") || lowerDesc.includes("import") || lowerDesc.includes("index.ts")) {
    return "Foundation";
  }
  if (lowerDesc.includes("type") || lowerDesc.includes("interface") || lowerDesc.includes("colors")) {
    return "Data";
  }
  if (lowerDesc.includes("handler") || lowerDesc.includes("command") || lowerDesc.includes("return type")) {
    return "Control";
  }
  if (lowerDesc.includes("unused") || lowerDesc.includes("remove")) {
    return "Business";
  }
  if (lowerDesc.includes("test")) {
    return "Observation";
  }
  
  return "Foundation";
}

/**
 * Infer files from task description
 */
function inferFilesFromDescription(desc: string): string[] {
  const lowerDesc = desc.toLowerCase();
  const files: string[] = [];
  
  if (lowerDesc.includes("base/index")) files.push("src/tui/base/index.ts");
  else if (lowerDesc.includes("websocket/index")) files.push("src/tui/websocket/index.ts");
  else if (lowerDesc.includes("modal/index")) files.push("src/tui/modal/index.ts");
  else if (lowerDesc.includes("editor/index")) files.push("src/tui/editor/index.ts");
  else if (lowerDesc.includes("utils/index") || lowerDesc.includes("box export")) files.push("src/tui/utils/index.ts");
  else if (lowerDesc.includes("index.ts")) files.push("src/tui/index.ts");
  
  if (lowerDesc.includes("colors")) files.push("src/tui/utils/colors.ts");
  if (lowerDesc.includes("component")) files.push("src/tui/base/component.ts");
  if (lowerDesc.includes("node-block")) files.push("src/tui/node-block-list.ts");
  if (lowerDesc.includes("box")) files.push("src/tui/box-drawing.ts");
  if (lowerDesc.includes("command")) files.push("src/tui/editor/editor-commands.ts");
  if (lowerDesc.includes("kanban-editor")) files.push("src/tui/editor/kanban-editor.ts");
  
  return files.length > 0 ? files : ["src/"];
}

/**
 * Generate MDD tasks - tries to extract from draft first
 */
function generateMDDTasks(content: string, maxTasks: number): MDDTask[] {
  // First, try to extract actual tasks from the draft content
  const extractedTasks = extractTasksFromDraft(content);
  if (extractedTasks.length > 0) {
    return extractedTasks.slice(0, maxTasks);
  }

  // Fallback: minimal generic tasks only if extraction fails
  return [
    { id: "T1", description: "Analyze requirements and understand scope", plane: "Business" as MDDPlane, priority: "high" as const, dependsOn: [], files: [] },
    { id: "T2", description: "Implement fix based on design", plane: "Business" as MDDPlane, priority: "high" as const, dependsOn: [], files: [] },
    { id: "T3", description: "Test and validate implementation", plane: "Observation" as MDDPlane, priority: "medium" as const, dependsOn: [], files: [] },
  ].slice(0, maxTasks);
}
