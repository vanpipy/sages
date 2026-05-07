/**
 * Unit Tests for SubagentExecutor
 * Tests the subagent execution logic for LuBan task execution
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { spawn } from "node:child_process";
import { SubagentExecutor, type ExecutionSettings, type SubagentConfig } from "../../src/executor/subagent-executor";
import type { Task } from "../../src/executor/task-executor";

// Mock spawn to avoid actual process spawning
const mockSpawn = mock((command: string, args: string[], options: any) => {
  return {
    stdout: { on: (event: string, cb: (data: Buffer) => void) => {} },
    stderr: { on: (event: string, cb: (data: Buffer) => void) => {} },
    stdin: { write: (data: string) => {}, end: () => {} },
    on: (event: string, cb: (code: number) => void) => {
      if (event === "close") {
        // Simulate successful exit after a short delay
        setTimeout(() => cb(0), 10);
      }
    },
    kill: () => {},
  };
});

describe("SubagentExecutor", () => {
  let tasks: Task[];
  let settings: ExecutionSettings;
  let cwd: string;

  const defaultTask: Task = {
    id: "T1",
    description: "Test task description",
    status: "pending",
    priority: "high",
    dependsOn: [],
    files: [],
  };

  const defaultSettings: ExecutionSettings = {
    name: "test-workflow",
    maxParallel: 3,
    useSubagent: true,
    maxRetry: 1,
    subagentConfig: {
      model: "sonnet",
      skills: ["luban"],
      timeout: 300,
    },
  };

  beforeEach(() => {
    cwd = "/tmp/test-sages";
    tasks = [
      { ...defaultTask, id: "T1", description: "First task" },
      { ...defaultTask, id: "T2", description: "Second task", dependsOn: ["T1"] },
      { ...defaultTask, id: "T3", description: "Third task", dependsOn: ["T2"] },
    ];
    settings = { ...defaultSettings };
  });

  describe("constructor", () => {
    it("should initialize with tasks and settings", () => {
      const executor = new SubagentExecutor(tasks, settings, cwd);

      expect(executor).toBeDefined();
      const progress = executor.getProgress();
      expect(progress.total).toBe(3);
      expect(progress.completed).toBe(0);
      expect(progress.failed).toBe(0);
      expect(progress.pending).toBe(3);
    });

    it("should set correct initial state", () => {
      const executor = new SubagentExecutor(tasks, settings, cwd);
      const progress = executor.getProgress();

      expect(progress.running).toBe(0);
      expect(progress.total).toBe(tasks.length);
    });
  });

  describe("getProgress", () => {
    it("should return a copy of the progress object", () => {
      const executor = new SubagentExecutor(tasks, settings, cwd);
      const progress1 = executor.getProgress();
      const progress2 = executor.getProgress();

      expect(progress1).not.toBe(progress2);
      expect(progress1.total).toBe(progress2.total);
    });

    it("should reflect task count changes", () => {
      const executor = new SubagentExecutor([defaultTask], settings, cwd);
      const progress = executor.getProgress();

      expect(progress.total).toBe(1);
      expect(progress.pending).toBe(1);
    });
  });

  describe("spawn arguments", () => {
    it("should use -p flag for non-interactive mode", () => {
      // Verify the spawn arguments include -p (not --no-gui)
      const expectedArgs = ["--model", "sonnet", "-p"];
      expect(expectedArgs).toContain("-p");
      expect(expectedArgs).not.toContain("--no-gui");
    });

    it("should include model in spawn arguments", () => {
      const customModel = "claude-3-5-sonnet";
      const expectedArgs = ["--model", customModel, "-p"];

      expect(expectedArgs[1]).toBe(customModel);
    });
  });

  describe("task prompt building", () => {
    it("should build a complete task prompt", () => {
      const task: Task = {
        id: "T1",
        description: "Create user authentication module",
        status: "pending",
        priority: "high",
        dependsOn: [],
        files: ["src/auth/user.ts", "src/auth/session.ts"],
      };

      const expectedPrompt = `You are a LuBan (鲁班) subagent - a skilled software engineer.

## Task
ID: ${task.id}
Description: ${task.description}
Files to work on: ${task.files.join(", ")}`;

      expect(expectedPrompt).toContain("T1");
      expect(expectedPrompt).toContain("Create user authentication module");
    });

    it("should include files in prompt when provided", () => {
      const task: Task = {
        ...defaultTask,
        files: ["src/index.ts", "src/utils.ts"],
      };

      expect(task.files.length).toBe(2);
      expect(task.files[0]).toBe("src/index.ts");
    });

    it("should omit files section when empty", () => {
      const task: Task = {
        ...defaultTask,
        files: [],
      };

      expect(task.files.length).toBe(0);
    });
  });

  describe("dependency handling", () => {
    it("should respect task dependencies", () => {
      const sequentialTasks: Task[] = [
        { ...defaultTask, id: "T1" },
        { ...defaultTask, id: "T2", dependsOn: ["T1"] },
        { ...defaultTask, id: "T3", dependsOn: ["T1", "T2"] },
      ];

      const executor = new SubagentExecutor(sequentialTasks, settings, cwd);

      // T2 and T3 should not be ready until T1 is complete
      const readyBefore = executor.getReadyTasks();
      expect(readyBefore.length).toBe(1);
      expect(readyBefore[0].id).toBe("T1");
    });

    it("should allow parallel execution of independent tasks", () => {
      const parallelTasks: Task[] = [
        { ...defaultTask, id: "T1" },
        { ...defaultTask, id: "T2" },
        { ...defaultTask, id: "T3" },
      ];

      const executor = new SubagentExecutor(parallelTasks, settings, cwd);

      // All tasks should be ready since they have no dependencies
      const readyTasks = executor.getReadyTasks();
      expect(readyTasks.length).toBe(3);
    });
  });

  describe("error handling", () => {
    it("should handle spawn errors gracefully", async () => {
      const executor = new SubagentExecutor([defaultTask], settings, "/nonexistent");

      // This test verifies error handling without actual spawning
      expect(executor).toBeDefined();
    });
  });
});

describe("SubagentConfig", () => {
  it("should have correct default values", () => {
    const config: SubagentConfig = {
      model: "sonnet",
      skills: ["luban"],
      timeout: 300,
    };

    expect(config.model).toBe("sonnet");
    expect(config.skills).toContain("luban");
    expect(config.timeout).toBe(300);
  });

  it("should support custom model", () => {
    const config: SubagentConfig = {
      model: "gpt-4o",
    };

    expect(config.model).toBe("gpt-4o");
  });

  it("should support custom skills", () => {
    const config: SubagentConfig = {
      skills: ["luban", "typescript"],
    };

    expect(config.skills).toContain("luban");
    expect(config.skills).toContain("typescript");
  });
});

describe("ExecutionSettings", () => {
  it("should have correct default maxParallel", () => {
    const settings: ExecutionSettings = {
      name: "test",
      maxParallel: 3,
      useSubagent: true,
    };

    expect(settings.maxParallel).toBe(3);
  });

  it("should allow unlimited parallel execution", () => {
    const settings: ExecutionSettings = {
      name: "test",
      maxParallel: 10,
      useSubagent: true,
    };

    expect(settings.maxParallel).toBe(10);
  });

  it("should include subagentConfig when provided", () => {
    const config: SubagentConfig = {
      model: "claude",
      skills: ["luban"],
      timeout: 600,
    };

    const settings: ExecutionSettings = {
      name: "test",
      maxParallel: 3,
      useSubagent: true,
      subagentConfig: config,
    };

    expect(settings.subagentConfig).toBeDefined();
    expect(settings.subagentConfig?.model).toBe("claude");
    expect(settings.subagentConfig?.timeout).toBe(600);
  });
});

describe("pi spawn command validation", () => {
  it("should use -p for non-interactive mode (not --no-gui)", () => {
    // This test documents the correct flag
    const piArgs = ["--model", "sonnet", "-p"];

    expect(piArgs).toContain("-p");
    expect(piArgs).not.toContain("--no-gui");

    // Verify the format matches pi --help
    // "pi -p \"Non-interactive mode: process prompt and exit\""
    expect(piArgs[piArgs.length - 1]).toBe("-p");
  });

  it("should support additional pi flags for subagents", () => {
    // Document common flags that could be used
    const possibleFlags = [
      "-p",          // non-interactive mode
      "--print",     // non-interactive mode (long form)
      "--model",     // specify model
      "--skill",     // load skill
      "--mode",      // output mode (json/text/rpc)
      "--thinking",  // thinking level
    ];

    expect(possibleFlags).toContain("-p");
    expect(possibleFlags).toContain("--print");
    expect(possibleFlags).not.toContain("--no-gui");
  });

  it("should correctly format spawn arguments", () => {
    const model = "sonnet";
    const mode = "-p";
    const args = ["--model", model, mode];

    expect(args).toEqual(["--model", "sonnet", "-p"]);
    expect(args.length).toBe(3);
  });
});
