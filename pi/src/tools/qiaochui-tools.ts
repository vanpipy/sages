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
        const tasksPath = join(workspacePath, "tasks.json");

        writeFileSync(planPath, planMarkdown);
        writeFileSync(executionPath, executionYaml);
        writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              plan_name: planName,
              plan_path: planPath,
              execution_path: executionPath,
              tasks_path: tasksPath,
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
 * Generate tasks with MDD plane classification and inferred files
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
 * Infer source files from task description
 */
function inferFiles(desc: string, plane: MDDPlane): string[] {
  const words = desc.toLowerCase().split(/[\s,]+/);
  const keywords = words.filter(w => 
    w.length > 3 && 
    !["implement", "setup", "create", "add", "write", "the", "and", "for", "core", "strategy"].includes(w)
  );

  const files: string[] = [];

  // Map plane to source directories
  const planePaths: Record<MDDPlane, string> = {
    Business: "src/business",
    Data: "src/data",
    Control: "src/control",
    Foundation: "src/foundation",
    Observation: "src/observation",
    Security: "src/security",
    Evolution: "src/evolution",
  };

  const basePath = planePaths[plane] || "src";

  // Generate file paths based on keywords
  if (keywords.length > 0) {
    files.push(`${basePath}/${keywords[0]}.ts`);
    files.push(`${basePath}/${keywords[0]}.test.ts`);
  } else {
    // Fallback to generic paths
    files.push(`${basePath}/index.ts`);
    files.push(`${basePath}/index.test.ts`);
  }

  // Add specific files based on description keywords
  if (desc.toLowerCase().includes("auth")) {
    files.push("src/security/auth.ts");
    files.push("src/security/auth.test.ts");
  }
  if (desc.toLowerCase().includes("api") || desc.toLowerCase().includes("endpoint")) {
    files.push("src/api/routes.ts");
    files.push("src/api/routes.test.ts");
  }
  if (desc.toLowerCase().includes("model") || desc.toLowerCase().includes("schema")) {
    files.push("src/data/models.ts");
    files.push("src/data/models.test.ts");
  }
  if (desc.toLowerCase().includes("test")) {
    files.push("test/integration.test.ts");
  }

  return [...new Set(files)]; // Remove duplicates
}

function generateMDDTasks(content: string, maxTasks: number): MDDTask[] {
  const tasks: MDDTask[] = [];
  const lowerContent = content.toLowerCase();

  // Task type to plane mapping based on SKILL.md task types
  const taskTemplates: { desc: string; plane: MDDPlane; priority: "high" | "medium" | "low"; dependsOn: string[] }[] = [
    // Foundation tasks (High priority, no dependencies)
    { desc: "Setup infrastructure and foundation", plane: "Foundation", priority: "high", dependsOn: [] },
    { desc: "Configure build system and dependencies", plane: "Foundation", priority: "high", dependsOn: [] },
    
    // Data tasks (High priority, depends on Foundation)
    { desc: "Design and implement data models", plane: "Data", priority: "high", dependsOn: [] },
    { desc: "Create database schema and migrations", plane: "Data", priority: "high", dependsOn: [] },
    
    // Business tasks (High priority)
    { desc: "Implement core business logic", plane: "Business", priority: "high", dependsOn: [] },
    { desc: "Implement business rules and validation", plane: "Business", priority: "high", dependsOn: [] },
    
    // Control tasks (Medium priority)
    { desc: "Implement control flow and strategy patterns", plane: "Control", priority: "medium", dependsOn: [] },
    { desc: "Implement distribution and routing logic", plane: "Control", priority: "medium", dependsOn: [] },
    
    // API/Foundation tasks (Medium priority)
    { desc: "Create API layer and endpoints", plane: "Foundation", priority: "medium", dependsOn: [] },
    { desc: "Implement API contracts and schemas", plane: "Foundation", priority: "medium", dependsOn: [] },
    
    // Security tasks (Medium priority)
    { desc: "Implement authentication mechanism", plane: "Security", priority: "medium", dependsOn: [] },
    { desc: "Implement authorization and permissions", plane: "Security", priority: "medium", dependsOn: [] },
    
    // Testing tasks (Medium priority)
    { desc: "Write unit tests for core logic", plane: "Business", priority: "medium", dependsOn: [] },
    { desc: "Write integration tests", plane: "Foundation", priority: "medium", dependsOn: [] },
    
    // Observation tasks (Low priority)
    { desc: "Add logging and metrics collection", plane: "Observation", priority: "low", dependsOn: [] },
    { desc: "Setup monitoring and alerting", plane: "Observation", priority: "low", dependsOn: [] },
    
    // Evolution tasks (Low priority)
    { desc: "Create migration strategy documentation", plane: "Evolution", priority: "low", dependsOn: [] },
    { desc: "Setup versioning strategy", plane: "Evolution", priority: "low", dependsOn: [] },
  ];

  // Select tasks based on what's mentioned in the content
  let taskIndex = 0;
  const usedPlanes = new Set<MDDPlane>();

  for (const template of taskTemplates) {
    if (tasks.length >= maxTasks) break;
    
    const planeKey = template.plane.toLowerCase();
    const isRelevant = lowerContent.includes(planeKey) || 
                       lowerContent.includes(template.desc.toLowerCase().split(" ")[0]);

    // Always include foundation and data tasks at the start
    if (tasks.length < 2 && template.plane === "Foundation") {
      const id = `T${++taskIndex}`;
      tasks.push({
        id,
        description: template.desc,
        plane: template.plane,
        priority: template.priority,
        dependsOn: [],
        files: inferFiles(template.desc, template.plane),
      });
      usedPlanes.add(template.plane);
      continue;
    }

    if (isRelevant || usedPlanes.size < 4) {
      // Determine dependencies based on plane order
      let dependsOn: string[] = [];
      
      if (template.plane === "Data" || template.plane === "Business" || template.plane === "Control") {
        const foundationTask = tasks.find(t => t.plane === "Foundation");
        if (foundationTask) dependsOn.push(foundationTask.id);
      }
      
      if (template.plane === "Security" || template.plane === "Observation" || template.plane === "Evolution") {
        const businessTask = tasks.find(t => t.plane === "Business");
        if (businessTask) dependsOn.push(businessTask.id);
      }

      const id = `T${++taskIndex}`;
      tasks.push({
        id,
        description: template.desc,
        plane: template.plane,
        priority: template.priority,
        dependsOn,
        files: inferFiles(template.desc, template.plane),
      });
      usedPlanes.add(template.plane);
    }
  }

  // If we don't have enough tasks, add defaults
  if (tasks.length < 3) {
    const defaults = [
      { desc: "Analyze requirements and understand scope", plane: "Business" as MDDPlane, priority: "high" as const, dependsOn: [] },
      { desc: "Implement core functionality", plane: "Business" as MDDPlane, priority: "high" as const, dependsOn: [] },
      { desc: "Add tests and validation", plane: "Observation" as MDDPlane, priority: "medium" as const, dependsOn: [] },
    ];
    
    for (const def of defaults) {
      if (tasks.length >= maxTasks) break;
      const id = `T${++taskIndex}`;
      tasks.push({ id, description: def.desc, plane: def.plane, priority: def.priority, dependsOn: def.dependsOn, files: inferFiles(def.desc, def.plane) });
    }
  }

  return tasks.slice(0, maxTasks);
}
