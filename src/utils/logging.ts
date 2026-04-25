/**
 * Logging utilities for Sages
 * Provides centralized logging for compaction, tools, errors, and general sages events
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".config", "sages", "logs");
const COMPACTION_LOG = join(LOG_DIR, "compaction.log");

// =============================================================================
// Internal Helpers
// =============================================================================

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getDateStampedLogPath(type: "tools" | "errors" | "sages"): string {
  const today = new Date().toISOString().split("T")[0];
  return join(LOG_DIR, `${type}-${today}.log`);
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

// =============================================================================
// Error Logging
// =============================================================================

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

// =============================================================================
// Sages General Logging
// =============================================================================

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