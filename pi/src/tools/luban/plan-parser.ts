/**
 * Plan Parser - Parse execution.yaml and resolve dependencies
 * 
 * Part of: src/tools/luban/
 * Purpose: Parse execution plans, validate dependencies, sort by DAG
 */

import type { ExecutionPlan, ExecutionSettings, LubanTask } from "./types.js";

/**
 * Parse execution.yaml content into ExecutionPlan
 */
export function parseExecutionYaml(content: string): ExecutionPlan | null {
  try {
    const lines = content.split("\n");
    const plan: ExecutionPlan = {
      name: "workflow",
      settings: {
        name: "workflow",
        maxParallel: 3,
        useSubagent: true,
        maxRetry: 1,
        autoCommit: true,
      },
      tasks: [],
    };
    
    let currentTask: Partial<LubanTask> | null = null;
    let inTasks = false;
    let inTask = false;
    
    for (const rawLine of lines) {
      const line = rawLine.replace(/^\s*/, "").replace(/\s*$/, "");
      
      if (line.startsWith("name:")) {
        const name = line.split(":")[1]?.trim() || "workflow";
        plan.name = name;
        plan.settings.name = name;
        continue;
      }
      
      if (line === "tasks:") {
        inTasks = true;
        continue;
      }
      
      if (line.startsWith("maxParallel:")) {
        plan.settings.maxParallel = parseInt(line.split(":")[1]?.trim() || "3");
        continue;
      }
      
      if (line.startsWith("useSubagent:")) {
        plan.settings.useSubagent = line.includes("true");
        continue;
      }
      
      if (line.startsWith("autoCommit:")) {
        plan.settings.autoCommit = line.includes("true");
        continue;
      }
      
      if (line.startsWith("maxRetry:")) {
        plan.settings.maxRetry = parseInt(line.split(":")[1]?.trim() || "1");
        continue;
      }
      
      // Task parsing
      if (inTasks && line.startsWith("- id:")) {
        if (currentTask && currentTask.id) {
          plan.tasks.push(currentTask as LubanTask);
        }
        currentTask = {
          id: line.split(":")[1]?.trim() || "",
          description: "",
          plane: "Foundation",
          priority: "medium",
          dependsOn: [],
          files: [],
          status: "pending",
        };
        inTask = true;
        continue;
      }
      
      if (inTask && currentTask) {
        if (line.startsWith("description:")) {
          currentTask.description = line.split('"')[1] || line.split(":").slice(1).join(":").trim();
          continue;
        }
        
        if (line.startsWith("plane:")) {
          currentTask.plane = line.split(":")[1]?.trim() as LubanTask["plane"];
          continue;
        }
        
        if (line.startsWith("priority:")) {
          const p = parseInt(line.split(":")[1]?.trim() || "2");
          currentTask.priority = p === 1 ? "high" : p === 3 ? "low" : "medium";
          continue;
        }
        
        if (line.startsWith("dependsOn:")) {
          const deps = line.split("[")[1]?.split("]")[0] || "";
          currentTask.dependsOn = deps.split(",").map(d => d.trim().replace(/"/g, "")).filter(Boolean);
          continue;
        }
        
        if (line.startsWith("files:")) {
          const files = line.split("[")[1]?.split("]")[0] || "";
          currentTask.files = files.split(",").map(f => f.trim().replace(/"/g, "")).filter(Boolean);
          continue;
        }
      }
    }
    
    // Add last task
    if (currentTask && currentTask.id) {
      plan.tasks.push(currentTask as LubanTask);
    }
    
    return plan.tasks.length > 0 ? plan : null;
  } catch {
    return null;
  }
}

/**
 * Resolve dependencies and check for errors
 */
export function resolveDependencies(tasks: LubanTask[]): { 
  error?: string; 
  readyTasks?: string[] 
} {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const completed = new Set<string>();
  const taskIds = new Set(tasks.map(t => t.id));
  
  // Check for missing dependencies
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        return { error: `Task ${task.id} depends on unknown task ${dep}` };
      }
    }
  }
  
  // Check for circular dependencies using DFS
  const visiting = new Set<string>();
  const visited = new Set<string>();
  
  function hasCycle(taskId: string): boolean {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    
    visiting.add(taskId);
    
    const task = taskMap.get(taskId);
    if (task) {
      for (const dep of task.dependsOn) {
        if (hasCycle(dep)) return true;
      }
    }
    
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  }
  
  for (const task of tasks) {
    if (hasCycle(task.id)) {
      return { error: `Circular dependency detected involving ${task.id}` };
    }
  }
  
  // Get tasks with no dependencies
  const readyTasks = tasks
    .filter(t => t.dependsOn.length === 0)
    .map(t => t.id);
  
  return { readyTasks };
}

/**
 * Sort tasks by dependencies (topological sort)
 */
export function sortByDependencies(tasks: LubanTask[]): LubanTask[] {
  const result: LubanTask[] = [];
  const completed = new Set<string>();
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  
  function canRun(task: LubanTask): boolean {
    return task.dependsOn.every(dep => completed.has(dep));
  }
  
  let changed = true;
  while (result.length < tasks.length && changed) {
    changed = false;
    for (const task of tasks) {
      if (!completed.has(task.id) && canRun(task)) {
        result.push(task);
        completed.add(task.id);
        changed = true;
      }
    }
  }
  
  // Add any remaining tasks (shouldn't happen if validation passed)
  for (const task of tasks) {
    if (!completed.has(task.id)) {
      result.push(task);
    }
  }
  
  return result;
}

/**
 * Get tasks that are ready to run (dependencies satisfied)
 */
export function getReadyTasks(tasks: LubanTask[], completed: Set<string>): LubanTask[] {
  return tasks.filter(task => 
    !completed.has(task.id) && 
    task.dependsOn.every(dep => completed.has(dep))
  );
}
