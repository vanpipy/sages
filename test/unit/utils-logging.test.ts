/**
 * Unit Tests for logging utilities
 * Tests logCompaction, logTool, logError, logSages, and rotateLogFiles
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync, readFileSync, mkdirSync, rmSync, statSync, readdirSync, existsSync, unlinkSync } from "fs";

// Use actual temp directory for testing
const TEST_DIR = join(tmpdir(), "sages-logging-test-" + Date.now());

// Import the logging module - it will use real homedir
import {
  logCompaction,
  logTool,
  logError,
  logSages,
  rotateLogFiles,
} from "../../src/utils/logging";

// For testing, we need to verify the actual file writes
// The tests will write to the REAL ~/.config/sages/logs directory
// and we clean up after

describe("logCompaction", () => {
  const LOG_DIR = join(process.env.HOME || "", ".config", "sages", "logs");
  const COMPACTION_LOG = join(LOG_DIR, "compaction.log");

  beforeEach(() => {
    mkdirSync(LOG_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(COMPACTION_LOG, { force: true });
    } catch {
      // ignore
    }
  });

  it("should write compaction log entry to compaction.log", () => {
    logCompaction("info", "Test message", { taskId: "T1" });

    const content = readFileSync(COMPACTION_LOG, "utf-8");
    const lines = content.trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("Test message");
    expect(entry.taskId).toBe("T1");
    expect(entry.time).toBeDefined();
  });

  it("should include all data fields in log entry", () => {
    logCompaction("debug", "Debug message", { phase: "execution", count: 5 });

    const content = readFileSync(COMPACTION_LOG, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.phase).toBe("execution");
    expect(entry.count).toBe(5);
  });

  it("should handle error level", () => {
    logCompaction("error", "Error occurred", { errorCode: 500 });

    const content = readFileSync(COMPACTION_LOG, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.level).toBe("error");
    expect(entry.errorCode).toBe(500);
  });

  it("should handle warn level", () => {
    logCompaction("warn", "Warning message");

    const content = readFileSync(COMPACTION_LOG, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.level).toBe("warn");
  });

  it("should work without optional data parameter", () => {
    logCompaction("info", "Simple message");

    const content = readFileSync(COMPACTION_LOG, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.msg).toBe("Simple message");
  });

  it("should append multiple entries", () => {
    logCompaction("info", "First");
    logCompaction("info", "Second");

    const content = readFileSync(COMPACTION_LOG, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).msg).toBe("First");
    expect(JSON.parse(lines[1]).msg).toBe("Second");
  });
});

describe("logTool", () => {
  const LOG_DIR = join(process.env.HOME || "", ".config", "sages", "logs");

  afterEach(() => {
    // Clean up tools logs
    try {
      const files = readdirSync(LOG_DIR).filter(f => f.startsWith("tools-"));
      for (const file of files) {
        rmSync(join(LOG_DIR, file), { force: true });
      }
    } catch {
      // ignore
    }
  });

  it("should write tool call to date-stamped tools log", () => {
    logTool("testTool", { arg1: "value1" }, "success result");

    const files = readdirSync(LOG_DIR);
    const toolsLog = files.find(f => f.startsWith("tools-"));
    expect(toolsLog).toBeDefined();
    expect(toolsLog).toMatch(/^tools-\d{4}-\d{2}-\d{2}\.log$/);

    const content = readFileSync(join(LOG_DIR, toolsLog!), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.level).toBe("info");
    expect(entry.tool).toBe("testTool");
    expect(entry.args).toEqual({ arg1: "value1" });
    expect(entry.result).toBe("success result");
  });

  it("should use error level when error is present", () => {
    logTool("failingTool", { input: "test" }, undefined, "Tool failed");

    const files = readdirSync(LOG_DIR);
    const toolsLog = files.find(f => f.startsWith("tools-"));
    const content = readFileSync(join(LOG_DIR, toolsLog!), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.level).toBe("error");
    expect(entry.error).toBe("Tool failed");
  });

  it("should include msg with tool_call prefix", () => {
    logTool("myTool", {});

    const files = readdirSync(LOG_DIR);
    const toolsLog = files.find(f => f.startsWith("tools-"));
    const content = readFileSync(join(LOG_DIR, toolsLog!), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.msg).toBe("tool_call: myTool");
  });
});

describe("logError", () => {
  const LOG_DIR = join(process.env.HOME || "", ".config", "sages", "logs");

  afterEach(() => {
    // Clean up errors logs
    try {
      const files = readdirSync(LOG_DIR).filter(f => f.startsWith("errors-"));
      for (const file of files) {
        rmSync(join(LOG_DIR, file), { force: true });
      }
    } catch {
      // ignore
    }
  });

  it("should write error to date-stamped errors log", () => {
    logError("Something went wrong", { context: "operation" });

    const files = readdirSync(LOG_DIR);
    const errorsLog = files.find(f => f.startsWith("errors-"));
    expect(errorsLog).toBeDefined();
    expect(errorsLog).toMatch(/^errors-\d{4}-\d{2}-\d{2}\.log$/);

    const content = readFileSync(join(LOG_DIR, errorsLog!), "utf-8");
    const lines = content.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);
    expect(entry.level).toBe("error");
    expect(entry.msg).toBe("Something went wrong");
    expect(entry.context).toBe("operation");
  });

  it("should work without optional data", () => {
    logError("Simple error");

    const files = readdirSync(LOG_DIR);
    const errorsLog = files.find(f => f.startsWith("errors-"));
    const content = readFileSync(join(LOG_DIR, errorsLog!), "utf-8");
    const lines = content.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);
    expect(entry.msg).toBe("Simple error");
  });
});

describe("logSages", () => {
  const LOG_DIR = join(process.env.HOME || "", ".config", "sages", "logs");

  afterEach(() => {
    // Clean up sages logs
    try {
      const files = readdirSync(LOG_DIR).filter(f => f.startsWith("sages-"));
      for (const file of files) {
        rmSync(join(LOG_DIR, file), { force: true });
      }
    } catch {
      // ignore
    }
  });

  it("should write sages message to date-stamped log", () => {
    logSages("Sages message", { agent: "fuxi" });

    const files = readdirSync(LOG_DIR);
    const sagesLog = files.find(f => f.startsWith("sages-"));
    expect(sagesLog).toBeDefined();
    expect(sagesLog).toMatch(/^sages-\d{4}-\d{2}-\d{2}\.log$/);

    const content = readFileSync(join(LOG_DIR, sagesLog!), "utf-8");
    const lines = content.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("Sages message");
    expect(entry.agent).toBe("fuxi");
  });

  it("should use info level for sages logs", () => {
    logSages("Info level message");

    const files = readdirSync(LOG_DIR);
    const sagesLog = files.find(f => f.startsWith("sages-"));
    const content = readFileSync(join(LOG_DIR, sagesLog!), "utf-8");
    const lines = content.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);
    expect(entry.level).toBe("info");
  });
});

describe("rotateLogFiles", () => {
  const LOG_DIR = join(process.env.HOME || "", ".config", "sages", "logs");

  beforeEach(() => {
    mkdirSync(LOG_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up all test logs
    try {
      const files = readdirSync(LOG_DIR);
      for (const file of files) {
        if (/^(tools|errors|sages)-\d{4}-\d{2}-\d{2}\.log$/.test(file)) {
          rmSync(join(LOG_DIR, file), { force: true });
        }
      }
    } catch {
      // ignore
    }
  });

  it("should create log directory if it does not exist", () => {
    // Clean directory
    try {
      rmSync(LOG_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }

    rotateLogFiles();

    const exists = existsSync(LOG_DIR);
    expect(exists).toBe(true);
  });

  it("should keep log files newer than 7 days", () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 3);
    const recentFile = `tools-${recentDate.toISOString().split("T")[0]}.log`;
    const recentPath = join(LOG_DIR, recentFile);

    writeFileSync(recentPath, "recent content");

    rotateLogFiles();

    const exists = existsSync(recentPath);
    expect(exists).toBe(true);
  });

  it("should ignore non-matching files", () => {
    writeFileSync(join(LOG_DIR, "compaction.log"), "data");
    writeFileSync(join(LOG_DIR, "other.log"), "data");
    writeFileSync(join(LOG_DIR, "random.txt"), "data");

    rotateLogFiles();

    // compaction.log should still exist (not matching pattern)
    expect(existsSync(join(LOG_DIR, "compaction.log"))).toBe(true);
    expect(existsSync(join(LOG_DIR, "other.log"))).toBe(true);
  });
});

describe("Silently fail behavior", () => {
  const LOG_DIR = join(process.env.HOME || "", ".config", "sages", "logs");

  afterEach(() => {
    try {
      rmSync(LOG_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("logCompaction should not throw on errors", () => {
    expect(() => logCompaction("info", "test")).not.toThrow();
  });

  it("logTool should not throw on errors", () => {
    expect(() => logTool("tool", {})).not.toThrow();
  });

  it("logError should not throw on errors", () => {
    expect(() => logError("test")).not.toThrow();
  });

  it("logSages should not throw on errors", () => {
    expect(() => logSages("test")).not.toThrow();
  });

  it("rotateLogFiles should not throw on errors", () => {
    // Remove directory to trigger error
    try {
      rmSync(LOG_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }

    expect(() => rotateLogFiles()).not.toThrow();
  });
});