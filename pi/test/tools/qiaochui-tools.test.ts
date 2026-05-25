import { describe, it, expect } from "bun:test";

interface MDDTask {
  id: string;
  description: string;
  plane: string;
  priority: "high" | "medium" | "low";
  dependsOn: string[];
  files: string[];
}

/**
 * Resolve file conflicts by adding dependencies
 * (Copied from qiaochui-tools.ts for testing)
 */
function resolveFileConflicts(tasks: MDDTask[]): MDDTask[] {
  // Clone tasks to avoid mutating input
  const clonedTasks: MDDTask[] = tasks.map(t => ({ ...t, dependsOn: [...t.dependsOn] }));
  
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

  // For each file with multiple tasks, create dependency chain
  for (const [_file, tasksForFile] of fileToTasks) {
    if (tasksForFile.length <= 1) continue;

    // Sort by priority: high > medium > low
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    tasksForFile.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    // Chain tasks: each task depends on all previous tasks for this file
    for (let i = 1; i < tasksForFile.length; i++) {
      const currentTask = tasksForFile[i];
      const previousTask = tasksForFile[i - 1];

      // Add dependency if not already present
      if (!currentTask.dependsOn.includes(previousTask.id)) {
        currentTask.dependsOn.push(previousTask.id);
      }
    }
  }

  return clonedTasks;
}

function normalizeFilePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
}

describe("resolveFileConflicts", () => {
  it("should chain tasks editing the same file by priority", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["install.sh"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: ["install.sh"] },
      { id: "T3", description: "Task 3", plane: "Foundation", priority: "high", dependsOn: [], files: ["install.sh"] },
    ];
    
    const result = resolveFileConflicts([...tasks]);
    
    // After sorting by priority (high before medium): T1(high), T3(high), T2(medium)
    // Chain: T1 -> T3 -> T2
    
    // T1 (first high priority) should have no deps
    expect(result.find(t => t.id === "T1")!.dependsOn).toEqual([]);
    // T3 (second high priority) should depend on T1
    expect(result.find(t => t.id === "T3")!.dependsOn).toContain("T1");
    // T2 (medium priority) should depend on T3 (which comes after T1)
    expect(result.find(t => t.id === "T2")!.dependsOn).toContain("T3");
  });

  it("should not add deps for tasks editing different files", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["install.sh"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "high", dependsOn: [], files: ["install.ps1"] },
    ];
    
    const result = resolveFileConflicts([...tasks]);
    
    expect(result.find(t => t.id === "T1")!.dependsOn).toEqual([]);
    expect(result.find(t => t.id === "T2")!.dependsOn).toEqual([]);
  });

  it("should handle tasks with multiple files", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["install.sh", "install.ps1"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "high", dependsOn: [], files: ["install.sh"] },
    ];
    
    const result = resolveFileConflicts([...tasks]);
    
    // T2 should depend on T1 since they both edit install.sh
    expect(result.find(t => t.id === "T2")!.dependsOn).toContain("T1");
  });

  it("should not duplicate dependencies", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["install.sh"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: ["T1"], files: ["install.sh"] },
    ];
    
    const result = resolveFileConflicts([...tasks]);
    
    // T2 already depends on T1, should not add duplicate
    const t2Deps = result.find(t => t.id === "T2")!.dependsOn;
    expect(t2Deps.filter(d => d === "T1").length).toBe(1);
  });

  it("should normalize file paths for comparison", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["install.sh"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: ["./install.sh"] },
    ];
    
    const result = resolveFileConflicts([...tasks]);
    
    // Should be recognized as same file due to normalization
    expect(result.find(t => t.id === "T2")!.dependsOn).toContain("T1");
  });

  it("should handle tasks with no files", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: [] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: [] },
    ];
    
    const result = resolveFileConflicts([...tasks]);
    
    expect(result.find(t => t.id === "T1")!.dependsOn).toEqual([]);
    expect(result.find(t => t.id === "T2")!.dependsOn).toEqual([]);
  });

  it("should preserve original task order for single-file tasks", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["a.txt"] },
    ];
    
    const result = resolveFileConflicts([...tasks]);
    
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("T1");
    expect(result[0].dependsOn).toEqual([]);
  });
});

describe("normalizeFilePath", () => {
  it("should convert backslashes to forward slashes", () => {
    expect(normalizeFilePath("path\\to\\file")).toBe("path/to/file");
  });

  it("should remove trailing slashes", () => {
    expect(normalizeFilePath("path/to/file/")).toBe("path/to/file");
  });

  it("should lowercase for comparison", () => {
    expect(normalizeFilePath("PATH/TO/FILE")).toBe("path/to/file");
  });
});
