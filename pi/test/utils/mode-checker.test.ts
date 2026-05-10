/**
 * Unit Tests for ModeChecker
 * Tests phase-based file restrictions (from skills)
 */
import { describe, it, expect } from "bun:test";
import { checkWritePermission, getModeInfo } from "../../src/utils/mode-checker";

describe("ModeChecker", () => {
  describe("checkWritePermission", () => {
    describe("design phase (read-only)", () => {
      it("should allow draft.md", () => {
        expect(checkWritePermission("design", "/path/to/draft.md")).toBe(true);
      });

      it("should allow draft.md in workspace", () => {
        expect(checkWritePermission("design", "/path/.sages/workspace/draft.md")).toBe(true);
      });

      it("should deny plan.md", () => {
        expect(checkWritePermission("design", "/path/to/plan.md")).toBe(false);
      });

      it("should deny execution.yaml", () => {
        expect(checkWritePermission("design", "/path/to/execution.yaml")).toBe(false);
      });

      it("should deny source code files", () => {
        expect(checkWritePermission("design", "/path/to/src/index.ts")).toBe(false);
        expect(checkWritePermission("design", "/path/to/test.spec.ts")).toBe(false);
      });

      it("should deny any file not in allowed list", () => {
        expect(checkWritePermission("design", "/path/to/README.md")).toBe(false);
        expect(checkWritePermission("design", "/path/to/.gitignore")).toBe(false);
      });
    });

    describe("plan phase (read-only)", () => {
      it("should allow plan.md", () => {
        expect(checkWritePermission("plan", "/path/to/plan.md")).toBe(true);
      });

      it("should allow execution.yaml", () => {
        expect(checkWritePermission("plan", "/path/to/execution.yaml")).toBe(true);
      });

      it("should deny draft.md", () => {
        expect(checkWritePermission("plan", "/path/to/draft.md")).toBe(false);
      });

      it("should deny source files", () => {
        expect(checkWritePermission("plan", "/path/to/src/app.ts")).toBe(false);
      });
    });

    describe("implement phase (writeable)", () => {
      it("should allow all files", () => {
        expect(checkWritePermission("implement", "/path/to/src/index.ts")).toBe(true);
        expect(checkWritePermission("implement", "/path/to/test.spec.ts")).toBe(true);
        expect(checkWritePermission("implement", "/path/to/draft.md")).toBe(true);
        expect(checkWritePermission("implement", "/path/to/plan.md")).toBe(true);
      });

      it("should allow any file type", () => {
        expect(checkWritePermission("implement", "/path/to/README.md")).toBe(true);
        expect(checkWritePermission("implement", "/path/to/.env")).toBe(true);
        expect(checkWritePermission("implement", "/path/to/package.json")).toBe(true);
      });
    });

    describe("review phase (read-only)", () => {
      it("should allow audit.md", () => {
        expect(checkWritePermission("review", "/path/to/audit.md")).toBe(true);
        expect(checkWritePermission("review", "/path/to/audit-2024-01-15.md")).toBe(true);
      });

      it("should deny other files", () => {
        expect(checkWritePermission("review", "/path/to/draft.md")).toBe(false);
        expect(checkWritePermission("review", "/path/to/src/app.ts")).toBe(false);
      });
    });

    describe("idle phase", () => {
      it("should deny all files when no workflow", () => {
        expect(checkWritePermission("idle", "/path/to/draft.md")).toBe(false);
        expect(checkWritePermission("idle", "/path/to/src/app.ts")).toBe(false);
      });
    });

    describe("complete phase", () => {
      it("should deny all files after workflow complete", () => {
        expect(checkWritePermission("complete", "/path/to/draft.md")).toBe(false);
        expect(checkWritePermission("complete", "/path/to/src/app.ts")).toBe(false);
      });
    });
  });

  describe("getModeInfo", () => {
    it("should return correct info for design phase", () => {
      const info = getModeInfo("design");
      expect(info.mode).toBe("read-only");
      expect(info.allowedFiles).toEqual(["draft.md"]);
    });

    it("should return correct info for plan phase", () => {
      const info = getModeInfo("plan");
      expect(info.mode).toBe("read-only");
      expect(info.allowedFiles).toEqual(["plan.md", "execution.yaml"]);
    });

    it("should return correct info for implement phase", () => {
      const info = getModeInfo("implement");
      expect(info.mode).toBe("writeable");
      expect(info.allowedFiles).toEqual(["*"]);
    });

    it("should return correct info for review phase", () => {
      const info = getModeInfo("review");
      expect(info.mode).toBe("read-only");
      expect(info.allowedFiles).toContain("audit*.md");
    });

    it("should handle unknown phase", () => {
      const info = getModeInfo("unknown");
      expect(info.mode).toBe("read-only");
      expect(info.allowedFiles).toEqual([]);
    });
  });
});