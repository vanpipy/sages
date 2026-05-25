/**
 * Decompose Service - Task Generation and Resolution
 * 
 * Part of: src/tools/qiaochui/
 * Purpose: Generate MDD tasks from draft content and resolve file conflicts
 */

import type { MDDPlane, MDDTask } from "./types.js";

/**
 * Extract tasks from draft content - parses tables and YAML lists
 */
export function extractTasksFromDraft(content: string): MDDTask[] {
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
export function inferPlaneFromDescription(desc: string): MDDPlane {
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
export function inferFilesFromDescription(desc: string): string[] {
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
export function generateMDDTasks(content: string, maxTasks: number): MDDTask[] {
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

/**
 * Resolve file conflicts by adding sequential dependencies
 * 
 * When multiple tasks edit the same file, they must run sequentially to avoid
 * merge conflicts. This function groups tasks by file and chains them by priority.
 * 
 * Algorithm:
 * 1. Group tasks by normalized file path
 * 2. Sort each group by priority (high → medium → low)
 * 3. Add dependency links: each task depends on the previous in its group
 * 4. Reorder result array by sorted groups
 * 
 * Example:
 *   T1 (high) edits install.sh
 *   T2 (medium) edits install.sh  
 *   T3 (high) edits install.sh
 * 
 * After sorting by priority: [T1, T3, T2]
 * Result:
 *   T1: dependsOn = []
 *   T3: dependsOn = ["T1"]  (waits for T1)
 *   T2: dependsOn = ["T3"]  (waits for T3, which waits for T1)
 * 
 * Note: Returns a new array, does not mutate input.
 */
export function resolveFileConflicts(tasks: MDDTask[]): MDDTask[] {
  // Clone tasks to avoid mutating input
  const clonedTasks: MDDTask[] = tasks.map(t => ({ ...t, dependsOn: [...t.dependsOn] }));
  
  // Priority order for sorting
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  
  // Build file -> tasks map (only for tasks with files)
  const fileToTasks = new Map<string, MDDTask[]>();
  
  for (const task of clonedTasks) {
    if (task.files && task.files.length > 0) {
      for (const file of task.files) {
        const normalizedFile = normalizeFilePath(file);
        if (!fileToTasks.has(normalizedFile)) {
          fileToTasks.set(normalizedFile, []);
        }
        fileToTasks.get(normalizedFile)!.push(task);
      }
    }
  }

  // For each file with multiple tasks, sort by priority and chain dependencies
  for (const [_file, tasksForFile] of fileToTasks) {
    if (tasksForFile.length <= 1) continue;

    // Sort by priority: high > medium > low
    tasksForFile.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // Chain tasks: each task depends on the previous in sorted order
    for (let i = 1; i < tasksForFile.length; i++) {
      const currentTask = tasksForFile[i];
      const previousTask = tasksForFile[i - 1];

      // Add dependency if not already present
      if (!currentTask.dependsOn.includes(previousTask.id)) {
        currentTask.dependsOn.push(previousTask.id);
      }
    }
  }
  
  // Reorder clonedTasks to match the sorted order within each file group
  // Tasks that don't share files keep their relative order
  const result: MDDTask[] = [];
  const used = new Set<MDDTask>();
  
  // First, add all tasks sorted by their file group's priority order
  for (const [_file, tasksForFile] of fileToTasks) {
    for (const task of tasksForFile) {
      if (!used.has(task)) {
        result.push(task);
        used.add(task);
      }
    }
  }
  
  // Then add any tasks not in a file group (maintaining original order)
  for (const task of clonedTasks) {
    if (!used.has(task)) {
      result.push(task);
      used.add(task);
    }
  }

  return result;
}

/**
 * Normalize file path for comparison
 */
function normalizeFilePath(file: string): string {
  // Normalize path separators, remove ./ prefix, leading ./, and trailing slashes
  return file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
}
