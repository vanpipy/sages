import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, defaultConfig } from "../src/services/config.js";
import { expandPath } from "../src/utils/env-detect.js";

describe("config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env after each test
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }
  });

  it("returns defaults when no env vars set", async () => {
    delete process.env.YUNXIAO_MCP_PORT;
    delete process.env.YUNXIAO_MCP_IDLE_MIN;
    delete process.env.YUNXIAO_STATE_DIR;
    delete process.env.YUNXIAO_API_BASE_URL;
    delete process.env.YUNXIAO_MCP_GLOBAL;
    delete process.env.YUNXIAO_ACCESS_TOKEN;

    const cfg = await loadConfig();
    expect(cfg.port).toBe(3000);
    expect(cfg.idleTimeoutMin).toBe(10);
    expect(cfg.apiBaseUrl).toBe("https://codeup.aliyun.com");
    expect(cfg.mcpGlobal).toBe(false);
    expect(cfg.token).toBeUndefined();
  });

  it("reads port from env", async () => {
    process.env.YUNXIAO_MCP_PORT = "8080";
    const cfg = await loadConfig();
    expect(cfg.port).toBe(8080);
  });

  it("reads idle timeout from env", async () => {
    process.env.YUNXIAO_MCP_IDLE_MIN = "30";
    const cfg = await loadConfig();
    expect(cfg.idleTimeoutMin).toBe(30);
  });

  it("expands ~ in stateDir", async () => {
    process.env.YUNXIAO_STATE_DIR = "~/.cache/yunxiao-mcp";
    const cfg = await loadConfig();
    expect(cfg.stateDir).toMatch(/^\/home\/[^/]+\/.cache\/yunxiao-mcp$/);
  });

  it("default stateDir uses XDG", async () => {
    delete process.env.YUNXIAO_STATE_DIR;
    delete process.env.HOME;
    process.env.HOME = "/tmp/test-home";
    const cfg = await loadConfig();
    expect(cfg.stateDir).toBe("/tmp/test-home/.cache/yunxiao-mcp");
  });

  it("resolves derived paths", async () => {
    process.env.HOME = "/tmp/x";
    process.env.YUNXIAO_STATE_DIR = "/var/lib/yx";
    const cfg = await loadConfig();
    expect(cfg.pidFile).toBe("/var/lib/yx/server.pid");
    expect(cfg.lastUsedFile).toBe("/var/lib/yx/server.lastused");
    expect(cfg.logFile).toBe("/var/lib/yx/server.log");
    expect(cfg.lockFile).toBe("/var/lib/yx/lock");
  });

  it("expandPath handles tilde", () => {
    process.env.HOME = "/home/foo";
    expect(expandPath("~/bar")).toBe("/home/foo/bar");
    expect(expandPath("/abs/path")).toBe("/abs/path");
    expect(expandPath("relative")).toMatch(/relative$/);
  });

  it("MCP_GLOBAL=true means use global binary", async () => {
    process.env.YUNXIAO_MCP_GLOBAL = "1";
    const cfg = await loadConfig();
    expect(cfg.mcpGlobal).toBe(true);
    expect(cfg.serverCommand).toBe("alibabacloud-devops-mcp-server");
    expect(cfg.serverArgs).toEqual(["--streamable-http"]);
  });

  it("default serverCommand is npx", async () => {
    delete process.env.YUNXIAO_MCP_GLOBAL;
    const cfg = await loadConfig();
    expect(cfg.serverCommand).toBe("npx");
    expect(cfg.serverArgs).toEqual(["-y", "alibabacloud-devops-mcp-server", "--streamable-http"]);
  });

  it("reads token from env", async () => {
    process.env.YUNXIAO_ACCESS_TOKEN = "pt-test123";
    const cfg = await loadConfig();
    expect(cfg.token).toBe("pt-test123");
  });
});
