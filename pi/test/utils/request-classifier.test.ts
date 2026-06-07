/**
 * Unit Tests for Request Classifier
 * Detects "new" vs "improve" mode from request + project context.
 */
import { describe, it, expect } from "bun:test";
import { classifyRequest } from "@/utils/request-classifier";
import type { ProjectContext } from "@/utils/analyzer/index";

const baseCtx: ProjectContext = {
  projectName: "sages",
  language: "typescript",
  framework: "node",
  projectType: "library",
  techStack: {
    languages: ["TypeScript"],
    frameworks: ["node", "typescript"],
    buildTools: [],
    testing: ["bun:test"],
    linting: [],
  },
  structure: {
    rootDir: "/home/leroy/Project/sages",
    srcDir: "src",
    testDir: "test",
    configDir: null,
    mainFile: null,
    hasPackageJson: true,
    hasTsConfig: true,
    hasGoMod: false,
    hasCargoToml: false,
    hasRequirements: false,
    directoryTree: [],
  },
  patterns: ["ts-generics", "ts-interfaces", "ts-async-await"],
  existingComponents: ["utils", "services", "tools", "state", "analyzer", "executor"],
  keyFiles: [],
  dependencies: [],
};

describe("classifyRequest", () => {
  describe("improve mode (high overlap with existing code)", () => {
    it("returns 'improve' when request references an existing component", () => {
      const result = classifyRequest(
        baseCtx,
        "Add a method to the analyzer to handle monorepos",
      );
      expect(result.mode).toBe("improve");
      expect(result.signals.length).toBeGreaterThan(0);
      expect(result.signals.some(s => s.includes("analyzer"))).toBe(true);
    });

    it("returns 'improve' when request references multiple existing components", () => {
      const result = classifyRequest(
        baseCtx,
        "Refactor the utils and services to share types",
      );
      expect(result.mode).toBe("improve");
      expect(result.signals.some(s => s.includes("utils"))).toBe(true);
      expect(result.signals.some(s => s.includes("services"))).toBe(true);
    });

    it("returns 'improve' when request uses existing pattern names", () => {
      const result = classifyRequest(
        baseCtx,
        "Optimize the async/await pattern in the executor",
      );
      expect(result.mode).toBe("improve");
    });

    it("returns 'improve' for refactor/modify/fix verbs on existing code", () => {
      const refactor = classifyRequest(baseCtx, "Refactor the file service to be more robust");
      const fix = classifyRequest(baseCtx, "Fix a bug in the state manager");
      const modify = classifyRequest(baseCtx, "Modify the executor to support retries");

      expect(refactor.mode).toBe("improve");
      expect(fix.mode).toBe("improve");
      expect(modify.mode).toBe("improve");
    });
  });

  describe("new mode (low overlap with existing code)", () => {
    it("returns 'new' when request introduces concepts not in existing components", () => {
      const result = classifyRequest(
        baseCtx,
        "Add a brand new quantum entanglement module",
      );
      expect(result.mode).toBe("new");
    });

    it("returns 'new' when project context is unknown (no components to overlap with)", () => {
      const emptyCtx: ProjectContext = {
        ...baseCtx,
        language: "unknown",
        existingComponents: [],
        patterns: [],
      };
      const result = classifyRequest(emptyCtx, "Build anything");
      expect(result.mode).toBe("new");
    });

    it("returns 'new' for greenfield verbs (create, build, add new) without overlap", () => {
      const result = classifyRequest(
        baseCtx,
        "Create a totally separate billing subsystem",
      );
      // "billing" doesn't overlap with utils/services/tools/state
      expect(result.mode).toBe("new");
    });
  });

  describe("scoring", () => {
    it("provides a score (0-1) reflecting overlap strength", () => {
      const highOverlap = classifyRequest(
        baseCtx,
        "Add a method to utils and refactor services to use it",
      );
      const lowOverlap = classifyRequest(
        baseCtx,
        "Build a brand new quantum subsystem",
      );

      expect(highOverlap.score).toBeGreaterThan(lowOverlap.score);
      expect(highOverlap.score).toBeGreaterThan(0.5);
    });

    it("uses a threshold to decide mode", () => {
      // Document the threshold for transparency
      const result = classifyRequest(baseCtx, "Modify the utils helper");
      // 1 component hit out of 4 existing → score around 0.25, mode = "new"
      // because threshold should be high enough to require multiple signals
      expect(result.mode).toBe("improve"); // refactor verb pushes it over
    });
  });
});
