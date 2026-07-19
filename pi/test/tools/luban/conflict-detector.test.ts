/**
 * Tests for conflict-detector.ts — path helpers used by luban_execute_task
 *
 * Contract under test (live helpers after luban_run_batch removal):
 *   - normalizeFilePath(path): normalize backslashes, trailing slashes,
 *     "./" prefix, and case for path comparison
 *   - deriveTestFiles(sources): default test-file paths from source files
 *
 * detectFileConflicts was removed when luban_run_batch was deleted — batch
 * conflict detection is no longer performed at the tool runtime.
 */

import { describe, it, expect } from "bun:test";
import {
  normalizeFilePath,
  deriveTestFiles,
} from "@/tools/luban/conflict-detector.js";

// ---------------------------------------------------------------------------
// normalizeFilePath
// ---------------------------------------------------------------------------

describe("normalizeFilePath", () => {
  it("treats ./src/a.ts and src/a.ts as the same path", () => {
    expect(normalizeFilePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeFilePath("src/a.ts")).toBe("src/a.ts");
  });

  it("treats backslash and forward-slash paths as equivalent", () => {
    expect(normalizeFilePath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeFilePath("src/a/b/c.ts")).toBe("src/a/b/c.ts");
  });

  it("strips trailing slashes", () => {
    expect(normalizeFilePath("src/a/")).toBe("src/a");
    expect(normalizeFilePath("src/a///")).toBe("src/a");
  });

  it("lowercases for case-insensitive filesystems", () => {
    expect(normalizeFilePath("Src/Auth.ts")).toBe("src/auth.ts");
    expect(normalizeFilePath("SRC/AUTH.TS")).toBe("src/auth.ts");
  });
});

// ---------------------------------------------------------------------------
// deriveTestFiles
// ---------------------------------------------------------------------------

describe("deriveTestFiles — shared helper (replaces 3x DRY violation)", () => {
  it("derives .test.ts from .ts", () => {
    expect(deriveTestFiles(["src/auth.ts"])).toEqual(["src/auth.test.ts"]);
  });

  it("derives .test.js from .js", () => {
    expect(deriveTestFiles(["src/auth.js"])).toEqual(["src/auth.test.js"]);
  });

  it("leaves non-ts/js files unchanged", () => {
    expect(deriveTestFiles(["README.md", "src/auth.ts"])).toEqual([
      "README.md",
      "src/auth.test.ts",
    ]);
  });

  it("handles empty input", () => {
    expect(deriveTestFiles([])).toEqual([]);
  });
});