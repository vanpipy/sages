/**
 * logger.ts - Structured log with token sanitization.
 *
 * Output: append-only file, ISO 8601 timestamp + level + message.
 * Token sanitization: detects "pt-..." or "token=..." patterns and truncates to 10-char prefix.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export interface LoggerOptions {
  file: string;
  level?: LogLevel;
}

/**
 * Sanitize a string by truncating any detected tokens to 10-char prefix.
 */
function sanitize(s: string): string {
  return s
    .replace(/(pt-[a-zA-Z0-9_-]+)/g, (m) => m.slice(0, 10) + "...")
    .replace(/(token=)([^\s,;]+)/g, (_, p, v: string) => p + v.slice(0, 10) + "...");
}

export class Logger {
  private file: string;
  private level: LogLevel;
  private dirReady: Promise<void>;

  constructor(opts: LoggerOptions) {
    this.file = opts.file;
    this.level = opts.level || "INFO";
    // Lazily ensure directory; lazy so we don't slow constructor
    this.dirReady = mkdir(dirname(this.file), { recursive: true }).then(() => {});
  }

  private async write(level: LogLevel, msg: string): Promise<void> {
    await this.dirReady;
    const line = `[${new Date().toISOString()}] [${level}] ${sanitize(msg)}\n`;
    await appendFile(this.file, line);
  }

  info(msg: string): Promise<void> {
    return this.write("INFO", msg);
  }
  warn(msg: string): Promise<void> {
    return this.write("WARN", msg);
  }
  error(msg: string): Promise<void> {
    return this.write("ERROR", msg);
  }
  debug(msg: string): Promise<void> {
    if (this.level === "DEBUG") return this.write("DEBUG", msg);
    return Promise.resolve();
  }

  /** Flush pending writes. Currently a no-op since writes are sequential. */
  async close(): Promise<void> {
    await this.dirReady;
  }
}
