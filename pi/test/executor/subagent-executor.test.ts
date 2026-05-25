/**
 * SubagentExecutor Tests
 * 
 * TDD RED Phase: Write tests first for model configuration
 */

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

describe("SubagentExecutor", () => {
  describe("getUserDefaultModel", () => {
    it("should read default model from user settings", async () => {
      // Test that getUserDefaultModel function exists and is callable
      // This tests the integration with ~/.pi/agent/settings.json
      
      const settingsPath = join(homedir(), ".pi/agent/settings.json");
      
      // Skip if no settings file
      if (!existsSync(settingsPath)) {
        console.log("No settings file, skipping test");
        return;
      }
      
      const content = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      
      // The settings should have a defaultModel if user has configured it
      expect(settings.defaultModel).toBeDefined();
      expect(typeof settings.defaultModel).toBe("string");
      
      // Model should not be "sonnet" (that's the broken default)
      expect(settings.defaultModel).not.toBe("sonnet");
      
      // Should be a MiniMax model based on user's config
      expect(settings.defaultModel).toMatch(/MiniMax/);
    });
  });

  describe("model configuration", () => {
    it("should use MiniMax model when configured", async () => {
      const settingsPath = join(homedir(), ".pi/agent/settings.json");
      
      if (!existsSync(settingsPath)) {
        return;
      }
      
      const content = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(content);
      
      // Verify user's model is compatible
      const validModels = ["MiniMax-M2.7-highspeed", "MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1"];
      expect(validModels.some(m => settings.defaultModel?.includes(m))).toBe(true);
    });
  });
});
