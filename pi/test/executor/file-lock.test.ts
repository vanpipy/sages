/**
 * RED Phase Tests for File Locking
 * Tests for Issue #1: File locking with 30-min TTL
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Mock file locking implementation for testing
interface LockInfo {
  taskId: string;
  files: string[];
  acquiredAt: number;
  expiresAt: number;
}

class FileLockManager {
  private locks: Map<string, LockInfo> = new Map();
  private lockDir: string;
  private ttlMs: number = 30 * 60 * 1000; // 30 minutes

  constructor(lockDir: string = "/tmp/sages-locks") {
    this.lockDir = lockDir;
    if (!existsSync(lockDir)) {
      mkdirSync(lockDir, { recursive: true });
    }
  }

  /**
   * Attempt to acquire locks for files
   * @returns true if locks acquired, false if any file is locked by another task
   */
  acquire(taskId: string, files: string[]): boolean {
    // Clean expired locks first
    this.cleanExpired();

    // Check if any file is already locked by another task
    for (const file of files) {
      const lockPath = this.getLockPath(file);
      if (existsSync(lockPath)) {
        const lockInfo = this.readLockInfo(lockPath);
        if (lockInfo && lockInfo.expiresAt > Date.now()) {
          if (lockInfo.taskId === taskId) {
            // Same task already holds this lock - extend it
            lockInfo.expiresAt = Date.now() + this.ttlMs;
            this.locks.set(file, lockInfo);
            this.writeLockInfo(lockPath, lockInfo);
            continue;  // Skip to next file, lock already held
          }
          // File is locked by another task
          return false;
        }
      }
    }

    // All files available, acquire locks
    const now = Date.now();
    for (const file of files) {
      const lockInfo: LockInfo = {
        taskId,
        files: [file],
        acquiredAt: now,
        expiresAt: now + this.ttlMs,
      };
      this.writeLockInfo(this.getLockPath(file), lockInfo);
      this.locks.set(file, lockInfo);
    }

    return true;
  }

  /**
   * Release locks held by a task
   */
  release(taskId: string): void {
    for (const [file, lockInfo] of this.locks.entries()) {
      if (lockInfo.taskId === taskId) {
        const lockPath = this.getLockPath(file);
        if (existsSync(lockPath)) {
          unlinkSync(lockPath);
        }
        this.locks.delete(file);
      }
    }
  }

  /**
   * Check if files are locked by another task
   */
  isLockedByOther(taskId: string, files: string[]): string[] {
    this.cleanExpired();
    const locked: string[] = [];

    for (const file of files) {
      const lockPath = this.getLockPath(file);
      if (existsSync(lockPath)) {
        const lockInfo = this.readLockInfo(lockPath);
        if (lockInfo && lockInfo.taskId !== taskId && lockInfo.expiresAt > Date.now()) {
          locked.push(file);
        }
      }
    }

    return locked;
  }

  /**
   * Get lock holder info for a file
   */
  getLockHolder(file: string): LockInfo | null {
    const lockPath = this.getLockPath(file);
    if (!existsSync(lockPath)) return null;
    return this.readLockInfo(lockPath);
  }

  private getLockPath(file: string): string {
    // Create a safe filename from the file path
    const safeName = file.replace(/[^a-zA-Z0-9]/g, "_");
    return join(this.lockDir, `lock_${safeName}`);
  }

  private readLockInfo(path: string): LockInfo | null {
    try {
      const content = readFileSync(path, "utf-8");
      return JSON.parse(content) as LockInfo;
    } catch {
      return null;
    }
  }

  private writeLockInfo(path: string, info: LockInfo): void {
    writeFileSync(path, JSON.stringify(info, null, 2));
  }

  private cleanExpired(): void {
    const now = Date.now();
    const lockFiles = existsSync(this.lockDir)
      ? (() => {
          const { readFileSync: rfs, readdirSync: rds, unlinkSync: ul } = require("node:fs");
          try {
            return rds(this.lockDir).filter((f: string) => f.startsWith("lock_"));
          } catch {
            return [];
          }
        })()
      : [];

    for (const file of lockFiles) {
      const path = join(this.lockDir, file);
      const info = this.readLockInfo(path);
      if (info && info.expiresAt <= now) {
        unlinkSync(path);
        this.locks.delete(info.files[0]);
      }
    }
  }
}

describe("FileLockManager", () => {
  const testLockDir = "/tmp/test-locks-" + Date.now();
  let lockManager: FileLockManager;

  afterEach(() => {
    // Cleanup
    try {
      const { readdirSync, unlinkSync, rmdirSync } = require("node:fs");
      const files = readdirSync(testLockDir);
      for (const file of files) {
        unlinkSync(join(testLockDir, file));
      }
      rmdirSync(testLockDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Basic Lock Operations", () => {
    beforeEach(() => {
      lockManager = new FileLockManager(testLockDir);
    });

    afterEach(() => {
      // Cleanup lock files in .sages/locks subdirectory
      try {
        const { readdirSync, unlinkSync, existsSync } = require("node:fs");
        const locksDir = require("node:path").join(testLockDir, ".sages", "locks");
        if (existsSync(locksDir)) {
          const files = readdirSync(locksDir);
          for (const file of files) {
            unlinkSync(require("node:path").join(locksDir, file));
          }
        }
      } catch {
        // Ignore cleanup errors
      }
    });

    it("should acquire lock on available file", () => {
      const result = lockManager.acquire("T1", ["src/test.ts"]);
      expect(result).toBe(true);
    });

    it("should fail to acquire lock on already locked file", () => {
      lockManager.acquire("T1", ["src/test.ts"]);
      const result = lockManager.acquire("T2", ["src/test.ts"]);
      expect(result).toBe(false);
    });

    it("should release locks for a task", () => {
      lockManager.acquire("T1", ["src/test.ts"]);
      lockManager.release("T1");
      const result = lockManager.acquire("T2", ["src/test.ts"]);
      expect(result).toBe(true);
    });

    it("should allow same task to re-acquire its own locks", () => {
      const r1 = lockManager.acquire("T1", ["src/test.ts"]);
      expect(r1).toBe(true);
      const r2 = lockManager.acquire("T1", ["src/test.ts"]);
      expect(r2).toBe(true);
    });
  });

  describe("Multi-File Locking", () => {
    beforeEach(() => {
      lockManager = new FileLockManager(testLockDir);
    });

    it("should acquire locks on all files if all available", () => {
      const result = lockManager.acquire("T1", ["src/a.ts", "src/b.ts", "src/c.ts"]);
      expect(result).toBe(true);
    });

    it("should fail if any file is locked", () => {
      lockManager.acquire("T1", ["src/a.ts", "src/b.ts"]);
      const result = lockManager.acquire("T2", ["src/b.ts", "src/c.ts"]);
      expect(result).toBe(false);
    });

    it("should check locked files correctly", () => {
      lockManager.acquire("T1", ["src/a.ts"]);
      const locked = lockManager.isLockedByOther("T2", ["src/a.ts", "src/b.ts"]);
      expect(locked).toEqual(["src/a.ts"]);
    });
  });

  describe("TTL Expiration", () => {
    it("should respect 30-minute TTL", async () => {
      const shortTTLManager = new FileLockManager(testLockDir);
      // Manually set a lock with short TTL for testing
      (shortTTLManager as any).ttlMs = 100; // 100ms for testing

      shortTTLManager.acquire("T1", ["src/test.ts"]);

      // Lock should be held immediately
      const lockedBefore = shortTTLManager.isLockedByOther("T2", ["src/test.ts"]);
      expect(lockedBefore).toEqual(["src/test.ts"]);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Lock should be expired
      const lockedAfter = shortTTLManager.isLockedByOther("T2", ["src/test.ts"]);
      expect(lockedAfter).toEqual([]);
    });
  });

  describe("Conflict Notification", () => {
    beforeEach(() => {
      lockManager = new FileLockManager(testLockDir);
    });

    it("should return lock holder info for conflict notification", () => {
      lockManager.acquire("T1", ["src/shared.ts"]);

      const holder = lockManager.getLockHolder("src/shared.ts");
      expect(holder).not.toBeNull();
      expect(holder?.taskId).toBe("T1");
    });

    it("should return null for unlocked file", () => {
      const holder = lockManager.getLockHolder("src/unlocked.ts");
      expect(holder).toBeNull();
    });
  });
});

describe("FileLockManager Integration Requirements", () => {
  const testLockDir = "/tmp/test-locks-int-" + Date.now();

  afterEach(() => {
    try {
      const { readdirSync, unlinkSync, rmdirSync } = require("node:fs");
      const files = readdirSync(testLockDir);
      for (const file of files) {
        unlinkSync(join(testLockDir, file));
      }
      rmdirSync(testLockDir);
    } catch {
      // Ignore
    }
  });

  it("MUST implement file locking before parallel task execution", () => {
    const lockManager = new FileLockManager(testLockDir);

    // Simulate two tasks wanting the same files
    const sharedFiles = ["src/shared/utils.ts", "src/shared/config.ts"];

    // T1 acquires first
    const t1Acquired = lockManager.acquire("T1", sharedFiles);
    expect(t1Acquired).toBe(true);

    // T2 should be blocked
    const t2Acquired = lockManager.acquire("T2", sharedFiles);
    expect(t2Acquired).toBe(false);

    // T2 should be notified of conflict
    const conflicts = lockManager.isLockedByOther("T2", sharedFiles);
    expect(conflicts.length).toBe(2);

    // Get conflict details for notification
    for (const file of conflicts) {
      const holder = lockManager.getLockHolder(file);
      expect(holder?.taskId).toBe("T1");
    }
  });
});
