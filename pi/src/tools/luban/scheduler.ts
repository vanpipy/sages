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
import { detectFileConflicts } from "./conflict-detector.js";
import type {
  Batch,
  BatchResult,
  LubanTask,
  TaskResult,
  TDDConfig,
} from "./types.js";

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
      throw new Error(
        "Circular dependency detected: cannot resolve remaining tasks " +
          [...remaining.keys()].join(", ")
      );
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
  const startTime = Date.now();
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
    for (let i = 0; i < totalTasks; i++) {
      const task = batch.tasks[i];
      const result = await runOne(task, batch);
      results[i] = result;
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

  return {
    success,
    mode,
    degraded,
    conflicts,
    results: finalResults,
    completed,
    totalDuration: Date.now() - startTime,
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
      results[origIndex] = await runOne(task, batch);
    }
  }

  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
}

/**
 * Wrap runTask with batch-level config.
 */
async function runOne(task: LubanTask, batch: Batch): Promise<TaskResult> {
  const testFiles =
    task.testFiles ??
    task.files.map((f) => f.replace(/(\.ts|\.js)$/, ".test.$1"));
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