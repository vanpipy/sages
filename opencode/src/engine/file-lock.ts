/**
 * FileLockManager - Cooperative File Locking for LuBan Agents
 *
 * Manages file locks to prevent concurrent access to shared files by multiple
 * LuBan agents. Locks are stored in a dedicated directory outside the project
 * git tree (.sages-filelocks/).
 *
 * Lock Directory Structure:
 * .sages-filelocks/
 *   {sha256(filePath)}/
 *     lock.json          # FileLock JSON
 *     heartbeat          # Empty file, mtime = last renewal
 *
 * Lock Acquisition Protocol:
 * 1. Compute lockKey = sha256(filePath)
 * 2. Check if .sages-filelocks/{lockKey}/lock.json exists
 * 3. If exists and not expired → return null (lock held)
 * 4. If expired or doesn't exist:
 *    a. Create directory .sages-filelocks/{lockKey}/
 *    b. Write lock.json with acquiredAt = now, expiresAt = now + TTL
 *    c. Touch heartbeat file
 *    d. Return FileLock
 */

import { promises as fs } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import type { WorkflowFileLock } from "./types.js";

/** Default lock TTL in seconds (30 minutes) */
const DEFAULT_LOCK_TTL = 1800;

/** Lock file name */
const LOCK_FILE_NAME = "lock.json";

/** Heartbeat file name */
const HEARTBEAT_FILE_NAME = "heartbeat";

/** Lock directory name within base directory */
const LOCK_DIR_NAME = ".sages-filelocks";

/**
 * Represents a file lock with metadata.
 */
export interface FileLock {
  /** Locked file path */
  path: string;
  /** Task ID that owns the lock */
  taskId: string;
  /** Agent ID that holds the lock */
  agentId: string;
  /** ISO timestamp when lock was acquired */
  acquiredAt: string;
  /** ISO timestamp when lock expires */
  expiresAt: string;
}

/**
 * FileLockManager provides cooperative file locking between LuBan agents.
 * Prevents concurrent modifications and stale reads of shared files.
 */
export class FileLockManager {
  private lockDir: string;
  private lockTtl: number;

  /**
   * Creates a new FileLockManager instance.
   * @param baseDir - Base directory for lock files (default: cwd)
   *                  Locks stored in {baseDir}/.sages-filelocks/
   * @param lockTtl - Lock time-to-live in seconds (default: 1800 = 30 minutes)
   */
  constructor(baseDir?: string, lockTtl: number = DEFAULT_LOCK_TTL) {
    // Store parent directory; locks go in .sages-filelocks subdirectory
    this.lockDir = baseDir ? join(baseDir, LOCK_DIR_NAME) : LOCK_DIR_NAME;
    this.lockTtl = lockTtl;
  }

  /**
   * Computes SHA256 hash of a file path for use as directory name.
   * @param filePath - The file path to hash
   * @returns Hex-encoded SHA256 hash
   */
  private hashPath(filePath: string): string {
    return createHash("sha256").update(filePath).digest("hex");
  }

  /**
   * Gets the lock directory path for a given file.
   * @param filePath - The file path
   * @returns Path to the lock directory
   */
  private getLockDir(filePath: string): string {
    return join(this.lockDir, this.hashPath(filePath));
  }

  /**
   * Gets the lock file path for a given file.
   * @param filePath - The file path
   * @returns Path to the lock.json file
   */
  private getLockFile(filePath: string): string {
    return join(this.getLockDir(filePath), LOCK_FILE_NAME);
  }

  /**
   * Gets the heartbeat file path for a given file.
   * @param filePath - The file path
   * @returns Path to the heartbeat file
   */
  private getHeartbeatFile(filePath: string): string {
    return join(this.getLockDir(filePath), HEARTBEAT_FILE_NAME);
  }

  /**
   * Checks if a lock is expired.
   * @param lock - The lock to check
   * @returns True if the lock has expired
   */
  private isLockExpired(lock: FileLock): boolean {
    return new Date(lock.expiresAt) < new Date();
  }

  /**
   * Reads and parses a lock file.
   * @param filePath - The file path being locked
   * @returns The parsed lock or null if not found/error
   */
  private async readLock(filePath: string): Promise<FileLock | null> {
    const lockFile = this.getLockFile(filePath);
    try {
      const content = await fs.readFile(lockFile, "utf-8");
      return JSON.parse(content) as FileLock;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      // Corrupted lock file - delete and treat as not locked
      if (error instanceof SyntaxError || err.code === "EBADMSG") {
        try {
          await fs.rm(this.getLockDir(filePath), { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
        return null;
      }
      throw error;
    }
  }

  /**
   * Acquires a lock on a file.
   * @param filePath - Path to the file to lock
   * @param taskId - Task ID requesting the lock
   * @param agentId - Agent ID requesting the lock
   * @param retryCount - Internal retry counter (max 3 attempts)
   * @returns The acquired FileLock or null if lock is held
   */
  async acquireLock(filePath: string, taskId: string, agentId: string, retryCount = 0): Promise<FileLock | null> {
    // Prevent infinite loops - max 3 retry attempts
    if (retryCount >= 3) {
      return null;
    }

    const lockDir = this.getLockDir(filePath);
    const lockFile = this.getLockFile(filePath);
    const heartbeatFile = this.getHeartbeatFile(filePath);

    // Ensure lock directory exists
    await fs.mkdir(lockDir, { recursive: true });

    // Check if lock already exists and is valid
    const existingLock = await this.readLock(filePath);
    if (existingLock && !this.isLockExpired(existingLock)) {
      // Lock exists and is still valid
      return null;
    }

    // Lock doesn't exist or is expired - try to acquire
    // Use write-then-rename for atomic file creation
    const tempFile = lockFile + ".tmp";

    try {
      // Try to write a temp file
      const now = new Date();
      const lock: FileLock = {
        path: filePath,
        taskId,
        agentId,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.lockTtl * 1000).toISOString(),
      };

      await fs.writeFile(tempFile, JSON.stringify(lock, null, 2), "utf-8");

      // Atomically rename temp file to lock file
      // This fails if lock file already exists (EEXIST)
      await fs.rename(tempFile, lockFile);
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        // Another process beat us - check if their lock is still valid
        const currentLock = await this.readLock(filePath);
        if (currentLock && !this.isLockExpired(currentLock)) {
          return null;
        }
        // Their lock expired - remove and retry
        try {
          await fs.rm(lockDir, { recursive: true, force: true });
          return this.acquireLock(filePath, taskId, agentId, retryCount + 1);
        } catch {
          return null;
        }
      }
      if (err.code === "ENOENT") {
        // Directory disappeared - retry
        return this.acquireLock(filePath, taskId, agentId, retryCount + 1);
      }
      throw error;
    }

    // We won the race - create heartbeat
    await fs.writeFile(heartbeatFile, "", "utf-8");

    // Return the lock we created
    const finalLock = await this.readLock(filePath);
    return finalLock;
  }

  /**
   * Releases a lock on a file.
   * @param filePath - Path to the file to unlock
   * @param taskId - Task ID that owns the lock
   */
  async releaseLock(filePath: string, taskId: string): Promise<void> {
    const lock = await this.readLock(filePath);
    if (!lock) {
      // Lock not found - log warning but don't error
      return;
    }

    // Verify caller owns the lock
    if (lock.taskId !== taskId) {
      return;
    }

    // Delete lock directory
    try {
      await fs.rm(this.getLockDir(filePath), { recursive: true, force: true });
    } catch {
      // Ignore errors during cleanup
    }
  }

  /**
   * Releases all locks held by a task.
   * @param taskId - Task ID whose locks to release
   */
  async releaseAllLocks(taskId: string): Promise<void> {
    const locks = await this.getAllLocks();
    for (const lock of locks) {
      if (lock.taskId === taskId) {
        await this.releaseLock(lock.path, taskId);
      }
    }
  }

  /**
   * Renews a lock, extending its expiration time.
   * @param filePath - Path to the file whose lock to renew
   * @param taskId - Task ID that owns the lock
   */
  async renewLock(filePath: string, taskId: string): Promise<void> {
    const lock = await this.readLock(filePath);
    if (!lock) {
      throw new Error(`Lock not found for file: ${filePath}`);
    }

    if (lock.taskId !== taskId) {
      throw new Error(`Lock not owned by task: ${taskId}`);
    }

    // Update expiration
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.lockTtl * 1000).toISOString();

    const updatedLock: FileLock = {
      ...lock,
      expiresAt,
    };

    // Write updated lock
    const lockFile = this.getLockFile(filePath);
    const tempFile = lockFile + ".tmp";
    await fs.writeFile(tempFile, JSON.stringify(updatedLock, null, 2), "utf-8");
    await fs.rename(tempFile, lockFile);

    // Update heartbeat
    const heartbeatFile = this.getHeartbeatFile(filePath);
    await fs.writeFile(heartbeatFile, "", "utf-8");
  }

  /**
   * Gets the lock for a file.
   * @param filePath - Path to the file
   * @returns The FileLock or null if not locked
   */
  async getLock(filePath: string): Promise<FileLock | null> {
    const lock = await this.readLock(filePath);
    if (!lock) {
      return null;
    }

    // Check if expired
    if (this.isLockExpired(lock)) {
      // Clean up expired lock
      try {
        await fs.rm(this.getLockDir(filePath), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      return null;
    }

    return lock;
  }

  /**
   * Gets all active locks.
   * @returns Array of all non-expired locks
   */
  async getAllLocks(): Promise<FileLock[]> {
    try {
      const entries = await fs.readdir(this.lockDir);
      const locks: FileLock[] = [];

      for (const entry of entries) {
        const lockDirPath = join(this.lockDir, entry);
        try {
          const stat = await fs.stat(lockDirPath);
          if (!stat.isDirectory()) {
            continue;
          }

          const lockFile = join(lockDirPath, LOCK_FILE_NAME);
          const lock = await this.readLockFromPath(lockFile);
          if (lock && !this.isLockExpired(lock)) {
            locks.push(lock);
          }
        } catch {
          // Skip entries we can't stat
        }
      }

      return locks;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /**
   * Reads a lock file from a specific path.
   * @param lockFile - Path to the lock file
   * @returns The parsed lock or null
   */
  private async readLockFromPath(lockFile: string): Promise<FileLock | null> {
    try {
      const content = await fs.readFile(lockFile, "utf-8");
      return JSON.parse(content) as FileLock;
    } catch {
      return null;
    }
  }

  /**
   * Checks if a file is locked.
   * @param filePath - Path to the file
   * @returns True if the file is locked
   */
  async isLocked(filePath: string): Promise<boolean> {
    const lock = await this.getLock(filePath);
    return lock !== null;
  }

  /**
   * Checks if a file is locked by a specific task.
   * @param filePath - Path to the file
   * @param taskId - Task ID to check
   * @returns True if the file is locked by the task
   */
  async isLockedByTask(filePath: string, taskId: string): Promise<boolean> {
    const lock = await this.getLock(filePath);
    return lock !== null && lock.taskId === taskId;
  }

  /**
   * Gets all locks for a specific task.
   * @param taskId - Task ID
   * @returns Array of locks held by the task
   */
  async getLocksForTask(taskId: string): Promise<FileLock[]> {
    const locks = await this.getAllLocks();
    return locks.filter(lock => lock.taskId === taskId);
  }

  /**
   * Cleans up expired locks.
   */
  async cleanup(): Promise<void> {
    try {
      const entries = await fs.readdir(this.lockDir);

      for (const entry of entries) {
        const lockDirPath = join(this.lockDir, entry);
        try {
          const stat = await fs.stat(lockDirPath);
          if (!stat.isDirectory()) {
            continue;
          }

          const lockFile = join(lockDirPath, LOCK_FILE_NAME);
          const lock = await this.readLockFromPath(lockFile);
          if (lock && this.isLockExpired(lock)) {
            await fs.rm(lockDirPath, { recursive: true, force: true });
          }
        } catch {
          // Skip entries we can't process
        }
      }
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
