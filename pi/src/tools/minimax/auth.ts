/**
 * MiniMax Authentication Module
 * Auto-detects credentials from config file, fallback to prompt + cache
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_PATH = join(homedir(), ".mmx", "config.json");
const CACHE_PATH = join(homedir(), ".mmx", "auth-cache.json");

export interface MiniMaxCredentials {
  apiKey: string;
  groupId?: string;
}

export interface AuthResult {
  credentials: MiniMaxCredentials;
  source: "config" | "cache" | "prompt";
}

/**
 * Load credentials with auto-detection strategy:
 * 1. Check ~/.mmx/config.json
 * 2. Fallback to cached credentials
 * 3. Return null if none available
 */
export function loadCredentials(): AuthResult | null {
  // Try config file first
  if (existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      if (config.apiKey) {
        return {
          credentials: { apiKey: config.apiKey, groupId: config.groupId },
          source: "config",
        };
      }
    } catch {
      // Config exists but invalid, continue to cache
    }
  }

  // Try cache
  if (existsSync(CACHE_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
      if (cached.apiKey) {
        return {
          credentials: { apiKey: cached.apiKey, groupId: cached.groupId },
          source: "cache",
        };
      }
    } catch {
      // Cache invalid
    }
  }

  return null;
}

/**
 * Cache credentials for future use
 */
export function cacheCredentials(credentials: MiniMaxCredentials): void {
  const dir = join(homedir(), ".mmx");
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(credentials, null, 2));
  } catch {
    // Silently fail if cache directory is not writable
  }
}

/**
 * Get or prompt for credentials
 * @param promptFn - Function to prompt user for API key
 */
export async function getCredentials(
  promptFn?: (message: string) => Promise<string>
): Promise<AuthResult> {
  const loaded = loadCredentials();
  if (loaded) {
    return loaded;
  }

  if (!promptFn) {
    throw new Error(
      "No credentials found. Please set up ~/.mmx/config.json or provide API key."
    );
  }

  const apiKey = await promptFn("Enter your MiniMax API Key: ");
  if (!apiKey) {
    throw new Error("API key is required");
  }

  const groupId = await promptFn("Enter your Group ID (optional): ");

  const credentials: MiniMaxCredentials = {
    apiKey: apiKey.trim(),
    groupId: groupId?.trim() || undefined,
  };

  cacheCredentials(credentials);

  return { credentials, source: "prompt" };
}
