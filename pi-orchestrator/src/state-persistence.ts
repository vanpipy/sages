import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as yaml from "js-yaml";
import { assertOrchestratorNamespaceOwner, type OrchestratorNamespaceOwner } from "./namespace-ownership.js";

export interface StatePersistenceOptions<T> {
  owner: OrchestratorNamespaceOwner;
  validate: (value: unknown) => value is T;
}

const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 200;
const STALE_LOCK_MS = 30_000;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(waitArray, 0, 0, ms);
}

function assertDirectoryNotSymlink(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Symlink rejected in orchestrator state path: ${path}`);
  if (!stat.isDirectory()) throw new Error(`Expected directory in orchestrator state path: ${path}`);
}

function ensureStateDirectory(cwd: string): string {
  const root = resolve(cwd);
  const piDir = join(root, ".pi");
  const stateDir = join(piDir, "orchestrator");
  assertDirectoryNotSymlink(piDir);
  if (!existsSync(piDir)) mkdirSync(piDir, { mode: 0o700 });
  assertDirectoryNotSymlink(piDir);
  assertDirectoryNotSymlink(stateDir);
  if (!existsSync(stateDir)) mkdirSync(stateDir, { mode: 0o700 });
  assertDirectoryNotSymlink(stateDir);
  const realRoot = realpathSync(root);
  const realState = realpathSync(stateDir);
  const fromRoot = relative(realRoot, realState);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`Orchestrator state directory is not contained by cwd: ${stateDir}`);
  }
  try { chmodSync(stateDir, 0o700); } catch { /* non-POSIX */ }
  return realState;
}

function resolveContainedPath(cwd: string, relativePath: string, owner: OrchestratorNamespaceOwner): string {
  assertOrchestratorNamespaceOwner(relativePath, owner);
  const stateDir = ensureStateDirectory(cwd);
  const target = resolve(stateDir, relativePath);
  if (target !== stateDir && !target.startsWith(`${stateDir}${sep}`)) {
    throw new Error(`Orchestrator state path must be contained: ${relativePath}`);
  }

  // Nested owned namespaces (currently handoff/) are created component by
  // component so a pre-existing symlink cannot redirect the write.
  const parent = dirname(target);
  const parentRelative = relative(stateDir, parent);
  let cursor = stateDir;
  for (const component of parentRelative === "" ? [] : parentRelative.split(sep)) {
    cursor = join(cursor, component);
    assertDirectoryNotSymlink(cursor);
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
    assertDirectoryNotSymlink(cursor);
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Symlink state target rejected: ${relativePath}`);
  }
  return target;
}

function acquireLock(target: string): { path: string; fd: number } {
  const lockPath = join(dirname(target), `.lock-${basename(target)}`);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, "utf8");
      return { path: lockPath, fd };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const stat = lstatSync(lockPath);
      if (stat.isSymbolicLink()) throw new Error(`Symlink lock rejected: ${lockPath}`);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        try { unlinkSync(lockPath); } catch { /* another writer won */ }
        continue;
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  throw new Error(`Concurrent orchestrator state update timed out: ${target}`);
}

function releaseLock(lock: { path: string; fd: number }): void {
  try { closeSync(lock.fd); } finally {
    try { unlinkSync(lock.path); } catch { /* lock may already be stale-cleaned */ }
  }
}

function validateSerializedYaml<T>(content: string, options: StatePersistenceOptions<T>, path: string): T {
  let parsed: unknown;
  try { parsed = yaml.load(content); }
  catch (error) { throw new Error(`Malformed YAML state at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!options.validate(parsed)) throw new Error(`Malformed runtime state at ${path}`);
  return parsed;
}

/** Atomically create or replace an owned YAML artifact under .pi/orchestrator. */
export function atomicWriteOrchestratorFile<T>(
  cwd: string,
  relativePath: string,
  content: string,
  options: StatePersistenceOptions<T>,
): string {
  validateSerializedYaml(content, options, relativePath);
  const target = resolveContainedPath(cwd, relativePath, options.owner);
  const lock = acquireLock(target);
  const temp = join(dirname(target), `.tmp-${basename(target)}-${process.pid}-${crypto.randomUUID()}`);
  try {
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`State target is not a regular file: ${relativePath}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    try { chmodSync(target, 0o600); } catch { /* non-POSIX */ }
    return target;
  } finally {
    if (existsSync(temp)) try { unlinkSync(temp); } catch { /* best effort */ }
    releaseLock(lock);
  }
}

/** Atomically write a non-YAML owned report with the same containment/lock rules. */
export function atomicWriteOrchestratorText(
  cwd: string,
  relativePath: string,
  content: string,
  owner: OrchestratorNamespaceOwner,
): string {
  const target = resolveContainedPath(cwd, relativePath, owner);
  const lock = acquireLock(target);
  const temp = join(dirname(target), `.tmp-${basename(target)}-${process.pid}-${crypto.randomUUID()}`);
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, target);
    try { chmodSync(target, 0o600); } catch { /* non-POSIX */ }
    return target;
  } finally {
    if (existsSync(temp)) try { unlinkSync(temp); } catch { /* best effort */ }
    releaseLock(lock);
  }
}

/** Load owned YAML only after containment, symlink, parse, and runtime checks. */
export function loadYamlOrchestratorFile<T>(
  cwd: string,
  relativePath: string,
  options: StatePersistenceOptions<T>,
): T | null {
  const target = resolveContainedPath(cwd, relativePath, options.owner);
  if (!existsSync(target)) return null;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe state target: ${relativePath}`);
  return validateSerializedYaml(readFileSync(target, "utf8"), options, relativePath);
}

/** Runtime shape checks used by every stage; intentionally strict on mutable fields. */
export function isGoalContractState(value: unknown): value is Record<string, unknown> {
  const v = value as any;
  return !!v && typeof v === "object" && typeof v.id === "string" && typeof v.title === "string" &&
    Array.isArray(v.success_criteria) && Array.isArray(v.anti_goals) && !!v.scope && typeof v.done_definition === "string";
}

export function isOrchestrationPlanState(value: unknown): value is Record<string, unknown> {
  const v = value as any;
  const statuses = new Set(["pending", "in_progress", "completed", "failed", "skipped"]);
  const states = new Set(["draft", "approved", "executing", "completed", "failed"]);
  return !!v && typeof v === "object" && typeof v.id === "string" && typeof v.goal_id === "string" &&
    states.has(v.state) && Array.isArray(v.tasks) && v.tasks.every((task: any) =>
      task && typeof task.id === "string" && statuses.has(task.status) &&
      Number.isInteger(task.retry_count) && Number.isInteger(task.max_retries));
}
