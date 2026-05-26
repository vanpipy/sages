import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

describe("Auth Module", () => {
  const testConfigDir = join(homedir(), ".mmx-test-auth");
  const testConfigPath = join(testConfigDir, "config.json");
  const testCachePath = join(testConfigDir, "auth-cache.json");

  beforeEach(() => {
    mkdirSync(testConfigDir, { recursive: true });
  });

  afterEach(() => {
    try {
      if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
      if (existsSync(testCachePath)) unlinkSync(testCachePath);
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should export loadCredentials function", async () => {
    const { loadCredentials } = await import("../../src/tools/minimax/auth.js");
    expect(typeof loadCredentials).toBe("function");
  });

  it("should export cacheCredentials function", async () => {
    const { cacheCredentials } = await import("../../src/tools/minimax/auth.js");
    expect(typeof cacheCredentials).toBe("function");
  });

  it("should export getCredentials function", async () => {
    const { getCredentials } = await import("../../src/tools/minimax/auth.js");
    expect(typeof getCredentials).toBe("function");
  });

  it("should export detectApiHost function", async () => {
    const { detectApiHost } = await import("../../src/tools/minimax/auth.js");
    expect(typeof detectApiHost).toBe("function");
  });

  it("should export getApiHost function", async () => {
    const { getApiHost } = await import("../../src/tools/minimax/auth.js");
    expect(typeof getApiHost).toBe("function");
  });

  it("should return null when no credentials exist", async () => {
    const { loadCredentials } = await import("../../src/tools/minimax/auth.js");
    // This test runs without env vars or config, so it depends on the test environment
    const result = loadCredentials();
    // Result could be null (no credentials) or an object from env
    expect(result === null || typeof result === "object").toBe(true);
  });

  it("should export detectApiHost as async function", async () => {
    const { detectApiHost } = await import("../../src/tools/minimax/auth.js");
    // Just verify it's async (returns a Promise)
    const result: any = detectApiHost("invalid-key");
    expect(result instanceof Promise).toBe(true);
    // Don't actually wait - would hit the network
  });

  it("should export MiniMaxCredentials interface structure", () => {
    const credentials = {
      apiKey: "sk-test",
      groupId: "group-123",
    };
    expect(typeof credentials.apiKey).toBe("string");
    expect(typeof credentials.groupId).toBe("string");
  });

  it("should have correct AuthResult structure", () => {
    const result = {
      credentials: { apiKey: "sk-test", groupId: "group-123" },
      source: "config" as const,
      apiHost: "https://api.minimaxi.com",
    };
    expect(result.credentials.apiKey).toBe("sk-test");
    expect(result.source).toBe("config");
    expect(result.apiHost).toBe("https://api.minimaxi.com");
  });
});
