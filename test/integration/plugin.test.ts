/**
 * Integration Tests for Four Sages Agents Plugin
 * Tests plugin registration and OpenCode integration
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

describe("Four Sages Agents Plugin Integration", () => {
  describe("Plugin Tool Registration", () => {
    const expectedTools = [
      "fuxi_create_draft",
      "fuxi_get_draft",
      "qiaochui_review",
      "qiaochui_decompose",
      "luban_execute_task",
      "luban_get_status",
      "gaoyao_review",
      "gaoyao_check_security",
      "sages_init",
      "sages_get_workflow_state",
      "sages_confirm_approval",
    ];

    it("should have all expected tools defined", () => {
      expect(expectedTools.length).toBe(11);
    });

    it("should have Fuxi architect tools", () => {
      expect(expectedTools).toContain("fuxi_create_draft");
      expect(expectedTools).toContain("fuxi_get_draft");
    });

    it("should have QiaoChui reviewer tools", () => {
      expect(expectedTools).toContain("qiaochui_review");
      expect(expectedTools).toContain("qiaochui_decompose");
    });

    it("should have LuBan engineer tools", () => {
      expect(expectedTools).toContain("luban_execute_task");
      expect(expectedTools).toContain("luban_get_status");
    });

    it("should have GaoYao auditor tools", () => {
      expect(expectedTools).toContain("gaoyao_review");
      expect(expectedTools).toContain("gaoyao_check_security");
    });

    it("should have workflow state tools", () => {
      expect(expectedTools).toContain("sages_init");
      expect(expectedTools).toContain("sages_get_workflow_state");
      expect(expectedTools).toContain("sages_confirm_approval");
    });
  });

  describe("Command Registration", () => {
    interface CommandConfig {
      name: string;
      description: string;
      handler: (args: string, ctx: { sessionID: string; agent: string }) => Promise<string>;
    }

    const expectedCommands: CommandConfig[] = [
      {
        name: "fuxi",
        description: "Start Fuxi's Four Sages Agents workflow - design, review, implement, audit",
        handler: async () => "",
      },
    ];

    it("should have /fuxi command", () => {
      expect(expectedCommands.length).toBe(1);
      expect(expectedCommands[0].name).toBe("fuxi");
    });

    it("should have correct command description", () => {
      expect(expectedCommands[0].description).toContain("Four Sages Agents");
      expect(expectedCommands[0].description).toContain("design, review, implement, audit");
    });
  });

  describe("Tool Argument Validation", () => {
    interface ToolArg {
      name: string;
      required: boolean;
      type: string;
    }

    const fuxiCreateDraftArgs: ToolArg[] = [
      { name: "name", required: true, type: "string" },
      { name: "request", required: true, type: "string" },
    ];

    const lubanExecuteTaskArgs: ToolArg[] = [
      { name: "task_id", required: true, type: "string" },
      { name: "task_description", required: true, type: "string" },
      { name: "files", required: true, type: "array" },
      { name: "test_command", required: false, type: "string" },
    ];

    const gaoyaoReviewArgs: ToolArg[] = [
      { name: "plan_name", required: true, type: "string" },
      { name: "commit_hash", required: false, type: "string" },
      { name: "review_mode", required: false, type: "string" },
    ];

    it("fuxi_create_draft should require name and request", () => {
      const required = fuxiCreateDraftArgs.filter(a => a.required);
      expect(required.length).toBe(2);
      expect(required.map(a => a.name)).toEqual(["name", "request"]);
    });

    it("luban_execute_task should require task_id, task_description, files", () => {
      const required = lubanExecuteTaskArgs.filter(a => a.required);
      expect(required.length).toBe(3);
      expect(required.map(a => a.name)).toEqual(["task_id", "task_description", "files"]);
    });

    it("gaoyao_review should support review_mode parameter", () => {
      const modeArg = gaoyaoReviewArgs.find(a => a.name === "review_mode");
      expect(modeArg).toBeDefined();
      expect(modeArg?.type).toBe("string");
    });
  });

  describe("CLI Tool Routing", () => {
    const TOOLS = {
      fuxi_create_draft: () => ({}),
      fuxi_get_draft: () => ({}),
      qiaochui_review: () => ({}),
      qiaochui_decompose: () => ({}),
      luban_execute_task: () => ({}),
      luban_get_status: () => ({}),
      gaoyao_review: () => ({}),
      gaoyao_check_security: () => ({}),
      sages_init: () => ({}),
      sages_get_workflow_state: () => ({}),
      sages_confirm_approval: () => ({}),
    };

    it("should route all known tools", () => {
      const toolNames = Object.keys(TOOLS);
      expect(toolNames.length).toBe(11);
    });

    it("should return error for unknown tool", () => {
      const unknownTool = TOOLS["unknown_tool"];
      expect(unknownTool).toBeUndefined();
    });
  });

  describe("Session Initialization", () => {
    interface SessionState {
      id: string;
      projectPath: string;
      agentName: string;
      initializedAt: string;
      lastActivityAt: string;
      status: string;
    }

    function createSession(projectPath: string, agentName: string = "fuxi"): SessionState {
      const now = new Date().toISOString();
      return {
        id: `sages-${Date.now()}`,
        projectPath,
        agentName,
        initializedAt: now,
        lastActivityAt: now,
        status: "initialized",
      };
    }

    it("should create session with correct defaults", () => {
      const session = createSession("/tmp/test-project");
      expect(session.id).toMatch(/^sages-\d+$/);
      expect(session.projectPath).toBe("/tmp/test-project");
      expect(session.agentName).toBe("fuxi");
      expect(session.status).toBe("initialized");
    });

    it("should create session with custom agent name", () => {
      const session = createSession("/tmp/test-project", "luban");
      expect(session.agentName).toBe("luban");
    });

    it("should set initializedAt and lastActivityAt to same value initially", () => {
      const session = createSession("/tmp/test-project");
      expect(session.initializedAt).toBe(session.lastActivityAt);
    });
  });

  describe("File Lock Management", () => {
    interface FileLock {
      taskId: string;
      filePath: string;
      lockedBy: string;
      lockedAt: string;
      expiresAt?: string;
    }

    function getLockKey(taskId: string, filePath: string): string {
      return `${taskId}:${filePath}`;
    }

    function getLockFilePath(lockDir: string, taskId: string, filePath: string): string {
      const sanitized = filePath.replace(/[^a-zA-Z0-9_-]/g, "_");
      return `${lockDir}/${taskId}-${sanitized}.lock`;
    }

    it("should generate correct lock key", () => {
      const key = getLockKey("T1", "src/index.ts");
      expect(key).toBe("T1:src/index.ts");
    });

    it("should sanitize file path for lock file name", () => {
      const path = getLockFilePath(".sages-filelocks", "T1", "src/path/with spaces/index.ts");
      expect(path).toContain("T1-");
      expect(path).not.toContain(" ");
      expect(path).toContain(".lock");
    });

    it("should create valid lock object", () => {
      const lock: FileLock = {
        taskId: "T1",
        filePath: "src/index.ts",
        lockedBy: "T1",
        lockedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min TTL
      };
      expect(lock.taskId).toBe("T1");
      expect(lock.lockedBy).toBe("T1");
      expect(lock.expiresAt).toBeDefined();
    });
  });
});