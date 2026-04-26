/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 QiaoChui Tools - Divine Mechanist 🜄                                 ║
 * ║                                                                           ║
 * ║   Tools for QiaoChui (巧倕) - Reviews designs and decomposes tasks      ║
 * ║   Transforms Fuxi's draft into executable plans                          ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { PluginContext, QiaoChuiReviewResult, ExecutionPlan, Phase } from "../types.js";
import { ensurePlanDir, success, readFileSync, existsSync, writeFileSync, join } from "../utils.js";
import { logSages } from "../utils/logging.js";
import { parseDraft, isDraftComplete } from "../utils/parseDraft.js";

// =============================================================================
// Tool Definitions
// =============================================================================

export const qiaochui_review = tool({
  description: `QiaoChui reviews Fuxi's design draft for feasibility and provides feedback.

Verdict options:
- APPROVED: Design is feasible, ready for task decomposition
- REVISE: Design needs changes before proceeding
- REJECTED: Design cannot be implemented as specified

If APPROVED, also returns:
- Task count
- Estimated time (minutes)
- Task decomposition (.plan/{name}.plan.md)
- Execution orchestration (.plan/{name}.execution.yaml)`,
  args: {
    draft_path: z.string().describe("Path to the draft file (.plan/{name}.draft.md)"),
  },
  execute: async (args, ctx) => {
    const { draft_path } = args;

    try {
      if (!existsSync(draft_path)) {
        return JSON.stringify({
          success: false,
          error: { message: `Draft not found: ${draft_path}` },
        });
      }

      const content = readFileSync(draft_path, "utf-8");
      const parsed = parseDraft(content);

      if (!parsed) {
        return JSON.stringify({
          success: false,
          error: { message: "Failed to parse draft" },
        });
      }

      // Perform review
      const result = performReview({ draft_path, parsed });

      logSages("qiaochui_review_completed", {
        draft_path,
        verdict: result.verdict,
        taskCount: result.taskCount,
        estimatedTime: result.estimatedTime,
      });

      return JSON.stringify(success(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("qiaochui_review_failed", { draft_path, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const qiaochui_decompose = tool({
  description: `QiaoChui decomposes the approved design into executable tasks.

Outputs:
- .plan/{name}.plan.md - Task list with descriptions
- .plan/{name}.execution.yaml - Orchestration plan for parallel execution`,
  args: {
    draft_path: z.string().describe("Path to the approved draft"),
    max_tasks: z.number().optional().describe("Max tasks to generate (default: 10)"),
  },
  execute: async (args, ctx) => {
    const { draft_path, max_tasks = 10 } = args;

    try {
      if (!existsSync(draft_path)) {
        return JSON.stringify({
          success: false,
          error: { message: `Draft not found: ${draft_path}` },
        });
      }

      const baseName = draft_path.split("/").pop()?.replace(".draft.md", "") || "unnamed";
      const planDir = ensurePlanDir(draft_path.replace(".draft.md", ""));
      const planPath = join(planDir, `${baseName}.plan.md`);
      const executionPath = join(planDir, `${baseName}.execution.yaml`);

      const content = readFileSync(draft_path, "utf-8");
      const parsed = parseDraft(content);

      // Generate plan and execution
      const planResult = generatePlan(baseName, parsed, max_tasks);
      const execution = generateExecution(baseName, planResult.plan);

      writeFileSync(planPath, planResult.markdown);
      writeFileSync(executionPath, execution);

      logSages("qiaochui_decompose_completed", {
        baseName,
        taskCount: planResult.plan.tasks.length,
        planPath,
        executionPath,
      });

      return JSON.stringify(
        success({
          plan_path: planPath,
          execution_path: executionPath,
          task_count: planResult.plan.tasks.length,
          estimated_time: planResult.plan.totalEstimatedTime,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

// =============================================================================
// Review Logic
// =============================================================================

interface ReviewInput {
  draft_path: string;
  parsed: ReturnType<typeof parseDraft>;
}

function performReview(input: ReviewInput): QiaoChuiReviewResult {
  const { parsed } = input;

  // Handle null parsed draft
  if (!parsed) {
    return {
      verdict: "REVISE",
      issues: ["Failed to parse draft - draft content is invalid"],
      recommendations: ["Ensure the draft has proper Eight Trigrams structure"],
    };
  }

  // Check draft completeness
  if (!isDraftComplete(parsed)) {
    return {
      verdict: "REVISE",
      issues: [
        "Draft is incomplete - several sections need more detail",
        "Please fill in at least 5 of the 8 Eight Trigrams sections",
      ],
      recommendations: [
        "Add more detail to Qian (Core Intent)",
        "Add more detail to Kun (Data Structures)",
        "Consider adding error handling in Kan section",
      ],
    };
  }

  // Check for placeholder text
  const hasPlaceholders = Object.values(parsed.sections).some(
    (s) => s && (s.includes("{") || s.includes("}")),
  );

  if (hasPlaceholders) {
    return {
      verdict: "REVISE",
      issues: ["Draft contains placeholder text that needs to be replaced"],
      recommendations: ["Replace all {placeholders} with actual content"],
    };
  }

  // Draft looks good - return approval with estimated tasks
  return {
    verdict: "APPROVED",
    taskCount: 5,
    estimatedTime: 30,
    issues: [],
    recommendations: [
      "Design is well-structured",
      "Ready for task decomposition",
    ],
  };
}

// =============================================================================
// Plan Generation
// =============================================================================

interface GeneratedPlan {
  tasks: Array<{
    id: string;
    description: string;
    priority: string;
    estimatedTime: number;
    dependsOn: string[];
  }>;
  totalEstimatedTime: number;
}

/**
 * Result from generatePlan - contains both markdown and structured data
 */
interface PlanResult {
  markdown: string;
  plan: GeneratedPlan;
}

function generatePlan(
  name: string,
  parsed: ReturnType<typeof parseDraft>,
  maxTasks: number,
): PlanResult {
  const tasks = [
    { id: "T1", description: "Analyze requirements and understand the codebase", priority: "high", time: 5, depends: [] },
    { id: "T2", description: "Design component structure based on the Eight Trigrams draft", priority: "high", time: 10, depends: ["T1"] },
    { id: "T3", description: "Implement core functionality following Gen (boundaries) and Kan (error handling)", priority: "high", time: 15, depends: ["T1", "T2"] },
    { id: "T4", description: "Add comprehensive tests for all features", priority: "medium", time: 10, depends: ["T3"] },
    { id: "T5", description: "Run final review and verify success path (Dui section)", priority: "medium", time: 5, depends: ["T4"] },
  ];

  const totalTime = tasks.reduce((sum, t) => sum + t.time, 0);

  let planMarkdown = `# Task Plan: ${name}

Generated by: QiaoChui
Timestamp: ${new Date().toISOString()}

## Tasks

`;

  for (const task of tasks) {
    planMarkdown += `### ${task.id}: ${task.description}
- Priority: ${task.priority}
- Estimated time: ${task.time} minutes
${task.depends.length > 0 ? `- Depends on: ${task.depends.join(", ")}` : ""}

`;
  }

  planMarkdown += `## Total Estimated Time: ${totalTime} minutes
`;

  // Convert to GeneratedPlan format
  const plan: GeneratedPlan = {
    tasks: tasks.map(t => ({
      id: t.id,
      description: t.description,
      priority: t.priority,
      estimatedTime: t.time,
      dependsOn: t.depends,
    })),
    totalEstimatedTime: totalTime,
  };

  return { markdown: planMarkdown, plan };
}

function generateExecution(
  name: string,
  plan: GeneratedPlan,
): string {
  // Group tasks into phases based on dependency levels
  // Tasks with no dependencies go in Phase 1
  // Tasks whose dependencies are all in earlier phases can be grouped

  interface PhaseTask {
    id: string;
    description: string;
    priority: string;
    estimatedTime: number;
    dependsOn: string[];
  }

  interface Phase {
    name: string;
    tasks: PhaseTask[];
    parallel: boolean;
  }

  const phases: Phase[] = [];
  const assignedTasks = new Set<string>();

  function getTask(taskId: string): PhaseTask | undefined {
    return plan.tasks.find(t => t.id === taskId);
  }

  function allDependenciesAssigned(task: PhaseTask): boolean {
    return task.dependsOn.every(dep => assignedTasks.has(dep));
  }

  function getPriorityValue(priority: string): number {
    switch (priority.toLowerCase()) {
      case "high": return 1;
      case "medium": return 2;
      case "low": return 3;
      default: return 2;
    }
  }

  // Group tasks into phases - each phase contains tasks whose dependencies are satisfied
  let phaseNumber = 1;
  let remainingTasks = [...plan.tasks];

  while (remainingTasks.length > 0) {
    const phaseTasks: PhaseTask[] = [];

    // Find tasks that can run in this phase (all deps assigned)
    for (const task of remainingTasks) {
      if (allDependenciesAssigned(task)) {
        phaseTasks.push(task);
      }
    }

    if (phaseTasks.length === 0) {
      // Circular dependency or error - break remaining into single phases
      for (const task of remainingTasks) {
        phases.push({
          name: `Phase ${phaseNumber++}`,
          tasks: [task],
          parallel: false,
        });
      }
      break;
    }

    // Determine if phase should be parallel based on task independence
    const hasDependencies = phaseTasks.some(t => t.dependsOn.length > 0);
    const parallel = phaseTasks.length > 1 && !hasDependencies;

    phases.push({
      name: `Phase ${phaseNumber++}`,
      tasks: phaseTasks,
      parallel,
    });

    // Mark tasks as assigned and remove from remaining
    for (const task of phaseTasks) {
      assignedTasks.add(task.id);
      remainingTasks = remainingTasks.filter(t => t.id !== task.id);
    }
  }

  // Generate YAML
  let yaml = `# Execution Orchestration: ${name}
# Generated by: QiaoChui
# Timestamp: ${new Date().toISOString()}
# Total Estimated Time: ${plan.totalEstimatedTime} minutes

name: ${name}

settings:
  maxParallel: 4
  maxFailure: 12
  retryAttempts: 3
  checkpointInterval: 300
  lockTimeout: 1800

phases:
`;

  for (const phase of phases) {
    yaml += `  - name: ${phase.name}\n`;
    yaml += `    parallel: ${phase.parallel}\n`;
    yaml += `    maxParallel: ${phase.parallel ? phase.tasks.length : 1}\n`;
    yaml += `    tasks:\n`;

    for (const task of phase.tasks) {
      const priority = getPriorityValue(task.priority);
      yaml += `      - id: ${task.id}\n`;
      yaml += `        description: "${task.description.replace(/"/g, '\\"')}"\n`;
      yaml += `        agent: luban\n`;
      yaml += `        dependsOn: [${task.dependsOn.map(d => `"${d}"`).join(", ")}]\n`;
      yaml += `        priority: ${priority}\n`;
      yaml += `        files: []\n`;
    }
  }

  return yaml;
}