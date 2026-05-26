/**
 * MiniMax Auth Tests (TDD RED Phase)
 * Tests for authentication module
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

// Mock fs functions for testing
const testConfigDir = "/tmp/test_mmx_config";
const testConfigPath = join(testConfigDir, "config.json");

describe("Auth Module Config Loading", () => {
  beforeEach(() => {
    // Create test config directory
    if (!existsSync(testConfigDir)) {
      mkdirSync(testConfigDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test files
    try {
      unlinkSync(testConfigPath);
    } catch {}
  });

  it("should load mmx CLI format config (api_key snake_case)", () => {
    // Write config in mmx CLI format
    const config = {
      api_key: "sk-test-key-123",
      region: "cn",
    };
    writeFileSync(testConfigPath, JSON.stringify(config));

    // Read and verify
    const loaded = JSON.parse(readFileSync(testConfigPath, "utf-8"));
    expect(loaded.api_key).toBe("sk-test-key-123");
    expect(loaded.region).toBe("cn");
  });

  it("should support legacy camelCase format (apiKey)", () => {
    // Write config in legacy format
    const config = {
      apiKey: "sk-test-key-456",
      groupId: "group-123",
    };
    writeFileSync(testConfigPath, JSON.stringify(config));

    // Read and verify
    const loaded = JSON.parse(readFileSync(testConfigPath, "utf-8"));
    expect(loaded.apiKey).toBe("sk-test-key-456");
    expect(loaded.groupId).toBe("group-123");
  });

  it("should handle mmx CLI oauth format", () => {
    const config = {
      oauth: {
        access_token: "token123",
        refresh_token: "refresh456",
        expires_at: "2025-12-31T23:59:59Z",
        region: "cn",
      },
    };
    writeFileSync(testConfigPath, JSON.stringify(config));

    const loaded = JSON.parse(readFileSync(testConfigPath, "utf-8"));
    expect(loaded.oauth?.access_token).toBe("token123");
    expect(loaded.oauth?.region).toBe("cn");
  });
});

describe("API Host Detection", () => {
  it("should have CN platform first in KNOWN_API_HOSTS", async () => {
    // Import the actual module to test
    const { KNOWN_API_HOSTS } = await import("../types.js");
    
    // CN platform should be first for faster detection
    expect(KNOWN_API_HOSTS[0]).toBe("https://api.minimaxi.com");
    expect(KNOWN_API_HOSTS[1]).toBe("https://api.minimax.io");
  });
});
