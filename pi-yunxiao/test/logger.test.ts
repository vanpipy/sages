import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Logger } from "../src/utils/logger.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("logger", () => {
  let workDir: string;
  let logFile: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "logger-test-"));
    logFile = join(workDir, "test.log");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("writes info messages with ISO timestamp", async () => {
    const log = new Logger({ file: logFile });
    await log.info("hello world");
    await log.close();

    const content = await readFile(logFile, "utf-8");
    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(content).toContain("[INFO]");
    expect(content).toContain("hello world");
  });

  it("writes warn and error levels", async () => {
    const log = new Logger({ file: logFile });
    await log.warn("warning msg");
    await log.error("error msg");
    await log.close();

    const content = await readFile(logFile, "utf-8");
    expect(content).toContain("[WARN]");
    expect(content).toContain("warning msg");
    expect(content).toContain("[ERROR]");
    expect(content).toContain("error msg");
  });

  it("truncates tokens to 10-char prefix", async () => {
    const log = new Logger({ file: logFile });
    await log.info("token=pt-abcdefghijklmnopqrstuvwxyz");
    await log.close();

    const content = await readFile(logFile, "utf-8");
    // Should NOT contain the full token
    expect(content).not.toContain("pt-abcdefghijklmnopqrstuvwxyz");
    // Should contain truncated form
    expect(content).toMatch(/pt-abcdefg\.\.\./);
  });

  it("does not truncate non-token strings", async () => {
    const log = new Logger({ file: logFile });
    await log.info("regular message without tokens");
    await log.close();

    const content = await readFile(logFile, "utf-8");
    expect(content).toContain("regular message without tokens");
  });
});
