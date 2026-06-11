import { describe, it, expect } from "bun:test";
import { expandPath, getEnv, getEnvInt, getEnvBool, resolveToken } from "../src/utils/env-detect.js";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("env-detect", () => {
  it("expandPath handles tilde", () => {
    process.env.HOME = "/home/test";
    expect(expandPath("~/foo")).toBe("/home/test/foo");
    expect(expandPath("/abs")).toBe("/abs");
    expect(expandPath("rel")).toMatch(/rel$/);
  });

  it("getEnv returns env var or default", () => {
    process.env.TEST_VAR = "value";
    expect(getEnv("TEST_VAR", "fallback")).toBe("value");
    delete process.env.TEST_VAR;
    expect(getEnv("TEST_VAR", "fallback")).toBe("fallback");
  });

  it("getEnvInt parses integers with default", () => {
    process.env.TEST_INT = "42";
    expect(getEnvInt("TEST_INT", 0)).toBe(42);
    delete process.env.TEST_INT;
    expect(getEnvInt("TEST_INT", 99)).toBe(99);
    process.env.TEST_INT = "not-a-number";
    expect(getEnvInt("TEST_INT", 99)).toBe(99); // fallback on bad parse
    delete process.env.TEST_INT;
  });

  it("getEnvBool recognizes truthy values", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "Yes"]) {
      process.env.TEST_BOOL = v;
      expect(getEnvBool("TEST_BOOL", false)).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", "FALSE", "anything-else"]) {
      process.env.TEST_BOOL = v;
      expect(getEnvBool("TEST_BOOL", true)).toBe(false);
    }
    delete process.env.TEST_BOOL;
    expect(getEnvBool("TEST_BOOL", true)).toBe(true); // fallback to default
  });

  describe("resolveToken", () => {
    let workDir: string;
    beforeEach(async () => {
      workDir = await mkdtemp(join(tmpdir(), "token-test-"));
    });
    afterEach(async () => {
      await rm(workDir, { recursive: true, force: true });
    });

    it("env takes priority over file", async () => {
      const credFile = join(workDir, "credentials");
      await writeFile(credFile, "pt-from-file\n");
      await chmod(credFile, 0o600);

      process.env.YUNXIAO_ACCESS_TOKEN = "pt-from-env";
      const result = await resolveToken(credFile);
      expect(result).toBe("pt-from-env");
      delete process.env.YUNXIAO_ACCESS_TOKEN;
    });

    it("falls back to file when env not set", async () => {
      delete process.env.YUNXIAO_ACCESS_TOKEN;
      const credFile = join(workDir, "credentials");
      await writeFile(credFile, "pt-from-file\n");
      await chmod(credFile, 0o600);

      const result = await resolveToken(credFile);
      expect(result).toBe("pt-from-file");
    });

    it("trims whitespace from file", async () => {
      delete process.env.YUNXIAO_ACCESS_TOKEN;
      const credFile = join(workDir, "credentials");
      await writeFile(credFile, "  pt-padded  \n");
      await chmod(credFile, 0o600);

      const result = await resolveToken(credFile);
      expect(result).toBe("pt-padded");
    });

    it("returns null when neither available", async () => {
      delete process.env.YUNXIAO_ACCESS_TOKEN;
      const credFile = join(workDir, "nonexistent");
      const result = await resolveToken(credFile);
      expect(result).toBeNull();
    });
  });
});
