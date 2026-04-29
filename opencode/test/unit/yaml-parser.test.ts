/**
 * Unit Tests for Execution YAML Parser
 * Tests parsing and validation of .execution.yaml files
 */
import { describe, it, expect } from "bun:test";

describe("Execution YAML Parser", () => {
  describe("YAML Structure Parsing", () => {
    interface ExecutionGroup {
      name: string;
      parallel: boolean;
      tasks: string[];
      depends_on?: string[];
    }

    interface ExecutionPlan {
      groups: ExecutionGroup[];
      total_estimated_time: number;
    }

    function parseExecutionYaml(yamlContent: string): ExecutionPlan {
      // Simple YAML parser for test purposes
      const groups: ExecutionGroup[] = [];
      let currentGroup: ExecutionGroup | null = null;
      let inTasks = false;
      let inDepends = false;

      const lines = yamlContent.split("\n");
      let estimatedTime = 0;

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith("### Phase") || trimmed.startsWith("## ")) {
          if (currentGroup && currentGroup.tasks.length > 0) {
            groups.push(currentGroup);
          }
          const nameMatch = trimmed.match(/Phase\s+(\d+):?\s*(.+)?/);
          currentGroup = {
            name: nameMatch ? nameMatch[2] || `Phase ${nameMatch[1]}` : trimmed,
            parallel: false,
            tasks: [],
          };
          inTasks = false;
          inDepends = false;
        }

        if (trimmed.startsWith("parallel:") || trimmed === "parallel:") {
          currentGroup!.parallel = trimmed.includes("true") || trimmed === "parallel:";
        }

        if (trimmed.startsWith("- T")) {
          const taskMatch = trimmed.match(/-\s*(T\d+)/);
          if (taskMatch) {
            currentGroup!.tasks.push(taskMatch[1]);
          }
        }

        if (trimmed.startsWith("Depends on:") || trimmed.startsWith("- T")) {
          if (!currentGroup!.depends_on) currentGroup!.depends_on = [];
          const deps = trimmed.match(/T\d+/g);
          if (deps) {
            currentGroup!.depends_on.push(...deps);
          }
        }

        const timeMatch = trimmed.match(/(\d+)\s*minutes?/i);
        if (timeMatch) {
          estimatedTime += parseInt(timeMatch[1], 10);
        }
      }

      if (currentGroup && currentGroup.tasks.length > 0) {
        groups.push(currentGroup);
      }

      return { groups, total_estimated_time: estimatedTime };
    }

    it("should parse basic execution YAML", () => {
      const yaml = `
## Execution Plan

### Phase 1: Setup
- T1: Initialize project
- T2: Setup dependencies

### Phase 2: Implementation
- T3: Implement feature
- T4: Add tests
  Depends on: T1

## Total Estimated Time: 30 minutes
`;
      const plan = parseExecutionYaml(yaml);
      expect(plan.groups.length).toBe(2);
      expect(plan.groups[0].tasks).toContain("T1");
      expect(plan.groups[0].tasks).toContain("T2");
      expect(plan.groups[1].tasks).toContain("T3");
    });

    it("should detect parallel groups", () => {
      const yaml = `
### Phase 1: Parallel Tasks
- T1
- T2
- T3
  parallel: true
`;
      const plan = parseExecutionYaml(yaml);
      expect(plan.groups[0].parallel).toBe(true);
      expect(plan.groups[0].tasks.length).toBe(3);
    });

    it("should parse dependencies", () => {
      const yaml = `
### Phase 2
- T3
- T4
  Depends on: T1, T2
`;
      const plan = parseExecutionYaml(yaml);
      expect(plan.groups[0].depends_on).toContain("T1");
      expect(plan.groups[0].depends_on).toContain("T2");
    });

    it("should calculate total estimated time", () => {
      const yaml = `
### Phase 1
- T1
  10 minutes

### Phase 2
- T2
  20 minutes
`;
      const plan = parseExecutionYaml(yaml);
      // Parser sums all "X minutes" matches
      expect(plan.total_estimated_time).toBe(30);
    });
  });

  describe("Task Dependency Graph", () => {
    interface TaskNode {
      id: string;
      depends_on: string[];
    }

    function buildDependencyGraph(tasks: Array<{ id: string; depends_on?: string[] }>): Map<string, TaskNode> {
      const graph = new Map<string, TaskNode>();
      for (const task of tasks) {
        graph.set(task.id, { id: task.id, depends_on: task.depends_on || [] });
      }
      return graph;
    }

    function detectCircularDeps(graph: Map<string, TaskNode>): string[] {
      const visited = new Set<string>();
      const recursionStack = new Set<string>();
      const circularTasks: string[] = [];

      function dfs(taskId: string): boolean {
        visited.add(taskId);
        recursionStack.add(taskId);

        const node = graph.get(taskId);
        if (node) {
          for (const dep of node.depends_on) {
            if (!visited.has(dep)) {
              if (dfs(dep)) return true;
            } else if (recursionStack.has(dep)) {
              circularTasks.push(taskId);
              return true;
            }
          }
        }

        recursionStack.delete(taskId);
        return false;
      }

      for (const taskId of graph.keys()) {
        if (!visited.has(taskId)) {
          dfs(taskId);
        }
      }

      return circularTasks;
    }

    function getTopologicalOrder(graph: Map<string, TaskNode>): string[] {
      const inDegree = new Map<string, number>();
      const result: string[] = [];

      // Initialize in-degree (number of tasks that depend on this task)
      for (const taskId of graph.keys()) {
        inDegree.set(taskId, 0);
      }

      // Calculate in-degree: for each node, count how many tasks depend on it
      // In-degree = number of tasks that must come AFTER this task
      for (const [, node] of graph) {
        for (const dep of node.depends_on) {
          // dep must come before the current node
          // So the current node has an in-degree contribution from dep
          inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
        }
      }

      // Actually, let's fix this: in-degree should be number of dependencies
      // A task with no dependencies has in-degree 0 and can run first
      for (const [taskId, degree] of inDegree) {
        const node = graph.get(taskId);
        inDegree.set(taskId, node?.depends_on.length || 0);
      }

      // Find all nodes with in-degree 0 (no dependencies)
      const queue: string[] = [];
      for (const [taskId, degree] of inDegree) {
        if (degree === 0) queue.push(taskId);
      }

      while (queue.length > 0) {
        const taskId = queue.shift()!;
        result.push(taskId);

        // For each task that depends on the completed task, decrement its in-degree
        for (const [otherId, otherNode] of graph) {
          if (otherNode.depends_on.includes(taskId)) {
            const newDegree = (inDegree.get(otherId) || 0) - 1;
            inDegree.set(otherId, newDegree);
            if (newDegree === 0) queue.push(otherId);
          }
        }
      }

      return result;
    }

    it("should detect simple circular dependency", () => {
      const tasks = [
        { id: "T1", depends_on: ["T2"] },
        { id: "T2", depends_on: ["T1"] },
      ];
      const graph = buildDependencyGraph(tasks);
      const circular = detectCircularDeps(graph);
      expect(circular.length).toBeGreaterThan(0);
    });

    it("should NOT detect circular for valid dependencies", () => {
      const tasks = [
        { id: "T1" },
        { id: "T2", depends_on: ["T1"] },
        { id: "T3", depends_on: ["T2"] },
      ];
      const graph = buildDependencyGraph(tasks);
      const circular = detectCircularDeps(graph);
      expect(circular.length).toBe(0);
    });

    it("should return topological order for valid graph", () => {
      const tasks = [
        { id: "T1" },
        { id: "T2", depends_on: ["T1"] },
        { id: "T3", depends_on: ["T2"] },
        { id: "T4", depends_on: ["T1"] },
      ];
      const graph = buildDependencyGraph(tasks);
      const order = getTopologicalOrder(graph);

      // T1 should come before T2 and T4
      expect(order.indexOf("T1")).toBeLessThan(order.indexOf("T2"));
      expect(order.indexOf("T1")).toBeLessThan(order.indexOf("T4"));
      // T2 should come before T3
      expect(order.indexOf("T2")).toBeLessThan(order.indexOf("T3"));
    });

    it("should handle complex dependency graph", () => {
      const tasks = [
        { id: "T1" },
        { id: "T2", depends_on: ["T1"] },
        { id: "T3", depends_on: ["T1"] },
        { id: "T4", depends_on: ["T2", "T3"] },
        { id: "T5", depends_on: ["T4"] },
      ];
      const graph = buildDependencyGraph(tasks);
      const order = getTopologicalOrder(graph);

      expect(order.indexOf("T1")).toBeLessThan(Math.min(order.indexOf("T2"), order.indexOf("T3")));
      expect(order.indexOf("T4")).toBeGreaterThan(Math.max(order.indexOf("T2"), order.indexOf("T3")));
      expect(order.indexOf("T5")).toBeGreaterThan(order.indexOf("T4"));
    });
  });

  describe("Parallel Execution Validation", () => {
    function validateParallelExecution(groups: Array<{ name: string; parallel: boolean; tasks: string[] }>): string[] {
      const errors: string[] = [];

      for (const group of groups) {
        if (group.parallel && group.tasks.length < 2) {
          errors.push(`Group ${group.name} is marked parallel but has fewer than 2 tasks`);
        }
      }

      return errors;
    }

    it("should flag parallel group with single task", () => {
      const groups = [{ name: "Phase 1", parallel: true, tasks: ["T1"] }];
      const errors = validateParallelExecution(groups);
      expect(errors.length).toBe(1);
    });

    it("should allow parallel group with multiple tasks", () => {
      const groups = [{ name: "Phase 1", parallel: true, tasks: ["T1", "T2", "T3"] }];
      const errors = validateParallelExecution(groups);
      expect(errors.length).toBe(0);
    });

    it("should allow sequential group", () => {
      const groups = [{ name: "Phase 1", parallel: false, tasks: ["T1"] }];
      const errors = validateParallelExecution(groups);
      expect(errors.length).toBe(0);
    });
  });
});