/**
 * Model Helper - Get user's default model from settings
 * 
 * Reads from ~/.pi/agent/settings.json to get user's configured default model.
 * Falls back to "MiniMax-M2.7" if not configured.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_MODEL = "MiniMax-M2.7";

/**
 * Get the user's default model from pi settings
 * 
 * @returns User's default model or fallback
 */
export function getUserDefaultModel(): string {
  try {
    const settingsPath = join(homedir(), ".pi/agent/settings.json");
    
    if (!existsSync(settingsPath)) {
      return DEFAULT_MODEL;
    }
    
    const content = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    
    if (settings.defaultModel && typeof settings.defaultModel === "string") {
      return settings.defaultModel;
    }
    
    return DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}
