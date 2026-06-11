import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TokenStore } from "../src/services/token-store.js";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("TokenStore", () => {
  let workDir: string;
  let credFile: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "token-store-"));
    credFile = join(workDir, "credentials");
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(originalEnv)) {
      process.env[key] = val;
    }
    await rm(workDir, { recursive: true, force: true });
  });

  it("has() returns false when neither env nor file", async () => {
    delete process.env.YUNXIAO_ACCESS_TOKEN;
    const store = new TokenStore(credFile);
    expect(await store.has()).toBe(false);
  });

  it("has() returns true when env set", async () => {
    process.env.YUNXIAO_ACCESS_TOKEN = "pt-xyz";
    const store = new TokenStore(credFile);
    expect(await store.has()).toBe(true);
  });

  it("has() returns true when file exists", async () => {
    delete process.env.YUNXIAO_ACCESS_TOKEN;
    await writeFile(credFile, "pt-from-file\n");
    await chmod(credFile, 0o600);
    const store = new TokenStore(credFile);
    expect(await store.has()).toBe(true);
  });

  it("get() returns env value with priority over file", async () => {
    process.env.YUNXIAO_ACCESS_TOKEN = "pt-from-env";
    await writeFile(credFile, "pt-from-file\n");
    await chmod(credFile, 0o600);
    const store = new TokenStore(credFile);
    expect(await store.get()).toBe("pt-from-env");
  });

  it("get() falls back to file when env not set", async () => {
    delete process.env.YUNXIAO_ACCESS_TOKEN;
    await writeFile(credFile, "  pt-from-file  \n");
    await chmod(credFile, 0o600);
    const store = new TokenStore(credFile);
    expect(await store.get()).toBe("pt-from-file");
  });

  it("set() writes file with chmod 600", async () => {
    delete process.env.YUNXIAO_ACCESS_TOKEN;
    const store = new TokenStore(credFile);
    await store.set("pt-new-token");
    const content = await Bun.file(credFile).text();
    expect(content).toBe("pt-new-token\n");
    const { stat } = await import("node:fs/promises");
    const s = await stat(credFile);
    // Check permission bits: should be 0o600 (rw-------)
    expect((s.mode & 0o777).toString(8)).toBe("600");
  });

  it("notConfiguredHint() returns actionable message", () => {
    const store = new TokenStore(credFile);
    const hint = store.notConfiguredHint();
    expect(hint).toContain("YUNXIAO_ACCESS_TOKEN");
    expect(hint).toContain(credFile);
  });
});
