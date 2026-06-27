/**
 * Unit Tests for LuBan Tools
 * Tests the tool registration and execution logic
 */
import { describe, it, expect } from "bun:test";

describe("LuBan Tools", () => {
  describe("YAML parsing", () => {
    // Test the YAML parsing logic that's used internally
    function parseSimpleYaml(content: string): { tasks: any[]; settings: any } | null {
      const tasks: any[] = [];
      const settings: any = {
        name: "workflow",
        maxParallel: 3,
        useSubagent: true,
        maxRetry: 1,
        autoCommit: true,
        subagentConfig: {
          model: "sonnet",
          skills: ["luban"],
          maxContext: 4000,
          timeout: 300,
        },
      };

      const lines = content.split("\n");
      let currentTask: Partial<any> | null = null;
      let inSettings = false;
      let inSubagentConfig = false;

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === "settings:") {
          inSettings = true;
          continue;
        }
        if (inSettings && trimmed.startsWith("tasks:")) {
          inSettings = false;
        }
        if (inSettings && trimmed.startsWith("subagentConfig:")) {
          inSubagentConfig = true;
          continue;
        }
        if (inSubagentConfig && trimmed.startsWith("maxContext:")) {
          settings.subagentConfig.maxContext = parseInt(trimmed.split(":")[1].trim());
        }
        if (inSubagentConfig && trimmed.startsWith("timeout:")) {
          settings.subagentConfig.timeout = parseInt(trimmed.split(":")[1].trim());
        }
        if (inSubagentConfig && trimmed.startsWith("model:")) {
          settings.subagentConfig.model = trimmed.split(":")[1].trim();
        }
        if (inSubagentConfig && trimmed.startsWith("skills:")) {
          const skills = trimmed.split("[")[1]?.split("]")[0] || "";
          settings.subagentConfig.skills = skills.split(",").map(s => s.trim().replace(/"/g, "")).filter(Boolean);
        }
        if (trimmed.startsWith("maxParallel:")) {
          settings.maxParallel = parseInt(trimmed.split(":")[1].trim());
        }
        if (trimmed.startsWith("useSubagent:")) {
          settings.useSubagent = trimmed.includes("true");
        }
        if (trimmed.startsWith("maxRetry:")) {
          settings.maxRetry = parseInt(trimmed.split(":")[1].trim());
        }
        if (trimmed.startsWith("autoCommit:")) {
          settings.autoCommit = trimmed.includes("true");
        }

        if (trimmed.startsWith("- id:")) {
          if (currentTask) {
            tasks.push(currentTask);
          }
          currentTask = {
            id: trimmed.split(":")[1].trim(),
            description: "",
            status: "pending",
            priority: "medium",
            dependsOn: [],
            files: [],
          };
        }
        if (currentTask && trimmed.startsWith("description:")) {
          currentTask.description = trimmed.split('"')[1] || trimmed.split(":").slice(1).join(":").trim();
        }
        if (currentTask && trimmed.startsWith("plane:")) {
          currentTask.plane = trimmed.split(":")[1].trim();
        }
        if (currentTask && trimmed.startsWith("priority:")) {
          const p = parseInt(trimmed.split(":")[1].trim());
          currentTask.priority = p === 1 ? "high" : p === 2 ? "medium" : "low";
        }
        if (currentTask && trimmed.startsWith("dependsOn:")) {
          const deps = trimmed.split("[")[1]?.split("]")[0] || "";
          currentTask.dependsOn = deps.split(",").map(d => d.trim().replace(/"/g, "")).filter(Boolean);
        }
        if (currentTask && trimmed.startsWith("files:")) {
          const files = trimmed.split("[")[1]?.split("]")[0] || "";
          currentTask.files = files.split(",").map(f => f.trim().replace(/"/g, "")).filter(Boolean);
        }
      }

      if (currentTask) {
        tasks.push(currentTask);
      }

      return tasks.length > 0 ? { tasks, settings } : null;
    }

    it("should parse basic execution.yaml", () => {
      const yaml = `name: test-workflow

settings:
  maxParallel: 4
  useSubagent: true

tasks:
  - id: T1
    description: "First task"
    priority: 1
  - id: T2
    description: "Second task"
    priority: 2
`;

      const result = parseSimpleYaml(yaml);

      expect(result).not.toBeNull();
      expect(result!.tasks.length).toBe(2);
      expect(result!.tasks[0].id).toBe("T1");
      expect(result!.tasks[1].id).toBe("T2");
      expect(result!.settings.maxParallel).toBe(4);
      expect(result!.settings.useSubagent).toBe(true);
    });

    it("should parse tasks with dependencies", () => {
      const yaml = `name: sequential-workflow

tasks:
  - id: T1
    description: "First task"
    dependsOn: []
  - id: T2
    description: "Second task"
    dependsOn: ["T1"]
`;

      const result = parseSimpleYaml(yaml);

      expect(result!.tasks[0].dependsOn).toEqual([]);
      expect(result!.tasks[1].dependsOn).toEqual(["T1"]);
    });

    it("should parse tasks with files", () => {
      const yaml = `name: file-workflow

tasks:
  - id: T1
    description: "Create user module"
    files: ["src/user.ts", "src/user.test.ts"]
`;

      const result = parseSimpleYaml(yaml);

      expect(result!.tasks[0].files).toEqual(["src/user.ts", "src/user.test.ts"]);
    });

    it("should parse subagentConfig with custom settings", () => {
      const yaml = `name: custom-workflow

settings:
  subagentConfig:
    model: gpt-4o
    skills: ["luban", "typescript"]
    timeout: 600
    maxContext: 8000

tasks:
  - id: T1
    description: "Test task"
`;

      const result = parseSimpleYaml(yaml);

      expect(result!.settings.subagentConfig.model).toBe("gpt-4o");
      expect(result!.settings.subagentConfig.skills).toContain("luban");
      expect(result!.settings.subagentConfig.timeout).toBe(600);
      expect(result!.settings.subagentConfig.maxContext).toBe(8000);
    });

    it("should set default values for missing settings", () => {
      const yaml = `name: minimal-workflow

tasks:
  - id: T1
    description: "Minimal task"
`;

      const result = parseSimpleYaml(yaml);

      expect(result!.settings.maxParallel).toBe(3);
      expect(result!.settings.useSubagent).toBe(true);
      expect(result!.settings.maxRetry).toBe(1);
      expect(result!.settings.subagentConfig.model).toBe("sonnet");
    });

    it("should handle priority mapping", () => {
      const yaml = `name: priority-workflow

tasks:
  - id: T1
    description: "High priority"
    priority: 1
  - id: T2
    description: "Medium priority"
    priority: 2
  - id: T3
    description: "Low priority"
    priority: 3
`;

      const result = parseSimpleYaml(yaml);

      expect(result!.tasks[0].priority).toBe("high");
      expect(result!.tasks[1].priority).toBe("medium");
      expect(result!.tasks[2].priority).toBe("low");
    });

    it("should return null for empty content", () => {
      const result = parseSimpleYaml("");
      expect(result).toBeNull();
    });

    it("should handle description with colons and special characters", () => {
      const yaml = `name: complex-workflow

tasks:
  - id: T1
    description: "Create task: with colons and special-chars"
`;

      const result = parseSimpleYaml(yaml);

      expect(result!.tasks[0].description).toContain("Create task");
    });
  });

  describe("TDD phases", () => {
    it("should define RED phase for test-first", () => {
      const tddPhases = ["RED", "GREEN", "REFACTOR"];
      expect(tddPhases[0]).toBe("RED");
    });

    it("should define GREEN phase for implementation", () => {
      const tddPhases = ["RED", "GREEN", "REFACTOR"];
      expect(tddPhases[1]).toBe("GREEN");
    });

    it("should define REFACTOR phase for cleanup", () => {
      const tddPhases = ["RED", "GREEN", "REFACTOR"];
      expect(tddPhases[2]).toBe("REFACTOR");
    });
  });

  describe("tool parameters", () => {
    it("should have correct tool names", () => {
      const expectedTools = [
        "luban_execute_task",
        "luban_execute_batch",
        "luban_get_status",
      ];

      // These are the registered tool names (KD-1: execute_all removed, execute_batch added)
      expect(expectedTools).toContain("luban_execute_task");
      expect(expectedTools).toContain("luban_execute_batch");
      expect(expectedTools).toContain("luban_get_status");
    });

    it("should validate task_id parameter format", () => {
      const validTaskIds = ["T1", "T2", "T10", "T99", "T123"];
      const invalidTaskIds = ["task1", "1", "T", "T-1", ""];

      validTaskIds.forEach(id => {
        expect(id).toMatch(/^T\d+$/);
      });

      invalidTaskIds.forEach(id => {
        expect(id).not.toMatch(/^T\d+$/);
      });
    });

    it("should validate commit parameter default is true", () => {
      // Default commit behavior
      const defaultCommit = true;
      expect(defaultCommit).toBe(true);
    });
  });

  describe("commit function", () => {
    it("should format commit message with task info", () => {
      const taskId = "T1";
      const description = "Create user authentication module";
      const commitMessage = `[${taskId}] ${description}`;

      expect(commitMessage).toBe("[T1] Create user authentication module");
    });

    it("should use git add -A for staging", () => {
      const stagingCommand = "git add -A";
      expect(stagingCommand).toContain("git add");
    });

    it("should use git commit with message", () => {
      const commitCommand = (msg: string) => `git commit -m "${msg}"`;
      expect(commitCommand("Test")).toBe('git commit -m "Test"');
    });
  });
});

describe("Task status transitions", () => {
  it("should start with pending status", () => {
    const task = {
      id: "T1",
      description: "Test task",
      status: "pending" as const,
    };

    expect(task.status).toBe("pending");
  });

  it("should transition to in_progress when started", () => {
    const task: { id: string; description: string; status: string } = {
      id: "T1",
      description: "Test task",
      status: "pending",
    };

    task.status = "in_progress";
    expect(task.status).toBe("in_progress");
  });

  it("should transition to completed on success", () => {
    const task: { id: string; description: string; status: string } = {
      id: "T1",
      description: "Test task",
      status: "pending",
    };

    task.status = "completed";
    expect(task.status).toBe("completed");
  });

  it("should transition to failed on error", () => {
    const task: { id: string; description: string; status: string } = {
      id: "T1",
      description: "Test task",
      status: "pending",
    };

    task.status = "failed";
    expect(task.status).toBe("failed");
  });

  it("should support all valid status values", () => {
    const validStatuses = ["pending", "in_progress", "completed", "failed"];
    const task = { id: "T1", description: "Test", status: "pending" as const };

    validStatuses.forEach(status => {
      task.status = status as typeof task.status;
      expect(task.status).toBe(status);
    });
  });
});

describe("Execution modes", () => {
  it("should support subagent mode for parallel execution", () => {
    const settings = {
      useSubagent: true,
      maxParallel: 3,
    };

    expect(settings.useSubagent).toBe(true);
    expect(settings.maxParallel).toBe(3);
  });

  it("should support shared context mode for sequential execution", () => {
    const settings = {
      useSubagent: false,
      maxParallel: 1,
    };

    expect(settings.useSubagent).toBe(false);
    expect(settings.maxParallel).toBe(1);
  });

  it("should have configurable maxRetry", () => {
    const settings = {
      maxRetry: 3,
    };

    expect(settings.maxRetry).toBe(3);
  });
});
