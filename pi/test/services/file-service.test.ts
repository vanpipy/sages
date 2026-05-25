/**
 * FileService Tests
 * 
 * TDD RED Phase: Write tests first
 * These tests define expected behavior for FileService
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Import after creating test file to ensure it exists
// The actual import will work after GREEN phase

describe("FileService", () => {
  const testDir = join(process.cwd(), ".test-temp-file-service");
  const workspaceDir = ".sages-workspace-test";

  // Helper to clean up test directory
  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("validatePath", () => {
    it("should accept valid filenames", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      expect(service.validatePath("draft.md")).toBe(true);
      expect(service.validatePath("plan.md")).toBe(true);
      expect(service.validatePath("audit.md")).toBe(true);
      expect(service.validatePath("state.json")).toBe(true);
    });

    it("should reject path traversal attempts", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      expect(service.validatePath("../etc/passwd")).toBe(false);
      expect(service.validatePath("../../../root")).toBe(false);
      expect(service.validatePath("..\\windows\\system32")).toBe(false);
    });

    it("should reject absolute paths", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      expect(service.validatePath("/etc/passwd")).toBe(false);
      expect(service.validatePath("/absolute/path")).toBe(false);
    });

    it("should reject null bytes", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      expect(service.validatePath("file\0name")).toBe(false);
    });
  });

  describe("sanitizeRegex", () => {
    it("should escape regex special characters", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      // Note: * is NOT escaped here - it's handled separately as glob wildcard
      expect(service.sanitizeRegex("file[1].txt")).toBe("file\\[1\\]\\.txt");
      expect(service.sanitizeRegex("a+b*c")).toBe("a\\+b\\*c");
    });
  });

  describe("read/write operations", () => {
    it("should write and read file content", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      const content = "Hello, World!";
      const result = service.write("test.txt", content);
      
      expect(result).not.toBeNull();
      expect(service.read("test.txt")).toBe(content);
    });

    it("should return null for non-existent file", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      expect(service.read("nonexistent.txt")).toBeNull();
    });

    it("should check file existence", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      expect(service.exists("draft.md")).toBe(false);
      
      service.write("draft.md", "# Draft");
      
      expect(service.exists("draft.md")).toBe(true);
    });
  });

  describe("readJson/writeJson", () => {
    it("should write and read JSON", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      const data = { name: "test", value: 42 };
      service.writeJson("data.json", data);
      
      const read = service.readJson<typeof data>("data.json");
      expect(read).toEqual(data);
    });

    it("should return null for invalid JSON", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      // Write invalid JSON directly
      const filePath = service.getFilePath("invalid.json");
      writeFileSync(filePath, "{ invalid json }");
      
      expect(service.readJson("invalid.json")).toBeNull();
    });
  });

  describe("delete", () => {
    it("should delete existing file", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      service.write("to-delete.txt", "content");
      expect(service.exists("to-delete.txt")).toBe(true);
      
      const result = service.delete("to-delete.txt");
      
      expect(result).toBe(true);
      expect(service.exists("to-delete.txt")).toBe(false);
    });

    it("should return false for non-existent file", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      expect(service.delete("nonexistent.txt")).toBe(false);
    });
  });

  describe("readAuditVerdict", () => {
    it("should parse verdict and score from audit.md", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      const content = `# Audit Report

**Verdict**: PASS
**Score**: 95

Details...`;

      service.write("audit.md", content);
      
      const result = service.readAuditVerdict();
      
      expect(result.verdict).toBe("PASS");
      expect(result.score).toBe(95);
    });

    it("should return null verdict for non-audit content", async () => {
      const { FileService } = await import("../../src/services/file-service.js");
      const service = new FileService(testDir, workspaceDir);
      
      service.write("not-audit.md", "# Just a document");
      
      const result = service.readAuditVerdict();
      
      expect(result.verdict).toBeNull();
    });
  });
});
