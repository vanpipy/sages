/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 Workflow Tools - State Management 🜄                                  ║
 * ║                                                                           ║
 * ║   Tools for workflow state management and user approval                   ║
 * ║   Handles the Four Sages Agents orchestration state machine              ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { PluginContext, WorkflowState, SessionState } from "../types.js";
import {
  ensurePlanDir,
  success,
  existsSync,
  join,
  logSages,
  readFileSync,
} from "../utils.js";
import {
  createSession,
  getSession,
  updateSessionStatus,
  endSession,
} from "../hooks/session.js";
import type { WorkflowDefinition, WorkflowExecutionState } from "../engine/types.js";
import {
  StateManager,
  FileLockManager,
  CircuitBreaker,
  TaskDispatcher,
  WorkflowEngine,
} from "../engine/index.js";

// =============================================================================
// Tool Definitions
// =============================================================================

export const sages_init = tool({
  description: "Initialize a new Four Sages Agents workflow session",
  args: {
    project_path: z.string().describe("Absolute path to the project"),
    agent_name: z.string().optional().describe("Custom agent name (default: fuxi)"),
    task_description: z.string().optional().describe("Initial task description"),
  },
  execute: async (args, ctx) => {
    const { project_path, agent_name, task_description } = args;

    try {
      // Ensure plan directory exists
      ensurePlanDir(project_path);

      // Create session
      const result = createSession(project_path, agent_name, task_description);

      if (!result.success) {
        return JSON.stringify(result);
      }

      logSages("workflow_initialized", {
        project_path,
        agent_name,
        session_id: result.data.id,
      });

      return JSON.stringify(success({
        session_id: result.data.id,
        project_path,
        agent_name: agent_name || "fuxi",
        initialized_at: result.data.initializedAt,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const sages_get_workflow_state = tool({
  description: "Get current workflow state (draft, plan, execution status)",
  args: {
    plan_name: z.string().optional().describe("Plan name to query"),
  },
  execute: async (args, ctx) => {
    const { plan_name } = args;
    const projectDir = ctx.agent || process.cwd();

    try {
      if (plan_name) {
        const planPath = join(projectDir, ".plan", `${plan_name}.plan.md`);
        const draftPath = join(projectDir, ".plan", `${plan_name}.draft.md`);
        const executionPath = join(projectDir, ".plan", `${plan_name}.execution.yaml`);

        const hasDraft = existsSync(draftPath);
        const hasPlan = existsSync(planPath);
        const hasExecution = existsSync(executionPath);

        let status: WorkflowState["status"] = "idle";
        if (hasDraft && !hasPlan) status = "draft";
        if (hasPlan && !hasExecution) status = "plan";
        if (hasExecution) status = "execution";

        return JSON.stringify(
          success({
            plan_name,
            has_draft: hasDraft,
            has_plan: hasPlan,
            has_execution: hasExecution,
            status,
            completed_tasks: 0,
            total_tasks: 0,
          }),
        );
      }

      // No plan specified - list all plans
      return JSON.stringify(success({ active_plans: [], status: "idle" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const sages_confirm_approval = tool({
  description: `Confirm user approval to proceed with execution.

Called after user reviews the Fuxi report and chooses APPROVE.

Returns execution confirmation status`,
  args: {
    plan_name: z.string().describe("Plan name approved"),
    confirmed: z.boolean().describe("User confirmed (true = proceed, false = stop)"),
  },
  execute: async (args, ctx) => {
    const { plan_name, confirmed } = args;
    const projectDir = ctx.agent || process.cwd();

    try {
      if (confirmed) {
        // Update session to mark plan as approved
        const session = getSession(projectDir);
        if (session.success && session.data) {
          updateSessionStatus(projectDir, {
            currentPlanName: plan_name,
            status: "plan_approved",
          });
        }

        logSages("workflow_approved", { plan_name });

        return JSON.stringify(
          success({
            plan_name,
            approved: true,
            message: "Execution approved. Ready to proceed.",
          }),
        );
      } else {
        // Stop execution
        endSession(projectDir);

        logSages("workflow_rejected", { plan_name });

        return JSON.stringify(
          success({
            plan_name,
            approved: false,
            message: "Execution stopped. Run /resume to continue later.",
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const sages_get_session = tool({
  description: "Get current session information",
  args: {},
  execute: async (args, ctx) => {
    const projectDir = ctx.agent || process.cwd();

    try {
      const result = getSession(projectDir);
      return JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

export const sages_end_session = tool({
  description: "End the current workflow session",
  args: {},
  execute: async (args, ctx) => {
    const projectDir = ctx.agent || process.cwd();

    try {
      const result = endSession(projectDir);
      return JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ success: false, error: { message: msg } });
    }
  },
});

/**
 * Simple YAML parser for workflow definition files.
 * Parses a basic YAML structure into WorkflowDefinition.
 */
export function parseWorkflowYaml(yamlContent: string): WorkflowDefinition {
  const lines = yamlContent.split("\n");
  let currentSection: "none" | "settings" | "phases" = "none";
  let currentPhaseIndex = -1;
  let currentTaskIndex = -1;
  let inTasks = false;

  const result: WorkflowDefinition = {
    name: "",
    phases: [],
    settings: {
      maxParallel: 4,
      maxFailure: 12,
      retryAttempts: 3,
      checkpointInterval: 300,
      lockTimeout: 1800,
    },
  };

  let currentPhase: WorkflowDefinition["phases"][0] | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) {
      continue;
    }

    // Top-level fields
    if (line.startsWith("name:")) {
      const match = line.match(/name:\s*"?(.+)"?/);
      if (match) result.name = match[1].trim();
      continue;
    }

    if (line.startsWith("description:")) {
      const match = line.match(/description:\s*"?(.+)"?/);
      if (match) result.description = match[1].trim();
      continue;
    }

    // Settings section
    if (line === "settings:") {
      currentSection = "settings";
      continue;
    }

    if (currentSection === "settings") {
      if (line.startsWith("maxParallel:")) {
        const match = line.match(/(\d+)/);
        if (match) result.settings.maxParallel = parseInt(match[1], 10);
      } else if (line.startsWith("maxFailure:")) {
        const match = line.match(/(\d+)/);
        if (match) result.settings.maxFailure = parseInt(match[1], 10);
      } else if (line.startsWith("retryAttempts:")) {
        const match = line.match(/(\d+)/);
        if (match) result.settings.retryAttempts = parseInt(match[1], 10);
      } else if (line.startsWith("checkpointInterval:")) {
        const match = line.match(/(\d+)/);
        if (match) result.settings.checkpointInterval = parseInt(match[1], 10);
      } else if (line.startsWith("lockTimeout:")) {
        const match = line.match(/(\d+)/);
        if (match) result.settings.lockTimeout = parseInt(match[1], 10);
      } else if (line === "phases:" || line.startsWith("- name:")) {
        // Transition to phases section
        currentSection = "phases";
        if (line.startsWith("- name:")) {
          const match = line.match(/- name:\s*(.+)/);
          if (match) {
            currentPhaseIndex++;
            currentPhase = {
              name: match[1].trim(),
              tasks: [],
              parallel: false,
              maxParallel: 1,
            };
            result.phases.push(currentPhase);
            currentTaskIndex = -1;
            inTasks = false;
          }
        }
      }
      continue;
    }

    // Phases section
    if (currentSection === "phases" || line === "phases:") {
      if (line === "phases:") {
        currentSection = "phases";
        continue;
      }

      // New phase starts
      if (line.startsWith("- name:")) {
        const match = line.match(/- name:\s*(.+)/);
        if (match) {
          currentPhaseIndex++;
          currentPhase = {
            name: match[1].trim(),
            tasks: [],
            parallel: false,
            maxParallel: 1,
          };
          result.phases.push(currentPhase);
          currentTaskIndex = -1;
          inTasks = false;
        }
        continue;
      }

      if (currentPhase) {
        if (line.startsWith("parallel:")) {
          const match = line.match(/parallel:\s*(.+)/);
          if (match) currentPhase.parallel = match[1].trim() === "true";
        } else if (line.startsWith("maxParallel:")) {
          const match = line.match(/(\d+)/);
          if (match) currentPhase.maxParallel = parseInt(match[1], 10);
        } else if (line.startsWith("tasks:")) {
          inTasks = true;
          currentTaskIndex = -1;
        } else if (inTasks && line.startsWith("- id:")) {
          const match = line.match(/- id:\s*(.+)/);
          if (match) {
            currentTaskIndex++;
            currentPhase.tasks.push({
              id: match[1].trim(),
              description: "",
              agent: "luban",
            });
          }
        } else if (inTasks && currentTaskIndex >= 0) {
          const currentTask = currentPhase.tasks[currentTaskIndex];
          if (line.startsWith("description:")) {
            const match = line.match(/description:\s*"?(.+)"?/);
            if (match) currentTask.description = match[1].trim();
          } else if (line.startsWith("agent:")) {
            const match = line.match(/agent:\s*(.+)/);
            if (match) currentTask.agent = match[1].trim();
          } else if (line.startsWith("dependsOn:")) {
            const match = line.match(/dependsOn:\s*\[(.+)\]/);
            if (match) {
              currentTask.dependsOn = match[1].split(",").map((s: string) => s.trim());
            }
          } else if (line.startsWith("priority:")) {
            const match = line.match(/priority:\s*(\d+)/);
            if (match) currentTask.priority = parseInt(match[1], 10);
          } else if (line.startsWith("files:")) {
            const match = line.match(/files:\s*\[(.+)\]/);
            if (match) {
              currentTask.files = match[1].split(",").map((s: string) => s.trim());
            }
          }
        }
      }
      continue;
    }
  }

  return result;
}

export const sages_execute_workflow = tool({
  description: "Execute a workflow using the WorkflowEngine",
  args: {
    workflow: z.string().optional().describe("Workflow name (default: four-sages). Looks up src/workflows/{name}.yaml"),
    checkpoint_interval: z.number().optional().describe("Override checkpoint interval (seconds)"),
  },
  execute: async (args, ctx) => {
    const { workflow, checkpoint_interval } = args;
    const projectDir = ctx.agent || process.cwd();

    // Default to fuxi-four-gods workflow
    const workflowName = workflow || "four-sages";
    const workflowFile = `src/workflows/${workflowName}.yaml`;
    const startTime = Date.now();

    try {
      // Resolve workflow file path
      const workflowPath = workflowFile.startsWith("/")
        ? workflowFile
        : join(projectDir, workflowFile);

      // Check file exists
      if (!existsSync(workflowPath)) {
        return JSON.stringify({
          success: false,
          workflow_id: "",
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: `Workflow file not found: ${workflowPath}`,
        });
      }

      // Read and parse YAML
      let workflowDefinition: WorkflowDefinition;
      try {
        const yamlContent = readFileSync(workflowPath, "utf-8");
        workflowDefinition = parseWorkflowYaml(yamlContent);
      } catch (parseErr) {
        return JSON.stringify({
          success: false,
          workflow_id: "",
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: `YAML parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        });
      }

      // Validate workflow definition
      if (!workflowDefinition.name) {
        return JSON.stringify({
          success: false,
          workflow_id: "",
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: "Workflow validation error: missing workflow name",
        });
      }

      if (!workflowDefinition.phases || workflowDefinition.phases.length === 0) {
        return JSON.stringify({
          success: false,
          workflow_id: "",
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: "Workflow validation error: no phases defined",
        });
      }

      // Override checkpoint interval if provided
      if (checkpoint_interval !== undefined) {
        workflowDefinition.settings.checkpointInterval = checkpoint_interval;
      }

      // Create engine components
      const stateManager = new StateManager();
      const lockBaseDir = "/tmp/sages-locks";
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

      // Execute workflow with progress callback
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
        }, workflowPath);
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

      // Calculate completed phases and tasks
      const phasesCompleted = finalState.phases.filter(
        (p) => p.status === "completed" || p.status === "skipped"
      ).length;
      const tasksCompleted = finalState.phases.reduce(
        (acc, phase) => acc + phase.tasks.filter((t) => t.status === "completed").length,
        0
      );

      return JSON.stringify({
        success: finalState.status === "completed",
        workflow_id: finalState.workflowId,
        status: finalState.status,
        phases_completed: phasesCompleted,
        tasks_completed: tasksCompleted,
        duration_ms: Date.now() - startTime,
        error: finalState.error,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        success: false,
        workflow_id: "",
        status: "error",
        phases_completed: 0,
        tasks_completed: 0,
        duration_ms: Date.now() - startTime,
        error: msg,
});
    }
  },
});

export const sages_resume = tool({
  description: "Resume a crashed or paused workflow from a saved state",
  args: {
    workflow_id: z.string().describe("Workflow ID to resume"),
    checkpoint_interval: z.number().optional().describe("Override checkpoint interval (seconds)"),
    workflow_file: z.string().optional().describe("Path to workflow YAML (required if not stored in state)"),
  },
  execute: async (args, ctx) => {
    const { workflow_id, checkpoint_interval, workflow_file } = args;
    const projectDir = ctx.agent || process.cwd();
    const startTime = Date.now();

    try {
      // Step 1: Create StateManager and load saved state
      const stateManager = new StateManager();
      const loadedState = await stateManager.loadState();

      if (!loadedState) {
        return JSON.stringify({
          success: false,
          workflow_id,
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: "Workflow not found or already completed",
        });
      }

      // Verify this is the right workflow
      if (loadedState.workflowId !== workflow_id) {
        return JSON.stringify({
          success: false,
          workflow_id,
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: `Workflow ID mismatch: expected ${loadedState.workflowId}, got ${workflow_id}`,
        });
      }

      // Step 2: Validate state - must be 'running' or 'paused'
      if (loadedState.status !== "running" && loadedState.status !== "paused") {
        return JSON.stringify({
          success: false,
          workflow_id,
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: `Cannot resume workflow with status '${loadedState.status}'. Workflow must be 'running' or 'paused'.`,
        });
      }

      // Step 3: Get workflow file path
      const wfFile = loadedState.workflowFile || workflow_file;
      if (!wfFile) {
        return JSON.stringify({
          success: false,
          workflow_id,
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: "Workflow file path not found in saved state. Provide workflow_file argument.",
        });
      }

      // Resolve workflow file path
      const workflowPath = wfFile.startsWith("/")
        ? wfFile
        : join(projectDir, wfFile);

      // Check file exists
      if (!existsSync(workflowPath)) {
        return JSON.stringify({
          success: false,
          workflow_id,
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: `Workflow file not found: ${workflowPath}`,
        });
      }

      // Read and parse YAML
      let workflowDefinition: WorkflowDefinition;
      try {
        const yamlContent = readFileSync(workflowPath, "utf-8");
        workflowDefinition = parseWorkflowYaml(yamlContent);
      } catch (parseErr) {
        return JSON.stringify({
          success: false,
          workflow_id,
          status: "error",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: `YAML parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        });
      }

      // Override checkpoint interval if provided
      if (checkpoint_interval !== undefined) {
        workflowDefinition.settings.checkpointInterval = checkpoint_interval;
      }

      // Step 4: Reconstruct engine components
      const lockBaseDir = "/tmp/sages-locks";
      const fileLockManager = new FileLockManager(lockBaseDir);
      const circuitBreaker = new CircuitBreaker(workflowDefinition.settings.maxFailure);
      const taskDispatcher = new TaskDispatcher(
        workflowDefinition.settings.maxParallel,
        fileLockManager
      );

      // Create workflow engine with loaded definition
      const engine = new WorkflowEngine(workflowDefinition, {
        stateManager,
        circuitBreaker,
        taskDispatcher,
        lockBaseDir,
      });

      // Step 5: Resume execution
      let finalState: WorkflowExecutionState;
      try {
        finalState = await engine.resume(loadedState, (state) => {
          // Log progress updates
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
          workflow_id,
          status: "failed",
          phases_completed: 0,
          tasks_completed: 0,
          duration_ms: Date.now() - startTime,
          error: `Workflow resume error: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        });
      }

      // Step 6: Map final state to response format
      const phasesCompleted = finalState.phases.filter(
        (p) => p.status === "completed" || p.status === "skipped"
      ).length;
      const tasksCompleted = finalState.phases.reduce(
        (acc, phase) => acc + phase.tasks.filter((t) => t.status === "completed").length,
        0
      );

      return JSON.stringify({
        success: finalState.status === "completed",
        workflow_id: finalState.workflowId,
        status: finalState.status,
        phases_completed: phasesCompleted,
        tasks_completed: tasksCompleted,
        duration_ms: Date.now() - startTime,
        error: finalState.error,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        success: false,
        workflow_id,
        status: "error",
        phases_completed: 0,
        tasks_completed: 0,
        duration_ms: Date.now() - startTime,
        error: msg,
      });
    }
  },
});
