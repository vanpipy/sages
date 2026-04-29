/**
 * Unit Tests for fuxi_create_draft Tool
 * Tests project directory resolution logic
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fuxi_create_draft } from "../../src/tools/fuxi-tools";

describe("fuxi_create_draft - Project Directory Resolution", () => {
  const testProjectDir = "/tmp/sages-test-project";
  const tempDraftPath = join(testProjectDir, ".sages", "plans");

  beforeEach(() => {
    // Create temp project directory
    mkdirSync(tempDraftPath, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true });
    }
    // Clean up relative path directories that tests may create (./my-project, ../my-project)
    const cwd = process.cwd();
    const relativePaths = [
      join(cwd, "my-project"),
      join(cwd, "..", "my-project"),
    ];
    for (const p of relativePaths) {
      if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true });
      }
    }
  });

  describe("ctx.agent path resolution", () => {
    it("should use ctx.agent when it is a valid absolute path", async () => {
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: testProjectDir, // Absolute path
      };

      const result = await fuxi_create_draft.execute(
        { name: "test-draft", request: "Build a test feature" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.draft_path).toContain(testProjectDir);
      expect(parsed.data.draft_path).toContain(".sages/plans/test-draft.draft.md");
    });

    it("should use process.cwd() when ctx.agent is just an agent name like 'fuxi'", async () => {
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: "fuxi", // Agent name, not a path
      };

      const result = await fuxi_create_draft.execute(
        { name: "test-draft", request: "Build a test feature" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      // Should NOT contain "fuxi/" prefix
      expect(parsed.data.draft_path).not.toContain("/fuxi/");
      // Should be in current working directory's .sages/plans/
      expect(parsed.data.draft_path).toContain(".sages/plans/test-draft.draft.md");
    });

    it("should use process.cwd() when ctx.agent is undefined", async () => {
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: undefined as unknown as string,
      };

      const result = await fuxi_create_draft.execute(
        { name: "test-draft-undefined", request: "Build a test feature" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      // Should use process.cwd()
      expect(parsed.data.draft_path).toContain(process.cwd());
      expect(parsed.data.draft_path).toContain(".sages/plans/test-draft-undefined.draft.md");
    });

    it("should use process.cwd() when ctx.agent is an empty string", async () => {
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: "",
      };

      const result = await fuxi_create_draft.execute(
        { name: "test-draft-empty", request: "Build a test feature" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      // Should use process.cwd()
      expect(parsed.data.draft_path).toContain(process.cwd());
    });

    it("should use process.cwd() when ctx.agent is a relative path without ./ prefix", async () => {
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: "relative/path", // Relative path without ./ prefix - treated as agent name
      };

      const result = await fuxi_create_draft.execute(
        { name: "test-draft-relative", request: "Build a test feature" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      // Should NOT use relative path - treated as agent name
      expect(parsed.data.draft_path).not.toContain("relative/path");
      // Should use process.cwd()
      expect(parsed.data.draft_path).toContain(process.cwd());
    });

    it("should use ctx.agent when it is an absolute path", async () => {
      // Use the test project directory which actually exists
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: testProjectDir, // Absolute path starts with /
      };

      const result = await fuxi_create_draft.execute(
        { name: "test-draft-absolute", request: "Build a test feature" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.draft_path).toStartWith(testProjectDir);
    });

    it("should use ctx.agent when it is an explicit relative path (./foo)", async () => {
      // Create the directory relative to cwd since agent is "./my-project"
      // which resolves to cwd/my-project
      const cwd = process.cwd();
      const relPath = join(cwd, "my-project");
      mkdirSync(relPath, { recursive: true });
      
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: "./my-project", // Explicit relative path with ./
      };

      const result = await fuxi_create_draft.execute(
        { name: "test-draft-dot", request: "Build a test feature" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.draft_path).toContain("my-project");
    });

    it("should use ctx.agent when it is an explicit relative path (../foo)", async () => {
      // Create the directory relative to cwd (process.cwd())
      // Since agent is "../my-project" from cwd, it resolves to cwd's parent/my-project
      const cwd = process.cwd();
      const parentOfCwd = dirname(cwd);
      const relPath = join(parentOfCwd, "my-project");
      mkdirSync(relPath, { recursive: true });
      
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: "../my-project", // Explicit relative path with ../ from cwd
      };

      const result = await fuxi_create_draft.execute(
        { name: "test-draft-dot-dot", request: "Build a test feature" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.draft_path).toContain("my-project");
    });

    it("should not confuse agent name with project path", async () => {
      // Agent names should never contain / or . - they are simple identifiers
      const agentNames = ["fuxi", "qiaochui", "luban", "gaoyao"];

      for (const agentName of agentNames) {
        const mockCtx = {
          sessionID: "test-session",
          messageID: "test-message",
          agent: agentName,
        };

        const result = await fuxi_create_draft.execute(
          { name: `test-draft-agent`, request: "Build a test feature" }, // Use fixed name to avoid filename matching agentName
          mockCtx
        );

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        // Should use process.cwd(), not the agent name as directory
        // The path should be {process.cwd()}/.sages/plans/test-draft-agent.draft.md
        expect(parsed.data.draft_path).toBe(`${process.cwd()}/.sages/plans/test-draft-agent.draft.md`);
      }
    });
  });

  describe("draft file creation", () => {
    it("should create draft file with correct content structure", async () => {
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: testProjectDir,
      };

      const result = await fuxi_create_draft.execute(
        { name: "content-test", request: "Implement user login" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);

      // Verify file was created with correct content
      const draftPath = parsed.data.draft_path;
      expect(existsSync(draftPath)).toBe(true);

      const content = await Bun.file(draftPath).text();
      expect(content).toContain("# Design Draft: content-test");
      expect(content).toContain("## ☰ Qian (Heaven) - Core Intent");
      expect(content).toContain("Implement user login");
      expect(content).toContain("Generated by: Fuxi");
    });

    it("should include all Eight Trigrams sections in draft template", async () => {
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: testProjectDir,
      };

      const result = await fuxi_create_draft.execute(
        { name: "eight-trigrams-test", request: "Design a system" },
        mockCtx
      );

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);

      const content = await Bun.file(parsed.data.draft_path).text();
      expect(content).toContain("## ☰ Qian (Heaven) - Core Intent");
      expect(content).toContain("## ☷ Kun (Earth) - Data Structures");
      expect(content).toContain("## ☳ Zhen (Thunder) - Trigger Mechanisms");
      expect(content).toContain("## ☴ Xun (Wind) - Data Flow");
      expect(content).toContain("## ☵ Kan (Water) - Error Handling");
      expect(content).toContain("## ☲ Li (Fire) - Observability");
      expect(content).toContain("## ☶ Gen (Mountain) - Boundary Constraints");
      expect(content).toContain("## ☱ Dui (Lake) - Success Path");
      expect(content).toContain("## Notes");
    });

    it("should return correct timestamp in response", async () => {
      const mockCtx = {
        sessionID: "test-session",
        messageID: "test-message",
        agent: testProjectDir,
      };

      const before = new Date().toISOString();
      const result = await fuxi_create_draft.execute(
        { name: "timestamp-test", request: "Test timestamp" },
        mockCtx
      );
      const after = new Date().toISOString();

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.timestamp).toBeDefined();
      expect(parsed.data.timestamp >= before).toBe(true);
      expect(parsed.data.timestamp <= after).toBe(true);
    });
  });
});