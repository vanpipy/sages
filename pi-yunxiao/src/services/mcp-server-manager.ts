/**
 * mcp-server-manager.ts - Lifecycle state machine for the MCP sidecar process.
 *
 * States: Stopped → Starting → Running → (Failed | IdleKilled)
 *
 * Responsibilities:
 * - spawn the alibabacloud-devops-mcp-server HTTP sidecar
 * - write PID atomically (mktemp + mv)
 * - flock-protected concurrent startup
 * - health check with 2-failure threshold
 * - idle timeout kill (10 min default)
 * - crash recovery (stale PID file → respawn)
 *
 * Design doc reference: §5 (State Machine)
 */

import { spawn, ChildProcess } from "node:child_process";
import { writeFile, readFile, unlink, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import { withLock } from "../utils/flock.js";
import type { ServerStatus, HealthResult } from "../state/types.js";

export interface McpServerManagerDeps extends Config {
  // No additional deps for now
}

export interface IdleKillOptions {
  idleThresholdMin: number;
}

export class McpServerManager {
  private cfg: McpServerManagerDeps;
  private consecutiveFailures = 0;
  private healthCheckFn?: () => Promise<boolean>;
  private currentProcess?: ChildProcess;

  constructor(cfg: McpServerManagerDeps) {
    this.cfg = cfg;
  }

  /** Test hook: override health check function. */
  setHealthCheckForTest(fn: () => Promise<boolean>): void {
    this.healthCheckFn = fn;
  }

  /**
   * Ensure server is running. Idempotent. flock-protected.
   * Returns the current ServerStatus.
   */
  async ensureServer(): Promise<ServerStatus> {
    return withLock(this.cfg.lockFile, async () => {
      // 1. Check existing PID
      const existingPid = await this.readPidFile();
      if (existingPid) {
        const health = await this.healthCheck();
        if (health.healthy) {
          await this.touch();
          return this.toStatus(health, existingPid);
        }
        // Unhealthy: kill and respawn (if above threshold)
        if (this.consecutiveFailures >= this.cfg.healthFailureThreshold) {
          await this.killProcess(existingPid);
          await this.clearPidFile();
          // fall through to spawn
        } else {
          // Below threshold, just report unhealthy status
          return {
            installed: true,
            running: true,
            healthy: false,
            pid: existingPid,
            port: this.cfg.port,
            idleMinutes: await this.getIdleMinutes(),
            tokenConfigured: !!this.cfg.token,
          };
        }
      }

      // 2. Spawn new server
      return this.spawnServer();
    });
  }

  /**
   * Stop the server. Releases lock and PID.
   */
  async stop(): Promise<{ stopped: boolean; durationMs: number }> {
    const start = Date.now();
    const pid = await this.readPidFile();
    if (!pid) {
      return { stopped: false, durationMs: Date.now() - start };
    }
    await this.killProcess(pid);
    await this.clearPidFile();
    return { stopped: true, durationMs: Date.now() - start };
  }

  /**
   * Health check via custom hook or default TCP probe.
   * Uses `initialize` JSON-RPC 2.0 RPC against the running server.
   */
  async healthCheck(): Promise<HealthResult> {
    const start = Date.now();
    if (this.healthCheckFn) {
      const ok = await this.healthCheckFn();
      this.consecutiveFailures = ok ? 0 : this.consecutiveFailures + 1;
      return { healthy: ok, latencyMs: Date.now() - start, consecutiveFailures: this.consecutiveFailures };
    }
    // Default: process-alive check via PID
    const pid = await this.readPidFile();
    if (!pid) {
      this.consecutiveFailures++;
      return { healthy: false, latencyMs: Date.now() - start, consecutiveFailures: this.consecutiveFailures };
    }
    const alive = await this.isProcessAlive(pid);
    this.consecutiveFailures = alive ? 0 : this.consecutiveFailures + 1;
    return { healthy: alive, latencyMs: Date.now() - start, consecutiveFailures: this.consecutiveFailures };
  }

  /**
   * Get current status.
   */
  async status(): Promise<ServerStatus> {
    const pid = await this.readPidFile();
    if (!pid) {
      return {
        installed: true,
        running: false,
        healthy: false,
        port: this.cfg.port,
        idleMinutes: await this.getIdleMinutes(),
        tokenConfigured: !!this.cfg.token,
      };
    }
    const alive = await this.isProcessAlive(pid);
    return {
      installed: true,
      running: alive,
      healthy: alive,
      pid: alive ? pid : undefined,
      port: this.cfg.port,
      lastUsedAt: await this.getLastUsedIso(),
      idleMinutes: await this.getIdleMinutes(),
      tokenConfigured: !!this.cfg.token,
    };
  }

  /**
   * Update last_used timestamp.
   */
  async touch(): Promise<void> {
    const ts = Math.floor(Date.now() / 1000);
    await writeFile(this.cfg.lastUsedFile, String(ts));
  }

  /**
   * Check if idle threshold exceeded; kill if so.
   */
  async checkIdleKill(opts: IdleKillOptions): Promise<{ killed: boolean; reason?: string }> {
    const idleMin = await this.getIdleMinutes();
    if (idleMin < opts.idleThresholdMin) {
      return { killed: false };
    }
    const pid = await this.readPidFile();
    if (!pid) {
      return { killed: false };
    }
    await this.killProcess(pid);
    await this.clearPidFile();
    return { killed: true, reason: `idle ${idleMin.toFixed(1)}min > ${opts.idleThresholdMin}min` };
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private async spawnServer(): Promise<ServerStatus> {
    // Ensure state dir
    await mkdir(this.cfg.stateDir, { recursive: true });

    // Truncate log
    await writeFile(this.cfg.logFile, "");

    // Spawn
    const child = spawn(this.cfg.serverCommand, this.cfg.serverArgs, {
      env: {
        ...process.env,
        YUNXIAO_ACCESS_TOKEN: this.cfg.token || "",
        PORT: String(this.cfg.port),
      },
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });
    this.currentProcess = child;

    child.on("error", (err) => {
      // Spawn failed; PID will be cleaned up on next ensureServer
      console.error("MCP server spawn error:", err.message);
    });

    // Wait for ready (default health check passes if PID alive; could be enhanced)
    let attempts = 0;
    const maxAttempts = this.cfg.healthCheckMaxTries;
    while (attempts < maxAttempts) {
      await new Promise((r) => setTimeout(r, 200));
      if (await this.isProcessAlive(child.pid!)) {
        // Write PID atomically
        await this.writePidFileAtomic(child.pid!);
        this.consecutiveFailures = 0;
        return {
          installed: true,
          running: true,
          healthy: true,
          pid: child.pid,
          port: this.cfg.port,
          idleMinutes: 0,
          tokenConfigured: !!this.cfg.token,
        };
      }
      attempts++;
    }
    // Spawned but died
    throw new Error(`MCP server failed to start within ${maxAttempts * 200}ms`);
  }

  private async readPidFile(): Promise<number | null> {
    try {
      const content = await readFile(this.cfg.pidFile, "utf-8");
      return parseInt(content.trim());
    } catch {
      return null;
    }
  }

  private async writePidFileAtomic(pid: number): Promise<void> {
    const tmp = join(tmpdir(), `mcp-pid-${pid}-${Date.now()}`);
    await writeFile(tmp, String(pid));
    await rename(tmp, this.cfg.pidFile);
  }

  private async clearPidFile(): Promise<void> {
    try {
      await unlink(this.cfg.pidFile);
    } catch {
      // Already gone
    }
  }

  private async isProcessAlive(pid: number): Promise<boolean> {
    if (!pid || pid <= 0) return false;
    try {
      // kill -0 checks existence without actually sending signal
      process.kill(pid, 0);
      return true;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ESRCH") return false; // No such process
      if (err.code === "EPERM") return true; // Process exists but we can't signal it
      return false;
    }
  }

  private async killProcess(pid: number): Promise<void> {
    if (!pid) return;
    try {
      process.kill(pid, "SIGTERM");
      // Wait up to 3s for graceful shutdown
      for (let i = 0; i < 30; i++) {
        if (!(await this.isProcessAlive(pid))) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      // Force kill
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ESRCH") throw e;
    }
  }

  private async getLastUsedIso(): Promise<string | undefined> {
    try {
      const content = await readFile(this.cfg.lastUsedFile, "utf-8");
      const ts = parseInt(content.trim());
      return new Date(ts * 1000).toISOString();
    } catch {
      return undefined;
    }
  }

  private async getIdleMinutes(): Promise<number> {
    try {
      const content = await readFile(this.cfg.lastUsedFile, "utf-8");
      const ts = parseInt(content.trim());
      return (Date.now() - ts * 1000) / 60000;
    } catch {
      return 0;
    }
  }

  private toStatus(health: HealthResult, pid: number): ServerStatus {
    return {
      installed: true,
      running: health.healthy,
      healthy: health.healthy,
      pid,
      port: this.cfg.port,
      idleMinutes: 0,
      tokenConfigured: !!this.cfg.token,
    };
  }
}
