/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 Fuxi Tools - Eight Trigrams Design 🜄                                ║
 * ║                                                                           ║
 * ║   Tools for Fuxi (伏羲) - Architect using Eight Trigrams                 ║
 * ║   Creates design drafts following the八卦 structure                       ║
 * ║                                                                           ║
 * ║   INTEGRATED WITH WORKFLOW-TOOLS:                                          ║
 * ║   - fuxi_orchestrate uses WorkflowEngine to execute .sages/plans/*.execution.yaml║
 * ║   - fuxi_get_status queries StateManager for execution progress           ║
 * ║   - Unified state: file existence + execution state                      ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { PluginContext, WorkflowState } from "../types.js";
import { ensurePlanDir, resolveProjectDir, success, existsSync, readFileSync, writeFileSync, resolveProjectDir } from "../utils.js";
import { logSages } from "../utils/logging.js";
import { join } from "path";

// Import engine components for actual execution
import {
  StateManager,
  FileLockManager,
  CircuitBreaker,
  TaskDispatcher,
  WorkflowEngine,
} from "../engine/index.js";
import type { WorkflowDefinition, WorkflowExecutionState } from "../engine/types.js";

// Import shared YAML parser from workflow-tools
import { parseWorkflowYaml } from "./workflow-tools.js";

// =============================================================================
// Tool Definitions
// =============================================================================

export const fuxi_create_draft = tool({
  description: `Fuxi creates an architectural design draft following the Eight Trigrams structure.

Eight Trigrams (八卦) mapping:
- ☰ Qian (Heaven) - Core Intent: What is being built and why
- ☷ Kun (Earth) - Data Structures: Core entities and data models
- ☳ Zhen (Thunder) - Trigger Mechanisms: Events that trigger state changes
- ☴ Xun (Wind) - Data Flow: How data flows through the system
- ☵ Kan (Water) - Error Handling: How errors are handled
- ☲ Li (Fire) - Observability: How the system is observed
- ☶ Gen (Mountain) - Boundary Constraints: What the system must NOT do
- ☱ Dui (Lake) - Success Path: The happy path from start to end

Output: .sages/plans/{name}.draft.md`,
  args: {
    name: z.string().describe("Project/task name (used for .sages/plans/{name}.draft.md)"),
    request: z.string().describe("User's request to analyze"),
  },
  execute: async (args, ctx) => {
    const { name, request } = args;
    const projectDir = resolveProjectDir(ctx.agent);

    try {
      const planDir = ensurePlanDir(projectDir);
      const timestamp = new Date().toISOString();
      const draftPath = join(planDir, `${name}.draft.md`);

      const draft = generateDraftTemplate(name, request, timestamp);

      writeFileSync(draftPath, draft);
      logSages("fuxi_draft_created", { name, draftPath });

      return JSON.stringify(success({ draft_path: draftPath, timestamp }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("fuxi_draft_create_failed", { name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const fuxi_get_draft = tool({
  description: "Read an existing design draft from .sages/plans/{name}.draft.md",
  args: {
    name: z.string().describe("Project/task name"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = resolveProjectDir(ctx.agent);

    try {
      const planDir = ensurePlanDir(projectDir);
      const draftPath = join(planDir, `${name}.draft.md`);

      if (!existsSync(draftPath)) {
        return JSON.stringify({ success: false, error: { message: `Draft not found: ${draftPath}` } });
      }

      const content = readFileSync(draftPath, "utf-8");
      return JSON.stringify(success({ path: draftPath, content }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const fuxi_orchestrate = tool({
  description: `Fuxi orchestrates the execution of an approved plan.

   This tool INTEGRATES with workflow-tools by:
   1. Reading .sages/plans/{name}.execution.yaml (created by qiaochui_decompose)
   2. Using WorkflowEngine to execute the plan
   3. Managing state via StateManager

   State Management:
   - Uses StateManager (.sages-session.json) for execution state
   - Phase transitions handled by WorkflowEngine automatically`,
  args: {
    name: z.string().describe("Plan name (matches .sages/plans/{name}.execution.yaml)"),
    checkpoint_interval: z.number().optional().describe("Override checkpoint interval in seconds"),
  },
  execute: async (args, ctx) => {
    const { name, checkpoint_interval } = args;
    const projectDir = resolveProjectDir(ctx.agent);
    const startTime = Date.now();

    try {
      const planDir = ensurePlanDir(projectDir);
      const executionPath = join(planDir, `${name}.execution.yaml`);

      // Step 1: Validate execution file exists
      if (!existsSync(executionPath)) {
        return JSON.stringify({
          success: false,
          error: { message: `Execution file not found: ${executionPath}. Use qiaochui_decompose first.` },
        });
      }

      // Step 2: Read and parse the execution file
      let workflowDefinition: WorkflowDefinition;
      try {
        const yamlContent = readFileSync(executionPath, "utf-8");
        workflowDefinition = parseWorkflowYaml(yamlContent);
      } catch (parseErr) {
        return JSON.stringify({
          success: false,
          error: { message: `Failed to parse execution file: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}` },
        });
      }

      // Validate the workflow definition
      if (!workflowDefinition.name) {
        workflowDefinition.name = name;
      }
      if (!workflowDefinition.phases || workflowDefinition.phases.length === 0) {
        return JSON.stringify({
          success: false,
          error: { message: "Execution file has no phases defined" },
        });
      }

      // Override checkpoint interval if provided
      if (checkpoint_interval !== undefined) {
        workflowDefinition.settings.checkpointInterval = checkpoint_interval;
      }

      // Step 3: Create engine components
      const stateManager = new StateManager();
      const lockBaseDir = join(projectDir, ".sages-filelocks");
      const fileLockManager = new FileLockManager(lockBaseDir);
      const circuitBreaker = new CircuitBreaker(workflowDefinition.settings.maxFailure);
      const taskDispatcher = new TaskDispatcher(
        workflowDefinition.settings.maxParallel,
        fileLockManager
      );

      // Step 4: Create and execute workflow engine
      const engine = new WorkflowEngine(workflowDefinition, {
        stateManager,
        circuitBreaker,
        taskDispatcher,
        lockBaseDir,
      });

      logSages("fuxi_orchestration_started", {
        name,
        executionPath,
        totalPhases: workflowDefinition.phases.length,
        totalTasks: workflowDefinition.phases.reduce((sum, p) => sum + p.tasks.length, 0),
      });

      // Execute the workflow
      let finalState: WorkflowExecutionState;
      try {
        finalState = await engine.execute((state) => {
          // Log progress updates
          logSages("workflow_progress", {
            workflow_id: state.workflowId,
            status: state.status,
            current_phase: state.currentPhase,
            current_task: state.currentTaskIndex,
          });
        }, executionPath);
      } catch (execErr) {
        return JSON.stringify({
          success: false,
          workflow_id: "",
          status: "failed",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: `Workflow execution error: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        });
      }

      // Calculate completion stats
      const phasesCompleted = finalState.phases.filter(
        (p) => p.status === "completed" || p.status === "skipped"
      ).length;
      const tasksCompleted = finalState.phases.reduce(
        (acc, phase) => acc + phase.tasks.filter((t) => t.status === "completed").length,
        0
      );

      logSages("fuxi_orchestration_completed", {
        name,
        status: finalState.status,
        phases_completed: phasesCompleted,
        tasks_completed: tasksCompleted,
        duration_ms: Date.now() - startTime,
      });

      // Return execution result
      return JSON.stringify({
        success: finalState.status === "completed",
        workflow_id: finalState.workflowId,
        status: finalState.status,
        plan_name: name,
        execution_file: executionPath,
        phases_completed: phasesCompleted,
        total_phases: workflowDefinition.phases.length,
        tasks_completed: tasksCompleted,
        total_tasks: workflowDefinition.phases.reduce((sum, p) => sum + p.tasks.length, 0),
        duration_ms: Date.now() - startTime,
        error: finalState.error,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("fuxi_orchestration_failed", { name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const fuxi_get_status = tool({
  description: `Fuxi gets the current status of a workflow.

   INTEGRATED with workflow-tools:
   - Checks file existence (draft/plan/execution)
   - Queries StateManager for execution progress
   - Returns unified status

   Status values:
   - idle: No files found
   - draft: .draft.md exists, no .plan.md
   - plan: .plan.md exists, no .execution.yaml
   - execution: .execution.yaml exists (checks StateManager for progress)
   - running: Workflow is actively executing
   - completed: Workflow finished successfully
   - failed: Workflow encountered errors`,
  args: {
    name: z.string().describe("Plan name"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = resolveProjectDir(ctx.agent);

    try {
      const planDir = ensurePlanDir(projectDir);
      const draftPath = join(planDir, `${name}.draft.md`);
      const planPath = join(planDir, `${name}.plan.md`);
      const executionPath = join(planDir, `${name}.execution.yaml`);

      const hasDraft = existsSync(draftPath);
      const hasPlan = existsSync(planPath);
      const hasExecution = existsSync(executionPath);

      let status: WorkflowState["status"] = "idle";
      let nextStep = "";
      let executionProgress = null;

      // First check file existence
      if (hasDraft && !hasPlan) {
        status = "draft";
        nextStep = "Use qiaochui_decompose to create plan";
      } else if (hasPlan && !hasExecution) {
        status = "plan";
        nextStep = "Use qiaochui_decompose to create execution file";
      } else if (hasExecution) {
        status = "execution";

        // Check StateManager for actual execution progress
        const stateManager = new StateManager();
        const savedState = await stateManager.loadState();

        if (savedState && savedState.workflowId) {
          // Workflow has been started - get actual progress
          const phasesCompleted = savedState.phases.filter(
            (p) => p.status === "completed" || p.status === "skipped"
          ).length;
          const tasksCompleted = savedState.phases.reduce(
            (acc: number, phase) => acc + phase.tasks.filter((t) => t.status === "completed").length,
            0
          );
          const totalTasks = savedState.phases.reduce(
            (acc: number, phase) => acc + phase.tasks.length,
            0
          );

          executionProgress = {
            workflow_id: savedState.workflowId,
            status: savedState.status,
            current_phase: savedState.currentPhase,
            phases_completed: phasesCompleted,
            total_phases: savedState.phases.length,
            tasks_completed: tasksCompleted,
            total_tasks: totalTasks,
            started_at: savedState.startedAt,
            last_checkpoint: savedState.updatedAt,
          };

          // Override status based on execution state
          // Map execution statuses to WorkflowStatus values
          if (savedState.status === "completed") {
            status = "completed";
            nextStep = "Workflow completed. Use fuxi_generate_report for summary.";
          } else if (savedState.status === "failed") {
            status = "failed";
            nextStep = "Workflow failed. Use fuxi_resume to retry.";
          } else if (savedState.status === "running" || savedState.status === "paused") {
            // running/paused map to "execution" in WorkflowStatus
            status = "execution";
            nextStep = `Workflow ${savedState.status}. Use fuxi_resume to continue.`;
          }
        } else {
          nextStep = "Use fuxi_orchestrate to start execution";
        }
      }

      return JSON.stringify(
        success({
          plan_name: name,
          status,
          has_draft: hasDraft,
          has_plan: hasPlan,
          has_execution: hasExecution,
          next_step: nextStep,
          execution_progress: executionProgress,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("fuxi_get_status_failed", { name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const fuxi_resume = tool({
  description: `Fuxi resumes an interrupted workflow from the last checkpoint.

   INTEGRATED with workflow-tools:
   - Validates execution file exists
   - Uses StateManager to load saved state
   - Uses WorkflowEngine.resume() to continue`,
  args: {
    name: z.string().describe("Plan name to resume"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = resolveProjectDir(ctx.agent);
    const startTime = Date.now();

    try {
      const planDir = ensurePlanDir(projectDir);
      const executionPath = join(planDir, `${name}.execution.yaml`);

      // Validate execution file exists
      if (!existsSync(executionPath)) {
        return JSON.stringify({
          success: false,
          error: { message: `Execution file not found: ${executionPath}` },
        });
      }

      // Load saved state
      const stateManager = new StateManager();
      const savedState = await stateManager.loadState();

      if (!savedState) {
        return JSON.stringify({
          success: false,
          error: { message: "No saved workflow state found. Use fuxi_orchestrate to start fresh." },
        });
      }

      // Validate state is resumable
      if (savedState.status === "completed") {
        return JSON.stringify({
          success: false,
          error: { message: "Workflow already completed. Use fuxi_generate_report for summary." },
        });
      }

      if (savedState.status === "failed" && !savedState.error) {
        return JSON.stringify({
          success: false,
          error: { message: "Workflow failed without recovery data. Use fuxi_orchestrate to restart." },
        });
      }

      // Re-parse the execution file
      let workflowDefinition: WorkflowDefinition;
      try {
        const yamlContent = readFileSync(executionPath, "utf-8");
        workflowDefinition = parseWorkflowYaml(yamlContent);
      } catch (parseErr) {
        return JSON.stringify({
          success: false,
          error: { message: `Failed to parse execution file: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}` },
        });
      }

      // Create engine components
      const lockBaseDir = join(projectDir, ".sages-filelocks");
      const fileLockManager = new FileLockManager(lockBaseDir);
      const circuitBreaker = new CircuitBreaker(workflowDefinition.settings.maxFailure);
      const taskDispatcher = new TaskDispatcher(
        workflowDefinition.settings.maxParallel,
        fileLockManager
      );

      // Create workflow engine
      const engine = new WorkflowEngine(workflowDefinition, {
        stateManager,
        circuitBreaker,
        taskDispatcher,
        lockBaseDir,
      });

      logSages("fuxi_resume_started", {
        name,
        workflow_id: savedState.workflowId,
        last_phase: savedState.currentPhase,
      });

      // Resume execution
      let finalState: WorkflowExecutionState;
      try {
        finalState = await engine.resume(savedState, (state) => {
          logSages("workflow_progress", {
            workflow_id: state.workflowId,
            status: state.status,
            current_phase: state.currentPhase,
            current_task: state.currentTaskIndex,
          });
        });
      } catch (execErr) {
        return JSON.stringify({
          success: false,
          workflow_id: savedState.workflowId,
          status: "failed",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: `Workflow resume error: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        });
      }

      // Calculate completion stats
      const phasesCompleted = finalState.phases.filter(
        (p) => p.status === "completed" || p.status === "skipped"
      ).length;
      const tasksCompleted = finalState.phases.reduce(
        (acc, phase) => acc + phase.tasks.filter((t) => t.status === "completed").length,
        0
      );

      logSages("fuxi_resume_completed", {
        name,
        status: finalState.status,
        phases_completed: phasesCompleted,
        tasks_completed: tasksCompleted,
        duration_ms: Date.now() - startTime,
      });

      return JSON.stringify({
        success: finalState.status === "completed",
        workflow_id: finalState.workflowId,
        status: finalState.status,
        plan_name: name,
        phases_completed: phasesCompleted,
        total_phases: finalState.phases.length,
        tasks_completed: tasksCompleted,
        total_tasks: finalState.phases.reduce((sum, p) => sum + p.tasks.length, 0),
        duration_ms: Date.now() - startTime,
        error: finalState.error,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("fuxi_resume_failed", { name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const fuxi_generate_report = tool({
  description: `Fuxi generates a summary report of a workflow.

   INTEGRATED with workflow-tools:
   - Analyzes file existence status
   - Queries StateManager for execution statistics
   - Provides comprehensive report with recommendations`,
  args: {
    name: z.string().describe("Plan name"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = resolveProjectDir(ctx.agent);

    try {
      const planDir = ensurePlanDir(projectDir);
      const draftPath = join(planDir, `${name}.draft.md`);
      const planPath = join(planDir, `${name}.plan.md`);
      const executionPath = join(planDir, `${name}.execution.yaml`);

      const hasDraft = existsSync(draftPath);
      const hasPlan = existsSync(planPath);
      const hasExecution = existsSync(executionPath);

      // Get task count from plan file
      let taskCount = 0;
      if (existsSync(planPath)) {
        const planContent = readFileSync(planPath, "utf-8");
        const matches = planContent.match(/### T\d+:/g);
        if (matches) taskCount = matches.length;
      }

      // Check execution state from StateManager
      let executionStats: ReportExecutionStats | null = null;
      const stateManager = new StateManager();
      const savedState = await stateManager.loadState();

      if (savedState && savedState.workflowId) {
        const phasesCompleted = savedState.phases.filter(
          (p) => p.status === "completed" || p.status === "skipped"
        ).length;
        const tasksCompleted = savedState.phases.reduce(
          (acc: number, phase) => acc + phase.tasks.filter((t) => t.status === "completed").length,
          0
        );
        const totalTasks = savedState.phases.reduce(
          (acc: number, phase) => acc + phase.tasks.length,
          0
        );

        executionStats = {
          workflow_id: savedState.workflowId,
          status: savedState.status,
          phases_completed: phasesCompleted,
          total_phases: savedState.phases.length,
          tasks_completed: tasksCompleted,
          total_tasks: totalTasks,
          completion_rate: totalTasks > 0 ? `${Math.round((tasksCompleted / totalTasks) * 100)}%` : "0%",
          started_at: savedState.startedAt,
          last_checkpoint: savedState.updatedAt,
          error: savedState.error,
        };
      }

      const report = {
        plan_name: name,
        file_status: {
          has_draft: hasDraft,
          has_plan: hasPlan,
          has_execution: hasExecution,
        },
        estimated_tasks: taskCount,
        execution: executionStats,
        recommendations: generateRecommendations(hasDraft, hasPlan, hasExecution, executionStats),
      };

      logSages("fuxi_report_generated", { name, executionStats });

      return JSON.stringify(success(report));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("fuxi_generate_report_failed", { name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

// =============================================================================
// Draft Template Generator
// =============================================================================

function generateDraftTemplate(
  name: string,
  request: string,
  timestamp: string,
): string {
  return `# Design Draft: ${name}

Generated by: Fuxi
Timestamp: ${timestamp}
Status: draft

## ☰ Qian (Heaven) - Core Intent

${request}

## ☷ Kun (Earth) - Data Structures

{Define core entities and data models for this request}

## ☳ Zhen (Thunder) - Trigger Mechanisms

{Define what events trigger state changes}

## ☴ Xun (Wind) - Data Flow

{Define how data flows through the system}

## ☵ Kan (Water) - Error Handling

{Define how errors are handled}

## ☲ Li (Fire) - Observability

{Define how the system is observed and monitored}

## ☶ Gen (Mountain) - Boundary Constraints

{Define what the system must NOT do}

## ☱ Dui (Lake) - Success Path

{Define the happy path from start to end}

## Notes

{Any additional context or assumptions}
`;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Report execution statistics - used for fuxi_generate_report
 */
interface ReportExecutionStats {
  workflow_id: string;
  status: string;
  phases_completed: number;
  total_phases: number;
  tasks_completed: number;
  total_tasks: number;
  completion_rate: string;
  started_at?: string;
  last_checkpoint?: string;
  error?: string;
}

function generateRecommendations(
  hasDraft: boolean,
  hasPlan: boolean,
  hasExecution: boolean,
  executionStats: ReportExecutionStats | null,
): string[] {
  // If workflow has execution stats, provide status-based recommendations
  if (executionStats) {
    if (executionStats.status === "completed") {
      return ["Workflow completed successfully"];
    }
    if (executionStats.status === "failed") {
      return ["Workflow failed", "Use fuxi_resume to retry from last checkpoint"];
    }
    if (executionStats.status === "running") {
      return [`Workflow running: ${executionStats.tasks_completed}/${executionStats.total_tasks} tasks completed`];
    }
    if (executionStats.status === "paused") {
      return ["Workflow paused", "Use fuxi_resume to continue"];
    }
  }

  // Otherwise, provide file-based recommendations
  if (!hasDraft) {
    return ["No draft found. Use fuxi_create_draft to start."];
  }
  if (hasDraft && !hasPlan) {
    return ["Draft created. Use qiaochui_decompose to create plan."];
  }
  if (hasPlan && !hasExecution) {
    return ["Plan created. Use qiaochui_decompose to create execution file."];
  }
  if (hasExecution) {
    return ["Execution file ready. Use fuxi_orchestrate to start execution."];
  }
  return [];
}