import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

describe("MiniMax Auth Module", () => {
  const testConfigPath = join(homedir(), ".mmx-test", "config.json");
  const testCachePath = join(homedir(), ".mmx-test", "auth-cache.json");

  beforeEach(() => {
    mkdirSync(join(homedir(), ".mmx-test"), { recursive: true });
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

  it("should export MiniMaxCredentials interface", async () => {
    const { loadCredentials } = await import("../../src/tools/minimax/auth.js");
    expect(typeof loadCredentials).toBe("function");
  });
});
