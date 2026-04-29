/**
 * Execution utilities for Sages
 * Provides parsing of execution orchestration YAML and Promise-based sleep
 */
import type { ExecutionPlan, Task, Phase, ExecutionStrategy, TaskResult } from "../types.js";

/**
 * Creates a default/empty ExecutionPlan
 */
function createDefaultExecutionPlan(): ExecutionPlan {
  return {
    name: "",
    timestamp: new Date().toISOString(),
    tasks: [],
    phases: [],
    totalEstimatedTime: 0,
    strategy: {
      failFast: false,
      maxRetries: 3,
      retryDelayMs: 1000,
      continueOnFailure: false,
    },
  };
}

/**
 * Trims and removes YAML comment markers
 */
function cleanLine(line: string): string {
  return line.trim().replace(/^#.*/, "");
}

/**
 * Parses a YAML string into an ExecutionPlan object
 * Handles a simple YAML structure without external dependencies
 */
export function parseExecutionYaml(yaml: string): ExecutionPlan {
  try {
    const plan = createDefaultExecutionPlan();
    const lines = yaml.split("\n");

    let currentSection: "none" | "strategy" | "tasks" | "phases" = "none";
    let currentTask: Partial<Task> | null = null;
    let currentPhase: Partial<Phase> | null = null;
    let currentStrategy: Partial<ExecutionStrategy> | null = null;
    let currentResult: Partial<Task["result"]> | null = null;
    let inTaskResult = false;
    let inTaskList = false;
    let inPhaseTaskList = false;
    let inPhaseTasksArray = false;
    let taskIndex = -1;
    let phaseIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      let line = cleanLine(lines[i]);

      // Skip empty lines and comments
      if (!line || line.startsWith("#")) {
        continue;
      }

      // Detect section changes
      if (line === "strategy:") {
        currentSection = "strategy";
        currentStrategy = {
          failFast: false,
          maxRetries: 3,
          retryDelayMs: 1000,
          continueOnFailure: false,
        };
        continue;
      }

      if (line === "tasks:" && currentSection !== "phases") {
        currentSection = "tasks";
        inTaskList = true;
        continue;
      }

      if (line === "phases:") {
        currentSection = "phases";
        inPhaseTaskList = true;
        continue;
      }

      // Handle strategy fields
      if (currentSection === "strategy" && currentStrategy) {
        if (line.startsWith("failFast:")) {
          currentStrategy.failFast = line.includes("true");
        } else if (line.startsWith("maxRetries:")) {
          const match = line.match(/(\d+)/);
          if (match) currentStrategy.maxRetries = parseInt(match[1], 10);
        } else if (line.startsWith("retryDelayMs:")) {
          const match = line.match(/(\d+)/);
          if (match) currentStrategy.retryDelayMs = parseInt(match[1], 10);
        } else if (line.startsWith("continueOnFailure:")) {
          currentStrategy.continueOnFailure = line.includes("true");
        }
        continue;
      }

      // Handle top-level fields
      if (line.startsWith("name:")) {
        const match = line.match(/name:\s*"?(.+)"?/);
        if (match) plan.name = match[1].replace(/"$/, "");
        continue;
      }

      if (line.startsWith("timestamp:")) {
        const match = line.match(/timestamp:\s*"?(.+)"?/);
        if (match) plan.timestamp = match[1].replace(/"$/, "");
        continue;
      }

      if (line.startsWith("totalEstimatedTime:")) {
        const match = line.match(/(\d+)/);
        if (match) plan.totalEstimatedTime = parseInt(match[1], 10);
        continue;
      }

      // Handle tasks
      if (currentSection === "tasks" && inTaskList && !inPhaseTasksArray) {
        // New task starts with "- id:"
        if (line.startsWith("- id:")) {
          if (currentTask && taskIndex >= 0) {
            plan.tasks[taskIndex] = currentTask as Task;
          }
          taskIndex++;
          currentTask = {
            id: "",
            description: "",
            priority: "medium",
            estimatedTime: 0,
            dependsOn: [],
            files: [],
            status: "pending",
          };
          inTaskResult = false;
          const match = line.match(/id:\s*(.+)/);
          if (match) currentTask.id = match[1].trim();
          continue;
        }

        if (currentTask) {
          if (line.startsWith("description:")) {
            const match = line.match(/description:\s*(.+)/);
            if (match) currentTask.description = match[1].replace(/^"/, "").replace(/"$/, "").trim();
          } else if (line.startsWith("priority:")) {
            const match = line.match(/priority:\s*(.+)/);
            if (match) currentTask.priority = match[1].trim() as Task["priority"];
          } else if (line.startsWith("estimatedTime:")) {
            const match = line.match(/(\d+)/);
            if (match) currentTask.estimatedTime = parseInt(match[1], 10);
          } else if (line.startsWith("dependsOn:")) {
            currentTask.dependsOn = [];
            const match = line.match(/dependsOn:\s*\[(.+)\]/);
            if (match) {
              currentTask.dependsOn = match[1].split(",").map((s: string) => s.trim().replace(/"/g, ""));
            }
          } else if (line.startsWith("files:")) {
            currentTask.files = [];
            const match = line.match(/files:\s*\[(.+)\]/);
            if (match) {
              currentTask.files = match[1].split(",").map((s: string) => s.trim().replace(/"/g, ""));
            }
          } else if (line.startsWith("result:")) {
            inTaskResult = true;
            currentResult = {};
            currentTask.result = currentResult as TaskResult;
          } else if (inTaskResult && currentResult) {
            if (line.startsWith("status:")) {
              const match = line.match(/status:\s*(.+)/);
              if (match) currentResult.status = match[1].trim() as "success" | "failed";
            } else if (line.startsWith("message:")) {
              const match = line.match(/message:\s*(.+)/);
              if (match) currentResult.message = match[1].replace(/^"/, "").replace(/"$/, "").trim();
            } else if (line.startsWith("filesCreated:")) {
              const match = line.match(/filesCreated:\s*\[(.+)\]/);
              if (match) {
                currentResult.filesCreated = match[1].split(",").map((s: string) => s.trim().replace(/"/g, ""));
              }
            } else if (line.startsWith("filesModified:")) {
              const match = line.match(/filesModified:\s*\[(.+)\]/);
              if (match) {
                currentResult.filesModified = match[1].split(",").map((s: string) => s.trim().replace(/"/g, ""));
              }
            } else if (line.startsWith("testCommand:")) {
              const match = line.match(/testCommand:\s*(.+)/);
              if (match) currentResult.testCommand = match[1].replace(/^"/, "").replace(/"$/, "").trim();
            } else if (line.startsWith("error:")) {
              const match = line.match(/error:\s*(.+)/);
              if (match) currentResult.error = match[1].replace(/^"/, "").replace(/"$/, "").trim();
            }
          } else if (line.startsWith("status:")) {
            const match = line.match(/status:\s*(.+)/);
            if (match) currentTask.status = match[1].trim() as Task["status"];
          }
        }
        continue;
      }

      // Handle phases
      if (currentSection === "phases" && inPhaseTaskList) {
        // Check for new phase (format: "- name: PhaseName")
        const nameMatch = line.match(/^-\s*name:\s*(.+)/);
        if (nameMatch) {
          if (currentPhase && phaseIndex >= 0) {
            plan.phases[phaseIndex] = currentPhase as Phase;
          }
          phaseIndex++;
          currentPhase = {
            name: nameMatch[1].replace(/^"/, "").replace(/"$/, "").trim(),
            tasks: [],
            type: "sequential",
          };
          inPhaseTasksArray = false;
          continue;
        }

        if (currentPhase) {
          if (line.startsWith("type:")) {
            const match = line.match(/type:\s*(.+)/);
            if (match) currentPhase.type = match[1].trim() as Phase["type"];
          } else if (line.startsWith("tasks:")) {
            // Mark that we're entering a tasks array
            inPhaseTasksArray = true;
          } else if (inPhaseTasksArray && line.startsWith("- ")) {
            // This is a task item in the phase's tasks array
            // Only add if it looks like a simple task ID (no colon)
            const content = line.replace(/^-/, "").trim();
            if (!content.includes(":") && currentPhase.tasks) {
              currentPhase.tasks.push(content);
            } else {
              // This is likely a top-level task entry, not a phase task
              inPhaseTasksArray = false;
            }
          } else if (!line.startsWith("tasks:") && !line.startsWith("- ")) {
            // We've left the tasks array
            inPhaseTasksArray = false;
          }
        }
        continue;
      }
    }

    // Save last task if exists
    if (currentTask && taskIndex >= 0) {
      plan.tasks[taskIndex] = currentTask as Task;
    }

    // Save last phase if exists
    if (currentPhase && phaseIndex >= 0) {
      plan.phases[phaseIndex] = currentPhase as Phase;
    }

    // Set strategy
    if (currentStrategy) {
      plan.strategy = currentStrategy as ExecutionStrategy;
    }

    return plan;
  } catch {
    return createDefaultExecutionPlan();
  }
}

/**
 * Promise-based sleep using setTimeout
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
