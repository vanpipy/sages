/**
 * Unit Tests for FileLockManager
 * Tests cooperative file locking for LuBan agents
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { FileLockManager } from "../../src/engine/file-lock";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), "sages-filelock-test-" + Date.now());

describe("FileLockManager", () => {
  let manager: FileLockManager;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    manager = new FileLockManager(TEST_DIR);
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("constructor", () => {
    it("should create FileLockManager with default lock dir", () => {
      const m = new FileLockManager();
      expect(m).toBeDefined();
    });

    it("should create FileLockManager with custom lock dir", () => {
      const m = new FileLockManager(TEST_DIR);
      expect(m).toBeDefined();
    });
  });

  describe("acquireLock", () => {
    it("should acquire lock on unlocked file", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      const lock = await manager.acquireLock(filePath, "task-1", "agent-1");

      expect(lock).not.toBeNull();
      expect(lock!.path).toBe(filePath);
      expect(lock!.taskId).toBe("task-1");
      expect(lock!.agentId).toBe("agent-1");
      expect(lock!.acquiredAt).toBeDefined();
      expect(lock!.expiresAt).toBeDefined();
    });

    it("should return null when file is already locked", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");

      const lock1 = await manager.acquireLock(filePath, "task-1", "agent-1");
      expect(lock1).not.toBeNull();

      const lock2 = await manager.acquireLock(filePath, "task-2", "agent-2");
      expect(lock2).toBeNull();
    });

    it("should allow acquiring lock after previous lock expires", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");

      // Acquire with very short TTL
      const shortTtlManager = new FileLockManager(TEST_DIR, 1); // 1 second
      const lock1 = await shortTtlManager.acquireLock(filePath, "task-1", "agent-1");
      expect(lock1).not.toBeNull();

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      const lock2 = await shortTtlManager.acquireLock(filePath, "task-2", "agent-2");
      expect(lock2).not.toBeNull();
      expect(lock2!.taskId).toBe("task-2");
    });

    it("should create lock directory structure", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      await manager.acquireLock(filePath, "task-1", "agent-1");

      const lockDir = join(TEST_DIR, ".sages-filelocks");
      const lockDirExists = await fs.access(lockDir).then(() => true).catch(() => false);
      expect(lockDirExists).toBe(true);
    });

    it("should handle concurrent lock acquisition correctly", async () => {
      const filePath = join(TEST_DIR, "concurrent-test.txt");

      const [result1, result2] = await Promise.all([
        manager.acquireLock(filePath, "task-1", "agent-1"),
        manager.acquireLock(filePath, "task-2", "agent-2"),
      ]);

      // Exactly one should succeed
      const successes = [result1, result2].filter(r => r !== null);
      const failures = [result1, result2].filter(r => r === null);
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);

      // Verify winner has correct ownership
      const winner = successes[0]!;
      expect(winner.taskId).toMatch(/^task-\d$/);
      expect(winner.agentId).toMatch(/^agent-\d$/);
      expect(winner.path).toBe(filePath);
      expect(winner.acquiredAt).toBeDefined();
      expect(winner.expiresAt).toBeDefined();

      // Verify heartbeat was created
      const lockDir = join(TEST_DIR, ".sages-filelocks");
      const lockDirExists = await fs.access(lockDir).then(() => true).catch(() => false);
      expect(lockDirExists).toBe(true);
    });
  });

  describe("releaseLock", () => {
    it("should release lock owned by task", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      await manager.acquireLock(filePath, "task-1", "agent-1");

      await manager.releaseLock(filePath, "task-1");

      const isLocked = await manager.isLocked(filePath);
      expect(isLocked).toBe(false);
    });

    it("should not release lock owned by different task", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      await manager.acquireLock(filePath, "task-1", "agent-1");

      // Try to release with different task ID
      await manager.releaseLock(filePath, "task-2");

      // Lock should still be held
      const isLocked = await manager.isLocked(filePath);
      expect(isLocked).toBe(true);
    });

    it("should handle releasing non-existent lock gracefully", async () => {
      const filePath = join(TEST_DIR, "nonexistent.txt");

      // Should not throw
      await expect(manager.releaseLock(filePath, "task-1")).resolves.toBeUndefined();
    });
  });

  describe("releaseAllLocks", () => {
    it("should release all locks for a task", async () => {
      const file1 = join(TEST_DIR, "file1.txt");
      const file2 = join(TEST_DIR, "file2.txt");

      await manager.acquireLock(file1, "task-1", "agent-1");
      await manager.acquireLock(file2, "task-1", "agent-1");

      await manager.releaseAllLocks("task-1");

      expect(await manager.isLocked(file1)).toBe(false);
      expect(await manager.isLocked(file2)).toBe(false);
    });

    it("should not release locks for different task", async () => {
      const file1 = join(TEST_DIR, "file1.txt");

      await manager.acquireLock(file1, "task-1", "agent-1");
      await manager.releaseAllLocks("task-2");

      expect(await manager.isLocked(file1)).toBe(true);
    });
  });

  describe("renewLock", () => {
    it("should renew lock and extend expiration", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      const shortTtlManager = new FileLockManager(TEST_DIR, 1);
      await shortTtlManager.acquireLock(filePath, "task-1", "agent-1");

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 500));

      // Renew
      await shortTtlManager.renewLock(filePath, "task-1");

      // Wait slightly less than original TTL but more than elapsed
      await new Promise(resolve => setTimeout(resolve, 600));

      // Should still be valid (renewed)
      const lock = await shortTtlManager.getLock(filePath);
      expect(lock).not.toBeNull();
    });

    it("should throw when renewing non-existent lock", async () => {
      const shortTtlManager = new FileLockManager(TEST_DIR, 1);
      const filePath = join(TEST_DIR, "nonexistent.txt");

      await expect(shortTtlManager.renewLock(filePath, "task-1")).rejects.toThrow();
    });
  });

  describe("getLock", () => {
    it("should return lock for locked file", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      await manager.acquireLock(filePath, "task-1", "agent-1");

      const lock = await manager.getLock(filePath);
      expect(lock).not.toBeNull();
      expect(lock!.taskId).toBe("task-1");
      expect(lock!.agentId).toBe("agent-1");
    });

    it("should return null for unlocked file", async () => {
      const filePath = join(TEST_DIR, "unlocked.txt");

      const lock = await manager.getLock(filePath);
      expect(lock).toBeNull();
    });
  });

  describe("getAllLocks", () => {
    it("should return all active locks", async () => {
      const file1 = join(TEST_DIR, "file1.txt");
      const file2 = join(TEST_DIR, "file2.txt");

      await manager.acquireLock(file1, "task-1", "agent-1");
      await manager.acquireLock(file2, "task-2", "agent-2");

      const locks = await manager.getAllLocks();
      expect(locks.length).toBe(2);
    });

    it("should return empty array when no locks exist", async () => {
      const locks = await manager.getAllLocks();
      expect(locks).toEqual([]);
    });
  });

  describe("isLocked", () => {
    it("should return true for locked file", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      await manager.acquireLock(filePath, "task-1", "agent-1");

      const locked = await manager.isLocked(filePath);
      expect(locked).toBe(true);
    });

    it("should return false for unlocked file", async () => {
      const filePath = join(TEST_DIR, "unlocked.txt");

      const locked = await manager.isLocked(filePath);
      expect(locked).toBe(false);
    });
  });

  describe("isLockedByTask", () => {
    it("should return true when file is locked by task", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      await manager.acquireLock(filePath, "task-1", "agent-1");

      const isLockedByTask = await manager.isLockedByTask(filePath, "task-1");
      expect(isLockedByTask).toBe(true);
    });

    it("should return false when file is locked by different task", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      await manager.acquireLock(filePath, "task-1", "agent-1");

      const isLockedByTask = await manager.isLockedByTask(filePath, "task-2");
      expect(isLockedByTask).toBe(false);
    });
  });

  describe("getLocksForTask", () => {
    it("should return all locks for a task", async () => {
      const file1 = join(TEST_DIR, "file1.txt");
      const file2 = join(TEST_DIR, "file2.txt");

      await manager.acquireLock(file1, "task-1", "agent-1");
      await manager.acquireLock(file2, "task-1", "agent-2");
      await manager.acquireLock(join(TEST_DIR, "file3.txt"), "task-2", "agent-3");

      const locks = await manager.getLocksForTask("task-1");
      expect(locks.length).toBe(2);
    });
  });

  describe("cleanup", () => {
    it("should remove expired locks", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      const shortTtlManager = new FileLockManager(TEST_DIR, 1);
      await shortTtlManager.acquireLock(filePath, "task-1", "agent-1");

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      await shortTtlManager.cleanup();

      const isLocked = await shortTtlManager.isLocked(filePath);
      expect(isLocked).toBe(false);
    });

    it("should not remove valid locks", async () => {
      const filePath = join(TEST_DIR, "test-file.txt");
      await manager.acquireLock(filePath, "task-1", "agent-1");

      await manager.cleanup();

      const isLocked = await manager.isLocked(filePath);
      expect(isLocked).toBe(true);
    });
  });
});
