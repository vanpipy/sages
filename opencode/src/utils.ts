/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║                                                                           ║
 * ║   🜄 Sages Plugin - Utilities 🜄                                          ║
 * ║                                                                           ║
 * ║   Shared utility functions for logging, file operations, and helpers    ║
 * ║                                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ToolResult,
  ToolSuccess,
  ToolError,
  SessionPersistence,
  SessionState,
  FileLockRegistry,
  FileLock,
} from "./types.js";

// Re-export node:fs/node:path utilities for convenience
export { appendFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync, readdirSync, statSync } from "node:fs";
export { join, dirname, basename, extname } from "node:path";

// =============================================================================
// Constants
// =============================================================================

const LOG_DIR = join(homedir(), ".config", "sages", "logs");
const COMPACTION_LOG = join(LOG_DIR, "compaction.log");

// .sages/ directory structure in project root
const SAGES_DIR = ".sages";
const SESSIONS_DIR = join(SAGES_DIR, "sessions");
const SESSION_FILE = join(SESSIONS_DIR, "sessions.json");
const LOCKS_DIR = join(SAGES_DIR, "locks");
const PLANS_DIR = join(SAGES_DIR, "plans");

// =============================================================================
// Log Directory Management
// =============================================================================

export function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

// =============================================================================
// Compaction Logging (Fuxi Context Prevention)
// =============================================================================

export function logCompaction(
  level: "info" | "debug" | "warn" | "error",
  msg: string,
  data?: Record<string, unknown>,
): void {
  try {
    ensureLogDir();
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg,
      ...data,
    });
    appendFileSync(COMPACTION_LOG, entry + "\n");
  } catch {
    // Silently fail - logging should never break the plugin
  }
}

// =============================================================================
// Tool Logging
// =============================================================================

function getDateStampedLogPath(type: "tools" | "errors" | "sages"): string {
  const today = new Date().toISOString().split("T")[0];
  return join(LOG_DIR, `${type}-${today}.log`);
}

export function rotateLogFiles(): void {
  try {
    ensureLogDir();
    const files = readdirSync(LOG_DIR);
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!/^(tools|errors|sages)-\d{4}-\d{2}-\d{2}\.log$/.test(file)) {
        continue;
      }
      const filePath = join(LOG_DIR, file);
      const stats = statSync(filePath);
      if (now - stats.mtimeMs > sevenDaysMs) {
        unlinkSync(filePath);
      }
    }
  } catch {
    // Silently fail
  }
}

export function logTool(
  toolName: string,
  args: Record<string, unknown>,
  result?: string,
  error?: string,
): void {
  try {
    ensureLogDir();
    rotateLogFiles();
    const logPath = getDateStampedLogPath("tools");
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      level: error ? "error" : "info",
      msg: `tool_call: ${toolName}`,
      tool: toolName,
      args,
      ...(result && { result }),
      ...(error && { error }),
    });
    appendFileSync(logPath, entry + "\n");
  } catch {
    // Silently fail
  }
}

export function logError(
  error: string,
  data?: Record<string, unknown>,
): void {
  try {
    ensureLogDir();
    rotateLogFiles();
    const logPath = getDateStampedLogPath("errors");
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      msg: error,
      ...data,
    });
    appendFileSync(logPath, entry + "\n");
  } catch {
    // Silently fail
  }
}

export function logSages(
  msg: string,
  data?: Record<string, unknown>,
): void {
  try {
    ensureLogDir();
    rotateLogFiles();
    const logPath = getDateStampedLogPath("sages");
    const entry = JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      msg,
      ...data,
    });
    appendFileSync(logPath, entry + "\n");
  } catch {
    // Silently fail
  }
}

// =============================================================================
// Session Persistence (Fuxi Recovery)
// =============================================================================

export function loadSessions(projectDir: string): SessionPersistence {
  ensureSagesDir(projectDir);
  const sessionPath = join(projectDir, SESSION_FILE);
  if (existsSync(sessionPath)) {
    try {
      return JSON.parse(readFileSync(sessionPath, "utf-8"));
    } catch {
      return { sessions: {} };
    }
  }
  return { sessions: {} };
}

export function saveSessions(projectDir: string, persistence: SessionPersistence): void {
  ensureSagesDir(projectDir);
  const sessionPath = join(projectDir, SESSION_FILE);
  writeFileSync(sessionPath, JSON.stringify(persistence, null, 2));
}

export function getActiveSession(projectDir: string): SessionState | null {
  const persistence = loadSessions(projectDir);
  if (persistence.activeSessionId && persistence.sessions[persistence.activeSessionId]) {
    return persistence.sessions[persistence.activeSessionId];
  }
  return null;
}

export function updateSession(projectDir: string, session: SessionState): void {
  const persistence = loadSessions(projectDir);
  persistence.sessions[session.id] = session;
  persistence.activeSessionId = session.id;
  saveSessions(projectDir, persistence);
  logSages("session_updated", { sessionId: session.id, status: session.status });
}

export function clearSession(projectDir: string, sessionId: string): void {
  const persistence = loadSessions(projectDir);
  delete persistence.sessions[sessionId];
  if (persistence.activeSessionId === sessionId) {
    persistence.activeSessionId = undefined;
  }
  saveSessions(projectDir, persistence);
  logSages("session_cleared", { sessionId });
}

// =============================================================================
// File Lock Management (Lu Ban Conflict Prevention)
// =============================================================================

function ensureLocksDir(projectDir: string): void {
  ensureSagesDir(projectDir);
  const lockDir = join(projectDir, LOCKS_DIR);
  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }
}

function getLockKey(taskId: string, filePath: string): string {
  return `${taskId}:${filePath}`;
}

function getLockFilePath(projectDir: string, taskId: string, filePath: string): string {
  const sanitized = filePath.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(projectDir, LOCKS_DIR, `${taskId}-${sanitized}.lock`);
}

export function acquireFileLock(
  projectDir: string,
  taskId: string,
  filePath: string,
  ttlMs?: number,
): { success: boolean; conflict?: { taskId: string; lockedBy: string; lockedAt: string } } {
  ensureLocksDir(projectDir);
  const lockFile = getLockFilePath(projectDir, taskId, filePath);
  const lockKey = getLockKey(taskId, filePath);

  // Check for existing lock
  const registry = loadFileLockRegistry(projectDir);
  const existingLock = registry.locks[lockKey];

  if (existingLock) {
    // Check if lock has expired
    if (existingLock.expiresAt && new Date(existingLock.expiresAt) < new Date()) {
      // Lock expired, allow acquisition
      delete registry.locks[lockKey];
    } else if (existingLock.taskId !== taskId) {
      // Another task holds the lock
      return {
        success: false,
        conflict: {
          taskId: existingLock.taskId,
          lockedBy: existingLock.lockedBy,
          lockedAt: existingLock.lockedAt,
        },
      };
    }
  }

  // Acquire lock
  const now = new Date().toISOString();
  const newLock: FileLock = {
    taskId,
    filePath,
    lockedBy: taskId, // In real impl, use actual agent name
    lockedAt: now,
    expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
  };

  registry.locks[lockKey] = newLock;
  saveFileLockRegistry(projectDir, registry);
  writeFileSync(lockFile, JSON.stringify(newLock));

  logSages("file_lock_acquired", { taskId, filePath });
  return { success: true };
}

export function releaseFileLock(projectDir: string, taskId: string, filePath: string): void {
  const lockKey = getLockKey(taskId, filePath);
  const registry = loadFileLockRegistry(projectDir);

  if (registry.locks[lockKey]) {
    delete registry.locks[lockKey];
    saveFileLockRegistry(projectDir, registry);

    const lockFile = getLockFilePath(projectDir, taskId, filePath);
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }

    logSages("file_lock_released", { taskId, filePath });
  }
}

export function releaseAllTaskLocks(projectDir: string, taskId: string): void {
  const registry = loadFileLockRegistry(projectDir);
  const keysToDelete: string[] = [];

  for (const [key, lock] of Object.entries(registry.locks)) {
    if (lock.taskId === taskId) {
      keysToDelete.push(key);
      const lockFile = getLockFilePath(projectDir, taskId, lock.filePath);
      if (existsSync(lockFile)) {
        unlinkSync(lockFile);
      }
    }
  }

  for (const key of keysToDelete) {
    delete registry.locks[key];
  }

  saveFileLockRegistry(projectDir, registry);
  logSages("all_task_locks_released", { taskId, count: keysToDelete.length });
}

export function loadFileLockRegistry(projectDir: string): FileLockRegistry {
  const lockDir = join(projectDir, LOCKS_DIR);
  const registryFile = join(lockDir, "registry.json");

  if (existsSync(registryFile)) {
    try {
      return JSON.parse(readFileSync(registryFile, "utf-8"));
    } catch {
      return { locks: {} };
    }
  }
  return { locks: {} };
}

function saveFileLockRegistry(projectDir: string, registry: FileLockRegistry): void {
  ensureLocksDir(projectDir);
  const registryFile = join(projectDir, LOCKS_DIR, "registry.json");
  writeFileSync(registryFile, JSON.stringify(registry, null, 2));
}

// =============================================================================
// .sages Directory Helpers
// =============================================================================

function ensureSagesDir(projectDir: string): void {
  const sagesDir = join(projectDir, SAGES_DIR);
  if (!existsSync(sagesDir)) {
    mkdirSync(sagesDir, { recursive: true });
  }
}

// =============================================================================
// Plan Directory Helpers
// =============================================================================

export function ensurePlanDir(projectDir: string): string {
  ensureSagesDir(projectDir);
  const planDir = join(projectDir, PLANS_DIR);
  if (!existsSync(planDir)) {
    mkdirSync(planDir, { recursive: true });
  }
  return planDir;
}

// =============================================================================
// Tool Result Helpers
// =============================================================================

export function success<T>(data: T): ToolResult<T> {
  return { success: true, data };
}

export function error(message: string, code?: string, details?: unknown): ToolError {
  return { success: false, error: { message, code, details } };
}

export function isSuccess<T>(result: ToolResult<T>): result is ToolSuccess<T> {
  return result.success === true;
}

export function isError<T>(result: ToolResult<T>): result is ToolError {
  return result.success === false;
}

// =============================================================================
// String Helpers
// =============================================================================

export function extractPlanName(request: string): string {
  const words = request.trim().split(/\s+/).slice(0, 5);
  const name = words.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return name || "unnamed";
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// =============================================================================
// Project Directory Resolution (ctx.agent validation)
// =============================================================================

/**
 * Resolves the project directory from ctx.agent.
 * 
 * ctx.agent can be:
 * - An absolute path (/home/user/project)
 * - A relative path (./project, ../project)
 * - An agent name (fuxi, qiaochui, etc.) - NOT a valid directory
 * - undefined or empty
 * 
 * @param agent - The ctx.agent value from the tool context
 * @param cwd - Current working directory to use as fallback (default: process.cwd())
 * @returns A valid absolute path to a directory
 */
export function resolveProjectDir(agent: string | undefined, cwd: string = process.cwd()): string {
  // If agent is undefined or empty, use cwd
  if (!agent) {
    return cwd;
  }

  // If it's an absolute path, validate it exists
  if (agent.startsWith('/')) {
    return existsSync(agent) ? agent : cwd;
  }

  // If it's an explicit relative path (./ or ../), resolve it
  if (agent.startsWith('./') || agent.startsWith('../')) {
    const resolved = join(cwd, agent);
    return existsSync(resolved) ? resolved : cwd;
  }

  // If it's just a name (like "fuxi"), it's not a valid directory
  // This could be a misconfigured context where agent name leaked in
  return cwd;
}

/**
 * Validates if a string is a valid directory path.
 * @param path - Path to validate
 * @returns true if path is a valid, existing directory
 */
export function isValidDirPath(path: string | undefined | null): boolean {
  if (!path) return false;
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

