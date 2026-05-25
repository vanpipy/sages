/**
 * Tests for model-helper
 * TDD RED Phase: Tests should verify getUserDefaultModel works
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getUserDefaultModel } from "../../src/utils/model-helper.js";

describe("getUserDefaultModel", () => {
  const testSettingsPath = join(homedir(), ".pi/agent/settings.json");
  const backupPath = join(homedir(), ".pi/agent/settings.json.backup");

  beforeAll(() => {
    // Backup existing settings if present
    if (existsSync(testSettingsPath)) {
      const content = readFileSync(testSettingsPath, "utf-8");
      writeFileSync(backupPath, content);
    }
  });

  afterAll(() => {
    // Restore backup
    if (existsSync(backupPath)) {
      const content = readFileSync(backupPath, "utf-8");
      writeFileSync(testSettingsPath, content);
      unlinkSync(backupPath);
    }
  });

  it("should return a non-empty string", () => {
    const model = getUserDefaultModel();
    expect(typeof model).toBe("string");
    expect(model.length).toBeGreaterThan(0);
  });

  it("should contain MiniMax by default", () => {
    const model = getUserDefaultModel();
    expect(model).toContain("MiniMax");
  });

  it("should return configured model when present", () => {
    // Write test settings
    const testSettings = {
      defaultModel: "MiniMax-M2.5",
    };
    
    // Ensure directory exists
    const dir = join(homedir(), ".pi/agent");
    if (!existsSync(dir)) {
      require("node:fs").mkdirSync(dir, { recursive: true });
    }
    
    writeFileSync(testSettingsPath, JSON.stringify(testSettings));
    
    const model = getUserDefaultModel();
    expect(model).toBe("MiniMax-M2.5");
  });
});
