/**
 * Tests for decompose-service
 * TDD RED Phase: Tests should FAIL until decompose-service is implemented
 */

import { describe, it, expect } from "bun:test";
import { generateMDDTasks, extractTasksFromDraft, resolveFileConflicts } from "@/tools/qiaochui/decompose-service.js";
import type { MDDTask } from "@/tools/qiaochui/types.js";

describe("generateMDDTasks", () => {
  it("should exist and be a function", () => {
    expect(typeof generateMDDTasks).toBe("function");
  });

  it("should return array of MDDTask", () => {
    const content = "# System Design: Test\n\n## Content here";
    const tasks = generateMDDTasks(content, 10);
    expect(Array.isArray(tasks)).toBe(true);
  });

  it("should respect maxTasks limit", () => {
    const content = "# System Design: Test\n\n## Content";
    const tasks = generateMDDTasks(content, 5);
    expect(tasks.length).toBeLessThanOrEqual(5);
  });

  it("should return fallback tasks for empty content", () => {
    const content = "";
    const tasks = generateMDDTasks(content, 10);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.length).toBeLessThanOrEqual(3); // Fallback has 3 tasks max
  });
});

describe("extractTasksFromDraft", () => {
  it("should exist and be a function", () => {
    expect(typeof extractTasksFromDraft).toBe("function");
  });

  it("should parse table format tasks", () => {
    const content = `
# System Design: Test

| ID | Description | Files | Priority |
|----|-------------|-------|----------|
| T1 | Fix export issue | src/index.ts | High |
| T2 | Add tests | src/test.ts | Medium |
`;
    const tasks = extractTasksFromDraft(content);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks[0].id).toBe("T1");
    expect(tasks[1].id).toBe("T2");
  });

  it("should parse YAML format tasks", () => {
    const content = `
# System Design: Test

tasks:
  - id: T1
    description: "Fix export"
    files: ["src/index.ts"]
  - id: T2
    description: "Add validation"
    files: ["src/valid.ts"]
`;
    const tasks = extractTasksFromDraft(content);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  it("should infer plane from description", () => {
    const tasks = extractTasksFromDraft(`
# System Design: Test

| ID | Description | Files | Priority |
|----|-------------|-------|----------|
| T1 | Fix export issue | src/index.ts | High |
| T2 | Add type interface | src/types.ts | High |
`);
    // T1 with "export" should be Foundation
    expect(tasks[0].plane).toBe("Foundation");
    // T2 with "type" should be Data
    expect(tasks[1].plane).toBe("Data");
  });

  it("should handle empty content", () => {
    const tasks = extractTasksFromDraft("");
    expect(Array.isArray(tasks)).toBe(true);
  });
});

describe("resolveFileConflicts", () => {
  it("should exist and be a function", () => {
    expect(typeof resolveFileConflicts).toBe("function");
  });

  it("should chain tasks editing the same file", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["src/index.ts"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: ["src/index.ts"] },
    ];
    
    const resolved = resolveFileConflicts(tasks);
    
    // T2 should depend on T1 since they edit the same file
    expect(resolved[1].dependsOn).toContain("T1");
  });

  it("should sort by priority when chaining", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "low", dependsOn: [], files: ["src/index.ts"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "high", dependsOn: [], files: ["src/index.ts"] },
      { id: "T3", description: "Task 3", plane: "Foundation", priority: "medium", dependsOn: [], files: ["src/index.ts"] },
    ];
    
    const resolved = resolveFileConflicts(tasks);
    
    // High priority should come first
    expect(resolved[0].id).toBe("T2"); // high
    expect(resolved[1].id).toBe("T3"); // medium
    expect(resolved[2].id).toBe("T1"); // low
    
    // T3 should depend on T2, T1 should depend on T3
    expect(resolved[1].dependsOn).toContain("T2");
    expect(resolved[2].dependsOn).toContain("T3");
  });

  it("should not add dependencies for tasks with different files", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["src/file1.ts"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "high", dependsOn: [], files: ["src/file2.ts"] },
    ];
    
    const resolved = resolveFileConflicts(tasks);
    
    // No dependencies should be added
    expect(resolved[0].dependsOn).toEqual([]);
    expect(resolved[1].dependsOn).toEqual([]);
  });

  it("should not mutate original tasks array", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["src/index.ts"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: ["src/index.ts"] },
    ];
    
    const originalDeps = [...tasks[1].dependsOn];
    resolveFileConflicts(tasks);
    
    // Original tasks should not be mutated
    expect(tasks[1].dependsOn).toEqual(originalDeps);
  });

  it("should handle tasks with multiple files", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["src/file1.ts", "src/file2.ts"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: ["src/file2.ts"] },
    ];
    
    const resolved = resolveFileConflicts(tasks);
    
    // T2 should depend on T1 since they share file2.ts
    expect(resolved[1].dependsOn).toContain("T1");
  });

  it("should handle tasks with no files specified", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: [] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: [] },
    ];
    
    const resolved = resolveFileConflicts(tasks);
    
    // Tasks with no files should not affect each other
    expect(resolved[0].dependsOn).toEqual([]);
    expect(resolved[1].dependsOn).toEqual([]);
  });

  it("should handle single task", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["src/index.ts"] },
    ];
    
    const resolved = resolveFileConflicts(tasks);
    expect(resolved.length).toBe(1);
    expect(resolved[0].dependsOn).toEqual([]);
  });
});

describe("resolveFileConflicts - Edge Cases", () => {
  it("should handle duplicate dependencies gracefully", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: ["T0"], files: ["src/index.ts"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: ["src/index.ts"] },
    ];
    
    const resolved = resolveFileConflicts(tasks);
    
    // T2 should have T1 as dependency, but not duplicate T0
    expect(resolved[1].dependsOn).toContain("T1");
    expect(resolved[1].dependsOn.filter(d => d === "T1").length).toBe(1);
  });

  it("should handle case-insensitive file paths", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["src/INDEX.ts"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: ["src/index.ts"] },
    ];
    
    const resolved = resolveFileConflicts(tasks);
    
    // Should recognize same file despite case difference
    expect(resolved[1].dependsOn).toContain("T1");
  });

  it("should handle paths with ./ prefix", () => {
    const tasks: MDDTask[] = [
      { id: "T1", description: "Task 1", plane: "Foundation", priority: "high", dependsOn: [], files: ["./src/index.ts"] },
      { id: "T2", description: "Task 2", plane: "Foundation", priority: "medium", dependsOn: [], files: ["src/index.ts"] },
    ];
    
    const resolved = resolveFileConflicts(tasks);
    
    // Should recognize same file with ./ prefix
    expect(resolved[1].dependsOn).toContain("T1");
  });
});
