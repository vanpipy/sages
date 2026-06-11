/**
 * mcp-server-manager.test.ts - State machine tests for McpServerManager
 *
 * Tests the 8 critical scenarios from design doc §5.4.
 * Uses a mock server (no real npx/alibabacloud-devops-mcp-server spawn).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { McpServerManager } from "../src/services/mcp-server-manager.js";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("McpServerManager state machine", () => {
  let workDir: string;
  let pidFile: string;
  let lastUsedFile: string;
  let logFile: string;
  let lockFile: string;
  let stateDir: string;
  let mgr: McpServerManager;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "mcp-mgr-"));
    stateDir = workDir;
    pidFile = join(stateDir, "server.pid");
    lastUsedFile = join(stateDir, "server.lastused");
    logFile = join(stateDir, "server.log");
    lockFile = join(stateDir, "lock");
  });

  afterEach(async () => {
    if (mgr) await mgr.stop().catch(() => {});
    await rm(workDir, { recursive: true, force: true });
  });

  function makeManager(opts: {
    serverCommand?: string;
    serverArgs?: string[];
    healthCheckFn?: () => Promise<boolean>;
    healthFailureThreshold?: number;
  } = {}) {
    mgr = new McpServerManager({
      port: 13000 + Math.floor(Math.random() * 1000), // unique port
      stateDir,
      pidFile,
      lastUsedFile,
      logFile,
      lockFile,
      idleTimeoutMin: 10,
      apiBaseUrl: "https://codeup.aliyun.com",
      serverCommand: opts.serverCommand ?? "true", // `true` exits 0 immediately
      serverArgs: opts.serverArgs ?? [],
      mcpGlobal: true,
      healthCheckTimeoutMs: 1000,
      healthCheckMaxTries: 3,
      healthFailureThreshold: opts.healthFailureThreshold ?? 2,
      credentialsFile: "/nonexistent",
      token: "pt-test",
    });
    if (opts.healthCheckFn) {
      mgr.setHealthCheckForTest(opts.healthCheckFn);
    }
  }

  describe("Scenario 1: ensureServer on fresh state", () => {
    it("spawns server and writes PID file", async () => {
      makeManager({ serverCommand: "sleep", serverArgs: ["60"] });
      const status = await mgr.ensureServer();
      expect(status.running).toBe(true);
      expect(status.pid).toBeDefined();
      expect(status.pid).toBeGreaterThan(0);
      const pidContent = await readFile(pidFile, "utf-8");
      expect(parseInt(pidContent)).toBe(status.pid);
    });

    it("is idempotent - second ensureServer reuses running server", async () => {
      makeManager({ serverCommand: "sleep", serverArgs: ["60"] });
      const s1 = await mgr.ensureServer();
      const s2 = await mgr.ensureServer();
      expect(s1.pid).toBe(s2.pid);
    });
  });

  describe("Scenario 2: health check 2-failure threshold", () => {
    it("kills server after 2 consecutive health failures and respawns", async () => {
      // First ensureServer spawns a real sleep
      makeManager({
        serverCommand: "sleep", serverArgs: ["60"],
        healthCheckFn: async () => false, // simulate dead server
      });
      // First call: spawn server (we bypass health check by calling internals)
      const status1 = await mgr.ensureServer();
      expect(status1.running).toBe(true);
      const pid1 = status1.pid;

      // Now set healthCheck to return true (server actually OK)
      mgr.setHealthCheckForTest(async () => true);
      // ensureServer sees existing PID + healthy = reuse
      const status2 = await mgr.ensureServer();
      expect(status2.pid).toBe(pid1);

      // Now flip healthCheck to fail
      mgr.setHealthCheckForTest(async () => false);
      // ensureServer sees unhealthy, but below threshold (1 < 2) — no respawn
      const status3a = await mgr.ensureServer();
      expect(status3a.running).toBe(true);
      expect(status3a.healthy).toBe(false);
      expect(status3a.pid).toBe(pid1);
      // Second consecutive failure reaches threshold (2) — should respawn
      const status3b = await mgr.ensureServer();
      expect(status3b.running).toBe(true);
      // After respawn, server is healthy (we just spawned a fresh one)
      expect(status3b.healthy).toBe(true);
      // pid should be different (respawned)
      expect(status3b.pid).not.toBe(pid1);
    });
  });

  describe("Scenario 3: checkIdleKill after threshold", () => {
    it("does not kill if last_used recent", async () => {
      makeManager({ serverCommand: "sleep", serverArgs: ["60"] });
      await mgr.ensureServer();
      await mgr.touch();
      const result = await mgr.checkIdleKill({ idleThresholdMin: 10 });
      expect(result.killed).toBe(false);
    });

    it("kills if last_used older than threshold", async () => {
      makeManager({ serverCommand: "sleep", serverArgs: ["60"] });
      await mgr.ensureServer();
      // Backdate last_used to 20 min ago
      const oldTime = Math.floor(Date.now() / 1000) - 20 * 60;
      await writeFile(lastUsedFile, String(oldTime));
      const result = await mgr.checkIdleKill({ idleThresholdMin: 10 });
      expect(result.killed).toBe(true);
      // PID file should be gone
      await expect(readFile(pidFile, "utf-8")).rejects.toThrow();
    });
  });

  describe("Scenario 4: stale PID file (crash recovery)", () => {
    it("spawns new server when PID file exists but process is dead", async () => {
      makeManager({ serverCommand: "sleep", serverArgs: ["60"] });
      // Write a stale PID (a PID that doesn't exist)
      await writeFile(pidFile, "999999");
      // Mock health check to fail so ensureServer respawns
      mgr.setHealthCheckForTest(async () => false);
      // First call: 1 failure, below threshold (2), no respawn
      await mgr.ensureServer();
      // Second call: 2 consecutive failures, exceeds threshold — respawn
      const status = await mgr.ensureServer();
      expect(status.running).toBe(true);
      expect(status.pid).not.toBe(999999);
    });
  });

  describe("Scenario 5: stop releases lock and PID", () => {
    it("removes PID file and kills process", async () => {
      makeManager({ serverCommand: "sleep", serverArgs: ["60"] });
      await mgr.ensureServer();
      const result = await mgr.stop();
      expect(result.stopped).toBe(true);
      // PID file should be gone
      await expect(readFile(pidFile, "utf-8")).rejects.toThrow();
    });
  });

  describe("Scenario 6: status query", () => {
    it("reports not installed when no process", async () => {
      makeManager({ serverCommand: "missing-binary" });
      // Don't actually spawn - just query
      const status = await mgr.status();
      expect(status.running).toBe(false);
    });

    it("reports running when PID alive", async () => {
      makeManager({ serverCommand: "sleep", serverArgs: ["60"] });
      await mgr.ensureServer();
      const status = await mgr.status();
      expect(status.running).toBe(true);
      expect(status.pid).toBeDefined();
      expect(status.idleMinutes).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Scenario 7: touch updates last_used", () => {
    it("writes current epoch to lastUsedFile", async () => {
      makeManager({ serverCommand: "sleep", serverArgs: ["60"] });
      await mgr.ensureServer();
      await mgr.touch();
      const content = await readFile(lastUsedFile, "utf-8");
      const lastUsed = parseInt(content.trim());
      const now = Math.floor(Date.now() / 1000);
      expect(Math.abs(now - lastUsed)).toBeLessThan(5);
    });
  });

  describe("Scenario 8: concurrent ensureServer is safe", () => {
    it("serializes concurrent calls via flock", async () => {
      makeManager({ serverCommand: "sleep", serverArgs: ["60"] });
      // Fire 3 concurrent ensureServer calls
      const results = await Promise.all([
        mgr.ensureServer(),
        mgr.ensureServer(),
        mgr.ensureServer(),
      ]);
      // All should return the same PID (single server spawned)
      const pids = results.map((r) => r.pid);
      expect(new Set(pids).size).toBe(1);
    });
  });
});
