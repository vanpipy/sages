/**
 * MiniMax Authentication Module
 * Auto-detects credentials from multiple sources and supports auto-detection of API host
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { KNOWN_API_HOSTS, type MiniMaxCredentials } from "./types.js";

const CONFIG_DIR = join(homedir(), ".mmx");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CACHE_PATH = join(CONFIG_DIR, "auth-cache.json");

export interface AuthResult {
  credentials: MiniMaxCredentials;
  source: "config" | "cache" | "prompt";
  apiHost?: string; // Auto-detected API host
}

/**
 * Detect the correct API host by probing known endpoints
 * Returns the first host that responds successfully
 */
export async function detectApiHost(apiKey: string): Promise<string | undefined> {
  const timeout = 5000; // 5 second timeout per host

  for (const host of KNOWN_API_HOSTS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(`${host}/v1/text/chatcompletion_v2`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "MiniMax-M2.7",
          messages: [{ role: "user", content: "test" }],
          max_tokens: 5,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // status_code 0 = success, 1004 = invalid key, 2061 = model not available
      // Any 2xx response means the host accepts this key
      if (response.ok) {
        return host;
      }
    } catch {
      // Try next host
    }
  }

  return undefined;
}

/**
 * Get API key from environment variables
 */
function getApiKeyFromEnv(): string | null {
  return (
    process.env.MINIMAX_API_KEY ||
    process.env.OPENCODE_MINIMAX_API_KEY ||
    process.env.MINIMAX_CN_API_KEY ||
    null
  );
}

/**
 * Get API host from environment
 */
function getApiHostFromEnv(): string | null {
  return process.env.MINIMAX_API_HOST || null;
}

/**
 * Load credentials from config file (~/.mmx/config.json)
 */
function loadFromConfig(): MiniMaxCredentials | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (config.apiKey) {
      return {
        apiKey: config.apiKey,
        groupId: config.groupId,
      };
    }
  } catch {
    // Config exists but invalid
  }

  return null;
}

/**
 * Load credentials from cache (~/.mmx/auth-cache.json)
 */
function loadFromCache(): MiniMaxCredentials | null {
  if (!existsSync(CACHE_PATH)) {
    return null;
  }

  try {
    const cached = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    if (cached.apiKey) {
      return {
        apiKey: cached.apiKey,
        groupId: cached.groupId,
      };
    }
  } catch {
    // Cache invalid
  }

  return null;
}

/**
 * Cache credentials for future use
 */
export function cacheCredentials(credentials: MiniMaxCredentials): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(credentials, null, 2));
  } catch {
    // Silently fail if cache is not writable
  }
}

/**
 * Load credentials with auto-detection strategy:
 * 1. Environment variables (MINIMAX_API_KEY)
 * 2. Config file (~/.mmx/config.json)
 * 3. Cache (~/.mmx/auth-cache.json)
 * 4. Return null if none available
 */
export function loadCredentials(): AuthResult | null {
  // 1. Environment variables
  const envKey = getApiKeyFromEnv();
  if (envKey) {
    const envHost = getApiHostFromEnv() || undefined;
    return {
      credentials: { apiKey: envKey },
      source: "config",
      apiHost: envHost,
    };
  }

  // 2. Config file
  const configCreds = loadFromConfig();
  if (configCreds) {
    return {
      credentials: configCreds,
      source: "config",
    };
  }

  // 3. Cache
  const cacheCreds = loadFromCache();
  if (cacheCreds) {
    return {
      credentials: cacheCreds,
      source: "cache",
    };
  }

  return null;
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
    // Auto-detect API host if not already known
    if (!loaded.apiHost) {
      loaded.apiHost = await detectApiHost(loaded.credentials.apiKey);
    }
    return loaded;
  }

  if (!promptFn) {
    throw new Error(
      "No MiniMax credentials found. Please:\n" +
      "1. Set MINIMAX_API_KEY environment variable, or\n" +
      "2. Run `mmx auth login` to configure, or\n" +
      "3. Provide API key via prompt"
    );
  }

  const apiKey = await promptFn("Enter your MiniMax API Key: ");
  if (!apiKey) {
    throw new Error("API key is required");
  }

  const groupId = await promptFn("Enter your Group ID (optional, press Enter to skip): ");

  const credentials: MiniMaxCredentials = {
    apiKey: apiKey.trim(),
    groupId: groupId?.trim() || undefined,
  };

  cacheCredentials(credentials);

  // Auto-detect API host
  const apiHost = await detectApiHost(credentials.apiKey);

  return {
    credentials,
    source: "prompt",
    apiHost: apiHost || undefined,
  };
}

/**
 * Get a specific API host, with fallback
 */
export function getApiHost(configuredHost?: string): string {
  if (configuredHost) {
    return configuredHost;
  }

  // Check environment
  const envHost = process.env.MINIMAX_API_HOST;
  if (envHost) {
    return envHost;
  }

  // Default to CN platform (most common)
  return "https://api.minimaxi.com";
}
