/**
 * Scheduler — Batch execution engine with optimistic concurrency + auto-degrade
 *
 * Part of: src/tools/luban/
 * Purpose: Execute a Batch as an atomic unit, with parallel-by-default and
 *          automatic serial fallback when intra-batch file conflicts exist (KD-2).
 *
 * Public API:
 *   - topoLayers(tasks): layer-by-layer topological sort
 *   - runBatch(batch): main entry — returns BatchResult with mode/degraded/conflicts
 *
 * Contract:
 *   - Conflict detection runs on every batch call (KD-2: defensive, not redundant).
 *   - Degrade decision is per-batch, not stateful (S4).
 *   - When maxParallel=1, conflict detection is skipped (no benefit when explicit-serial).
 *   - Results array preserves task input order regardless of execution mode (S2 contract).
 *   - On task failure: other tasks continue (Promise.allSettled semantics).
 */

import { runTask } from "./task-runner.js";
import { detectFileConflicts, deriveTestFiles } from "./conflict-detector.js";
import type {
  Batch,
  BatchResult,
  LubanTask,
  TaskResult,
  TDDConfig,
} from "./types.js";

/**
 * Maximum length of a single topErrors entry. Bounded to keep KD-3 black-box
 * summary small — phase.error from `TDD_GUIDE.formatError()` concatenates
 * the original error with a 50+ line guidance block, which would explode
 * the agent's context window if surfaced verbatim.
 */
const TOP_ERROR_MAX_LENGTH = 200;

/**
 * Truncate a TDD phase error string to a bounded single-line form for the
 * KD-3 diagnosis field (`topErrors`).
 *
 * Rules:
 * - Take the first line of the error (TDD_GUIDE.formatError puts the
 *   original error before the first "\n\n" guidance block; the guidance
 *   itself starts with a markdown heading emoji and is not actionable
 *   for the agent).
 * - Slice to TOP_ERROR_MAX_LENGTH as a safety net for unusually long
 *   single-line errors (e.g. long TypeScript error messages).
 *
 * Pure function: no I/O, no side effects.
 */
export function truncatePhaseError(error: string | undefined): string {
  if (!error) return "unknown error";
  const firstLine = error.split("\n")[0] ?? "";
  return firstLine.slice(0, TOP_ERROR_MAX_LENGTH);
}

/**
 * Format a single topErrors entry from a failing TaskResult.
 * Combines the taskId with the truncated first line of the failed phase error.
 */
function formatTopErrorEntry(taskId: string, error: string | undefined): string {
  return `${taskId}: ${truncatePhaseError(error)}`;
}

/**
 * Thrown when topoLayers detects a circular dependency.
 *
 * Callers can use `instanceof CircularDependencyError` to distinguish cycle
 * failures from other Error types (e.g. memory exhaustion, programmer errors).
 */
export class CircularDependencyError extends Error {
  readonly cycleTaskIds: string[];
  constructor(taskIds: string[]) {
    super(`Circular dependency detected involving tasks: ${taskIds.join(", ")}`);
    this.name = "CircularDependencyError";
    this.cycleTaskIds = taskIds;
  }
}

/**
 * Build a synthetic TaskResult for a task that threw rather than returned.
 * Used to preserve task input order in BatchResult.results even when
 * runOne throws (serial + parallel modes both isolate failures).
 */
function syntheticFailedResult(task: LubanTask, error: unknown): TaskResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    taskId: task.id,
    success: false,
    duration: 0,
    phases: [{ name: "RED", status: "failed", error: message }],
  };
}

/**
 * Topologically sort tasks into dependency-respecting layers.
 *
 * Layer 0: tasks whose dependsOn is empty.
 * Layer i: tasks whose dependencies are all in layers < i.
 *
 * @throws Error when circular dependency is detected.
 */
export function topoLayers(tasks: LubanTask[]): LubanTask[][] {
  const taskMap = new Map<string, LubanTask>();
  for (const t of tasks) taskMap.set(t.id, t);

  // remaining: id → set of unresolved deps
  const remaining = new Map<string, Set<string>>();
  for (const t of tasks) remaining.set(t.id, new Set(t.dependsOn));

  const layers: LubanTask[][] = [];
  const completed = new Set<string>();

  while (remaining.size > 0) {
    const ready: LubanTask[] = [];
    for (const [id, deps] of remaining.entries()) {
      const allDone = [...deps].every((d) => completed.has(d));
      if (allDone) {
        ready.push(taskMap.get(id)!);
      }
    }
    if (ready.length === 0) {
      throw new CircularDependencyError([...remaining.keys()]);
    }
    for (const t of ready) {
      remaining.delete(t.id);
      completed.add(t.id);
    }
    layers.push(ready);
  }

  return layers;
}

/**
 * Run a batch with optimistic concurrency + automatic serial degrade.
 *
 * Decision tree:
 *   1. If maxParallel === 1 → mode='serial' (no detection, explicit caller intent).
 *   2. Otherwise detectFileConflicts(tasks):
 *      - conflicts.length > 0 → mode='serial', degraded=true, conflicts populated.
 *      - else → mode='parallel', degraded=false.
 *   3. Execute accordingly; preserve input order in results[].
 */
export async function runBatch(batch: Batch): Promise<BatchResult> {
  // ── 0. Validate inputs (fail-fast) ──────────────────────────────────────────
  if (batch.maxParallel < 1) {
    throw new Error(
      `Invalid batch.maxParallel=${batch.maxParallel}: must be >= 1. ` +
        `Use maxParallel=1 for explicit serial execution.`
    );
  }

  // Use performance.now() (monotonic) instead of Date.now() (wall-clock) so
  // totalDuration is robust to NTP corrections / manual clock changes / VM resume.
  const startTime = performance.now();
  const totalTasks = batch.tasks.length;
  const results: (TaskResult | undefined)[] = new Array(totalTasks);

  // ── 1. Decide mode ────────────────────────────────────────────────────────
  let mode: "parallel" | "serial";
  let degraded = false;
  let conflicts: string[] | undefined;

  if (batch.maxParallel === 1) {
    mode = "serial";
  } else {
    const report = detectFileConflicts(batch.tasks);
    if (report.conflicts.length > 0) {
      mode = "serial";
      degraded = true;
      conflicts = report.conflicts;
    } else {
      mode = "parallel";
    }
  }

  // ── 2. Execute ────────────────────────────────────────────────────────────
  if (mode === "serial") {
    // Serial mode: isolate failures so one throw doesn't terminate the loop.
    for (let i = 0; i < totalTasks; i++) {
      const task = batch.tasks[i];
      try {
        results[i] = await runOne(task, batch);
      } catch (error) {
        results[i] = syntheticFailedResult(task, error);
      }
    }
  } else {
    // Parallel mode — layer-by-layer, worker pool ≤ maxParallel
    const layers = topoLayers(batch.tasks);
    for (const layer of layers) {
      await runLayerWithPool(layer, batch, results);
    }
  }

  // ── 3. Aggregate ──────────────────────────────────────────────────────────
  const finalResults = results.map(
    (r, i) =>
      r ?? {
        taskId: batch.tasks[i].id,
        success: false,
        duration: 0,
        phases: [{ name: "RED" as const, status: "failed" as const, error: "Task did not produce a result (internal error)" }],
      }
  );
  const completed = finalResults.filter((r) => r.success).map((r) => r.taskId);
  const success = finalResults.every((r) => r.success);

  // KD-3 black-box contract: surface a small slice of failure reasons so the
  // agent can diagnose batch failures without bypassing the contract.
  // Each entry is bounded to TOP_ERROR_MAX_LENGTH characters and contains
  // no newlines (TDD_GUIDE guidance block stripped).
  const topErrors = finalResults
    .filter((r) => !r.success)
    .slice(0, 3)
    .map((r) => {
      const failedPhase = r.phases.find((p) => p.status === "failed");
      return formatTopErrorEntry(r.taskId, failedPhase?.error);
    });

  return {
    success,
    mode,
    degraded,
    conflicts,
    results: finalResults,
    completed,
    totalDuration: performance.now() - startTime,
    ...(topErrors.length > 0 ? { topErrors } : {}),
  };
}

/**
 * Worker pool: run all tasks in a layer with at most `maxParallel` concurrent workers.
 * Preserves input order by writing results at the original task index.
 */
async function runLayerWithPool(
  layer: LubanTask[],
  batch: Batch,
  results: (TaskResult | undefined)[]
): Promise<void> {
  const queue = [...layer];
  const workerCount = Math.min(batch.maxParallel, layer.length);

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      const origIndex = batch.tasks.findIndex((t) => t.id === task.id);
      try {
        results[origIndex] = await runOne(task, batch);
      } catch (error) {
        results[origIndex] = syntheticFailedResult(task, error);
      }
    }
  }

  const workers = Array.from({ length: workerCount }, () => worker());
  // Promise.allSettled: a thrown worker must not abandon siblings mid-execution.
  // The contract documented in runBatch ("Promise.allSettled semantics") now
  // actually matches the implementation.
  await Promise.allSettled(workers);
}

/**
 * Wrap runTask with batch-level config.
 */
async function runOne(task: LubanTask, batch: Batch): Promise<TaskResult> {
  const testFiles = task.testFiles ?? deriveTestFiles(task.files);
  const config: TDDConfig = {
    taskId: task.id,
    taskDescription: task.description,
    sourceFiles: task.files,
    testFiles,
    testCommand: batch.testCommand,
    cwd: batch.cwd,
  };
  return runTask(config);
}