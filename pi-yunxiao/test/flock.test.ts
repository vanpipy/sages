import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { acquireLock, withLock } from "../src/utils/flock.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("flock", () => {
  let workDir: string;
  let lockFile: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "flock-test-"));
    lockFile = join(workDir, "test.lock");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("acquires and releases lock", async () => {
    const release = await acquireLock(lockFile);
    expect(typeof release).toBe("function");
    await release();
  });

  it("blocks second acquirer until first releases", async () => {
    const release1 = await acquireLock(lockFile);
    let acquired2 = false;

    const acquirePromise = acquireLock(lockFile).then((r) => {
      acquired2 = true;
      return r;
    });

    // Wait a bit, acquire2 should still be pending
    await new Promise((r) => setTimeout(r, 100));
    expect(acquired2).toBe(false);

    await release1();
    const release2 = await acquirePromise;
    expect(acquired2).toBe(true);
    await release2();
  });

  it("withLock executes callback while holding lock", async () => {
    let executed = false;
    await withLock(lockFile, async () => {
      executed = true;
    });
    expect(executed).toBe(true);
  });

  it("releases lock even if callback throws", async () => {
    await expect(
      withLock(lockFile, async () => {
        throw new Error("test error");
      })
    ).rejects.toThrow("test error");

    // Lock should be releasable immediately
    const release = await acquireLock(lockFile);
    await release();
  });
});
