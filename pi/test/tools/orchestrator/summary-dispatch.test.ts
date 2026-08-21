/**
 * Tests for task_dispatch summary-by-default output (GC-2026-063).
 *
 * `task_dispatch` previously echoed the full `DispatchPlan` — including
 * every task's complete `prompt` — back in `content[0].text`. That prompt
 * was authored by the LLM in `dag_synthesize` and is already persisted in
 * `.pi/orchestrator/dag-*.yaml`, so echoing it was pure redundancy (and
 * made the tool return extremely verbose).
 *
 * Default (verbose omitted) now returns a compact summary per task
 * (`task_id` / `subagent_type` / `isolation` / `run_in_background` /
 * `prompt_preview`). `verbose: true` restores the full dispatch with
 * prompts. The transition path is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { executeTaskDispatch } from "@/tools/orchestrator/task-dispatcher.js";
import type { OrchestrationPlan, TaskNode } from "@/tools/orchestrator/types.js";

function longPrompt(id: string): string {
  return `implement ${id} with comprehensive tests. ` + "lorem ipsum dolor sit amet ".repeat(15);
}

function task(id = "P1"): TaskNode {
  return {
    id, description: `task ${id}`, plane: "Business", priority: "high", depends_on: [], files: [],
    subagent_type: "developer", batch: 1, isolation: "current-workspace", tdd: "strict",
    prompt: longPrompt(id),
    output_schema: { kind: "code_changes" }, acceptance: { covers: ["SC1"] }, status: "pending", retry_count: 0, max_retries: 2,
  };
}

function plan(tasks = [task()]): OrchestrationPlan {
  return { id: "DAG-test", goal_id: "GC-test", title: "test", tasks, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), state: "approved", prompts: {} };
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sages-summary-dispatch-"));
  mkdirSync(join(cwd, ".pi/orchestrator"), { recursive: true });
  writeFileSync(join(cwd, ".pi/orchestrator/dag-DAG-test.yaml"), yaml.dump(plan()), "utf8");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("task_dispatch summary-by-default", () => {
  it("default (verbose omitted) returns a compact dispatch summary without the full prompt", async () => {
    const r = parse(await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto" }, { cwd }));
    expect(r.status).toBe("in_progress");
    expect(r.dispatch.total_tasks).toBe(1);

    const batch = r.dispatch.batches[0];
    expect(typeof batch.batch).toBe("number");
    expect(typeof batch.parallel_safe).toBe("boolean");

    const t = batch.tasks[0];
    expect(t.task_id).toBe("P1");
    expect(t.subagent_type).toBe("developer");
    expect(t.isolation).toBe("current-workspace");
    expect(typeof t.run_in_background).toBe("boolean");
    expect(typeof t.prompt_preview).toBe("string");
    // the full prompt must NOT leak into the default summary
    expect(t.prompt).toBeUndefined();
    // prompt_preview is truncated safely: 120 chars + "..." = 123 ≤ 124
    expect(t.prompt_preview.length).toBeLessThanOrEqual(124);
    expect(t.prompt_preview.endsWith("...")).toBe(true);
  });

  it("verbose:true returns the full dispatch with the full task prompt", async () => {
    const r = parse(await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto", verbose: true }, { cwd }));
    const t = r.dispatch.batches[0].tasks[0];
    expect(typeof t.prompt).toBe("string");
    // full prompt is longer than any summary preview
    expect(t.prompt.length).toBeGreaterThan(120);
    expect(t.prompt).toContain("handoff_template: standard");
    expect(t.prompt_preview).toBeUndefined();
  });

  it("transition path still returns a compact {task, plan_state} with no summary wrapper", async () => {
    await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto" }, { cwd });
    const r = parse(await executeTaskDispatch({
      dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "in_progress", agent_id: "agent-1" },
    }, { cwd }));
    expect(r.task.id).toBe("P1");
    expect(r.task.status).toBe("in_progress");
    expect(r.plan_state).toBe("executing");
    expect(r.dispatch).toBeUndefined();
  });
});
