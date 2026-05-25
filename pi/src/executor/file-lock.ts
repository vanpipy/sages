/**
 * File Lock Manager - Issue #1 Fix
 * Implements file locking with 30-minute TTL for LuBan tasks
 * 
 * Spec Requirement:
 * - TTL: 30 minutes
 * - Auto-release on task complete
 * - Conflict notification
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface LockInfo {
  taskId: string;
  files: string[];
  acquiredAt: number;
  expiresAt: number;
}

export interface LockResult {
  success: boolean;
  lockedFiles?: string[];
  conflicts?: Array<{ file: string; holder: LockInfo }>;
}

export class FileLockManager {
  private locks: Map<string, LockInfo> = new Map();
  private lockDir: string;
  private ttlMs: number;
  private cwd: string;

  constructor(cwd: string, lockDir?: string, ttlMs: number = 30 * 60 * 1000) {
    this.cwd = cwd;
    this.lockDir = lockDir || join(cwd, ".sages", "locks");
    this.ttlMs = ttlMs;
    this.ensureLockDir();
  }

  private ensureLockDir(): void {
    if (!existsSync(this.lockDir)) {
      mkdirSync(this.lockDir, { recursive: true });
    }
  }

  /**
   * Attempt to acquire locks for files for a specific task
   * @returns LockResult with success=true if all locks acquired
   */
  acquire(taskId: string, files: string[]): LockResult {
    // Clean expired locks first
    this.cleanExpired();

    const conflicts: Array<{ file: string; holder: LockInfo }> = [];

    // Check if any file is already locked by another task
    for (const file of files) {
      const lockInfo = this.getLockInfo(file);
      if (lockInfo && lockInfo.taskId !== taskId) {
        // Check if lock is still valid
        if (lockInfo.expiresAt > Date.now()) {
          conflicts.push({ file, holder: lockInfo });
        }
      } else if (lockInfo && lockInfo.taskId === taskId) {
        // Same task already holds this lock - extend it
        lockInfo.expiresAt = Date.now() + this.ttlMs;
        this.locks.set(file, lockInfo);
        writeFileSync(this.getLockPath(file), JSON.stringify(lockInfo, null, 2));
        continue;  // Skip to next file, lock already held
      }
    }

    // If there are conflicts, return failure with conflict details
    if (conflicts.length > 0) {
      return {
        success: false,
        conflicts,
      };
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

      // Write lock file
      const lockPath = this.getLockPath(file);
      writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2));

      // Also update in-memory cache
      this.locks.set(file, lockInfo);
    }

    return { success: true, lockedFiles: files };
  }

  /**
   * Release all locks held by a task
   */
  release(taskId: string): void {
    for (const [file, lockInfo] of this.locks.entries()) {
      if (lockInfo.taskId === taskId) {
        const lockPath = this.getLockPath(file);
        if (existsSync(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore errors - file may already be deleted
          }
        }
        this.locks.delete(file);
      }
    }

    // Also scan lock directory for any remaining locks by this task
    try {
      const lockFiles = readdirSync(this.lockDir).filter(f => f.startsWith("lock_"));
      for (const lockFile of lockFiles) {
        const lockPath = join(this.lockDir, lockFile);
        try {
          const content = readFileSync(lockPath, "utf-8");
          const lockInfo = JSON.parse(content) as LockInfo;
          if (lockInfo.taskId === taskId) {
            unlinkSync(lockPath);
          }
        } catch {
          // Ignore parse errors
        }
      }
    } catch {
      // Directory may not exist
    }
  }

  /**
   * Check if files are locked by another task
   */
  isLockedByOther(taskId: string, files: string[]): string[] {
    this.cleanExpired();
    const locked: string[] = [];

    for (const file of files) {
      const lockInfo = this.getLockInfo(file);
      if (lockInfo && lockInfo.taskId !== taskId && lockInfo.expiresAt > Date.now()) {
        locked.push(file);
      }
    }

    return locked;
  }

  /**
   * Get lock holder info for a file
   */
  getLockHolder(file: string): LockInfo | null {
    return this.getLockInfo(file);
  }

  /**
   * Get all currently held locks
   */
  getAllLocks(): Map<string, LockInfo> {
    this.cleanExpired();
    return new Map(this.locks);
  }

  /**
   * Extend the TTL for locks held by a task
   */
  extend(taskId: string, additionalMs?: number): void {
    const extension = additionalMs || this.ttlMs;
    const now = Date.now();

    for (const [file, lockInfo] of this.locks.entries()) {
      if (lockInfo.taskId === taskId) {
        lockInfo.expiresAt = now + extension;
        const lockPath = this.getLockPath(file);
        writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2));
      }
    }
  }

  /**
   * Get conflict details for notification
   */
  getConflictDetails(taskId: string, files: string[]): Array<{ file: string; holder: LockInfo; ttlRemaining: number }> {
    const conflicts: Array<{ file: string; holder: LockInfo; ttlRemaining: number }> = [];

    for (const file of files) {
      const lockInfo = this.getLockInfo(file);
      if (lockInfo && lockInfo.taskId !== taskId) {
        const ttlRemaining = Math.max(0, lockInfo.expiresAt - Date.now());
        conflicts.push({ file, holder: lockInfo, ttlRemaining });
      }
    }

    return conflicts;
  }

  private getLockPath(file: string): string {
    // Create a safe filename from the file path
    const safeName = file.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 100);
    return join(this.lockDir, `lock_${safeName}`);
  }

  private getLockInfo(file: string): LockInfo | null {
    // First check in-memory cache
    if (this.locks.has(file)) {
      const lockInfo = this.locks.get(file)!;
      if (lockInfo.expiresAt > Date.now()) {
        return lockInfo;
      }
      // Expired, remove from cache
      this.locks.delete(file);
    }

    // Check lock file on disk
    const lockPath = this.getLockPath(file);
    if (!existsSync(lockPath)) {
      return null;
    }

    try {
      const content = readFileSync(lockPath, "utf-8");
      const lockInfo = JSON.parse(content) as LockInfo;

      if (lockInfo.expiresAt > Date.now()) {
        // Valid lock, update cache
        this.locks.set(file, lockInfo);
        return lockInfo;
      }

      // Expired lock, clean up
      unlinkSync(lockPath);
      return null;
    } catch {
      return null;
    }
  }

  private cleanExpired(): void {
    const now = Date.now();

    // Clean in-memory cache
    for (const [file, lockInfo] of this.locks.entries()) {
      if (lockInfo.expiresAt <= now) {
        this.locks.delete(file);
      }
    }

    // Clean lock directory
    try {
      const lockFiles = readdirSync(this.lockDir).filter(f => f.startsWith("lock_"));
      for (const lockFile of lockFiles) {
        const lockPath = join(this.lockDir, lockFile);
        try {
          const content = readFileSync(lockPath, "utf-8");
          const lockInfo = JSON.parse(content) as LockInfo;
          if (lockInfo.expiresAt <= now) {
            unlinkSync(lockPath);
            // Remove from cache if present
            for (const [file, cached] of this.locks.entries()) {
              if (cached.taskId === lockInfo.taskId && cached.acquiredAt === lockInfo.acquiredAt) {
                this.locks.delete(file);
                break;
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    } catch {
      // Directory may not exist
    }
  }
}
