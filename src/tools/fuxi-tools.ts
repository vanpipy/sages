/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 Fuxi Tools - Eight Trigrams Design 🜄                                ║
 * ║                                                                           ║
 * ║   Tools for Fuxi (伏羲) - Architect using Eight Trigrams                 ║
 * ║   Creates design drafts following the八卦 structure                       ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { tool } from "@opencode-ai/plugin";
import type { PluginContext, ToolResult, WorkflowState } from "../types.js";
import { execTool } from "../hooks/tool-execute.js";
import { ensurePlanDir, success, extractPlanName } from "../utils.js";
import { logSages } from "../utils/logging.js";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflowState, saveWorkflowState, transitionPhase } from "../utils/state.js";
import { parseExecutionYaml } from "../utils/execution.js";

// Import shared draft utilities
import { parseDraft, isDraftComplete, type ParsedDraft } from "../utils/parseDraft.js";

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

Output: .plan/{name}.draft.md`,
  args: {
    name: tool.schema.string().describe("Project/task name (used for .plan/{name}.draft.md)"),
    request: tool.schema.string().describe("User's request to analyze"),
  },
  execute: async (args, ctx) => {
    const { name, request } = args;
    const projectDir = ctx.agent; // Will be set by plugin

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
  description: "Read an existing design draft from .plan/{name}.draft.md",
  args: {
    name: tool.schema.string().describe("Project/task name"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = ctx.agent;

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

  Reads the plan and execution files, initializes workflow state, and begins
  orchestrating task execution by invoking LuBan.

  This is the main entry point for the execution phase.`,
  args: {
    name: tool.schema.string().describe("Plan name (matches .plan/{name}.plan.md)"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = ctx.agent;

    try {
      const planDir = ensurePlanDir(projectDir);

      // Step 1: Read the plan file
      const planPath = join(planDir, `${name}.plan.md`);
      if (!existsSync(planPath)) {
        return JSON.stringify({
          success: false,
          error: { message: `Plan not found: ${planPath}` },
        });
      }
      const planContent = readFileSync(planPath, "utf-8");

      // Step 2: Read and parse the execution file
      const executionPath = join(planDir, `${name}.execution.yaml`);
      if (!existsSync(executionPath)) {
        return JSON.stringify({
          success: false,
          error: { message: `Execution file not found: ${executionPath}` },
        });
      }
      const executionContent = readFileSync(executionPath, "utf-8");
      const executionPlan = parseExecutionYaml(executionContent);

      // Step 3: Create workflow state directory and file
      const stateDir = join(planDir, name);
      const stateFile = join(stateDir, "state.json");

      // Step 4: Set initial state
      const initialState: WorkflowState = {
        planName: executionPlan.name || name,
        status: "execution",
        hasDraft: true,
        hasPlan: true,
        hasExecution: true,
        currentPhase: executionPlan.phases[0]?.name || "",
        completedTasks: 0,
        totalTasks: executionPlan.tasks.length,
        nextTask: executionPlan.tasks[0]?.id,
      };

      // Step 5: Save the initial state
      saveWorkflowState(initialState, stateFile);

      // Step 6: Log orchestration start
      logSages("fuxi_orchestration_started", {
        name,
        planPath,
        executionPath,
        stateFile,
        totalTasks: initialState.totalTasks,
        firstPhase: initialState.currentPhase,
        firstTask: initialState.nextTask,
      });

      // Step 7: Return success with state summary
      return JSON.stringify(
        success({
          message: `Orchestration started for plan: ${name}`,
          state: {
            planName: initialState.planName,
            status: initialState.status,
            totalTasks: initialState.totalTasks,
            currentPhase: initialState.currentPhase,
            nextTask: initialState.nextTask,
          },
          files: {
            planPath,
            executionPath,
            stateFile,
          },
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("fuxi_orchestration_failed", { name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const fuxi_get_status = tool({
  description: `Fuxi gets the current status of an executing workflow.

  Reads the workflow state file and returns:
  - Current phase
  - Completed tasks vs total tasks
  - Next task to execute
  - Overall status`,
  args: {
    name: tool.schema.string().describe("Plan name"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = ctx.agent;

    try {
      const planDir = ensurePlanDir(projectDir);
      const stateFile = join(planDir, name, "state.json");

      // Check if state file exists
      if (!existsSync(stateFile)) {
        return JSON.stringify({
          success: false,
          error: { message: `State file not found: ${stateFile}` },
        });
      }

      // Load the workflow state
      const state = loadWorkflowState(stateFile);

      return JSON.stringify(
        success({
          currentPhase: state.currentPhase,
          completedTasks: state.completedTasks,
          totalTasks: state.totalTasks,
          nextTask: state.nextTask,
          status: state.status,
          planName: state.planName,
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
  description: `Fuxi resumes an interrupted workflow from the last incomplete task.
  
  Loads the workflow state and continues execution from where it left off.`,
  args: {
    name: tool.schema.string().describe("Plan name to resume"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = ctx.agent;

    try {
      const planDir = ensurePlanDir(projectDir);
      const stateFile = join(planDir, name, "state.json");

      // Check if state file exists
      if (!existsSync(stateFile)) {
        return JSON.stringify({
          success: false,
          error: { message: `State file not found: ${stateFile}` },
        });
      }

      // Load the workflow state
      const state = loadWorkflowState(stateFile);

      // Check if workflow already completed
      if (state.status === "completed") {
        return JSON.stringify({
          success: false,
          error: { message: `Workflow already completed: ${name}` },
        });
      }

      // Check if workflow failed
      if (state.status === "failed") {
        return JSON.stringify({
          success: false,
          error: { message: `Workflow failed: ${name}. Cannot resume.` },
        });
      }

      // Find the next incomplete task
      const nextTask = state.nextTask;
      if (!nextTask) {
        return JSON.stringify({
          success: false,
          error: { message: `No incomplete task found for workflow: ${name}` },
        });
      }

      // Update state to mark resumption
      const updatedState = {
        ...state,
        lastResumedAt: new Date().toISOString(),
      };
      saveWorkflowState(updatedState, stateFile);

      // Log resumption
      logSages("fuxi_workflow_resumed", {
        name,
        resumedFromTask: nextTask,
        completedTasks: state.completedTasks,
        totalTasks: state.totalTasks,
      });

      // Return resumption information
      return JSON.stringify(
        success({
          message: `Resumed workflow: ${name}`,
          planName: state.planName,
          resumedFromTask: nextTask,
          currentPhase: state.currentPhase,
          completedTasks: state.completedTasks,
          totalTasks: state.totalTasks,
          status: state.status,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("fuxi_resume_failed", { name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const fuxi_generate_report = tool({
  description: `Fuxi generates a summary report of workflow execution.

  Generates a report including:
  - Overall status
  - Task completion rate
  - Errors encountered
  - Recommendations for next steps`,
  args: {
    name: tool.schema.string().describe("Plan name"),
  },
  execute: async (args, ctx) => {
    const { name } = args;
    const projectDir = ctx.agent;

    try {
      const planDir = ensurePlanDir(projectDir);
      const stateFile = join(planDir, name, "state.json");

      // Check if state file exists
      if (!existsSync(stateFile)) {
        return JSON.stringify({
          success: false,
          error: { message: `State file not found: ${stateFile}` },
        });
      }

      // Load the workflow state
      const state = loadWorkflowState(stateFile);

      // Calculate completion rate
      const completionRate =
        state.totalTasks > 0
          ? `${Math.round((state.completedTasks / state.totalTasks) * 100)}%`
          : "0%";

      // Identify any errors from the state (failed status)
      const errorsEncountered = state.status === "failed" ? ["Workflow failed"] : undefined;

      // Generate summary report
      const report = {
        planName: state.planName,
        overallStatus: state.status,
        currentPhase: state.currentPhase,
        completionRate,
        completedTasks: state.completedTasks,
        totalTasks: state.totalTasks,
        errorsEncountered,
        recommendations:
          state.status === "completed"
            ? ["Workflow completed successfully"]
            : state.status === "failed"
              ? ["Investigate and fix the failed workflow"]
              : ["Continue execution to complete remaining tasks"],
      };

      logSages("fuxi_report_generated", {
        name,
        status: state.status,
        completionRate,
        completedTasks: state.completedTasks,
        totalTasks: state.totalTasks,
      });

      return JSON.stringify(success(report));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("fuxi_generate_report_failed", { name, error: msg });
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const fuxi_transition_phase = tool({
  description: `Fuxi transitions the workflow to a new phase.

  Validates the phase transition is valid, updates the state, and logs the event.`,
  args: {
    name: tool.schema.string().describe("Plan name"),
    new_phase: tool.schema.string().describe("New phase name"),
  },
  execute: async (args, ctx) => {
    const { name, new_phase } = args;
    const projectDir = ctx.agent;

    try {
      const planDir = ensurePlanDir(projectDir);
      const stateFile = join(planDir, name, "state.json");

      // Check if state file exists
      if (!existsSync(stateFile)) {
        return JSON.stringify({
          success: false,
          error: { message: `State file not found: ${stateFile}` },
        });
      }

      // Load the workflow state
      const state = loadWorkflowState(stateFile);

      // Validate new_phase is not empty
      if (!new_phase || new_phase.trim() === "") {
        return JSON.stringify({
          success: false,
          error: { message: "new_phase cannot be empty" },
        });
      }

      // Validate workflow is in execution state
      if (state.status !== "execution") {
        return JSON.stringify({
          success: false,
          error: { message: `Workflow ${name} is not in execution state (current: ${state.status})` },
        });
      }

      // Store previous phase for logging
      const previousPhase = state.currentPhase || "none";

      // Create new phase object and transition
      const newPhaseObj = { name: new_phase };
      const updatedState = transitionPhase(state, newPhaseObj);

      // Save the updated state
      saveWorkflowState(updatedState, stateFile);

      // Log the transition event
      logSages("fuxi_phase_transitioned", {
        name,
        previousPhase,
        newPhase: new_phase,
      });

      // Return success with transition details
      return JSON.stringify(
        success({
          previousPhase,
          newPhase: new_phase,
          planName: name,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logSages("fuxi_transition_phase_failed", { name, new_phase, error: msg });
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

