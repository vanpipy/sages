import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { executeTaskDispatch } from "@/task-dispatcher.js";
import type { OrchestrationPlan, TaskNode } from "@/types.js";

function task(id = "P1"): TaskNode {
  return {
    id, description: `task ${id}`, plane: "Business", priority: "high", depends_on: [], files: [],
    subagent_type: "developer", batch: 1, isolation: "current-workspace", tdd: "strict", prompt: `implement ${id} with tests`,
    output_schema: { kind: "code_changes" }, acceptance: { covers: ["SC1"] }, status: "pending", retry_count: 0, max_retries: 2,
  };
}
function plan(tasks = [task()]): OrchestrationPlan {
  return { id: "DAG-test", goal_id: "GC-test", title: "test", tasks, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), state: "approved", prompts: {} };
}
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sages-dispatch-"));
  mkdirSync(join(cwd, ".pi/orchestrator"), { recursive: true });
  writeFileSync(join(cwd, ".pi/orchestrator/dag-DAG-test.yaml"), yaml.dump(plan()), "utf8");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const parse = (r: any) => JSON.parse(r.content[0].text);
const persisted = () => yaml.load(readFileSync(join(cwd, ".pi/orchestrator/dag-DAG-test.yaml"), "utf8")) as OrchestrationPlan;

describe("task_dispatch lifecycle persistence", () => {
  it("remains a planner and marks the plan executing without spawning", async () => {
    let spawnCalls = 0;
    const r = parse(await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto" }, { cwd, spawn: () => spawnCalls++ } as any));
    expect(r.status).toBe("in_progress");
    expect(spawnCalls).toBe(0);
    expect(persisted().tasks[0].status).toBe("pending");
    expect(persisted().state).toBe("executing");
  });

  it("persists pending -> in_progress -> completed with agent, result, and timestamps", async () => {
    await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto" }, { cwd });
    const started = parse(await executeTaskDispatch({
      dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "in_progress", agent_id: "agent-1" },
    }, { cwd }));
    expect(started.task.status).toBe("in_progress");
    expect(persisted().tasks[0].agent_id).toBe("agent-1");
    expect(typeof persisted().tasks[0].started_at).toBe("string");

    const done = parse(await executeTaskDispatch({
      dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "completed", result: "commit abc; tests pass" },
    }, { cwd }));
    expect(done.task.status).toBe("completed");
    const saved = persisted();
    expect(saved.tasks[0].result).toContain("tests pass");
    expect(typeof saved.tasks[0].completed_at).toBe("string");
    expect(saved.state).toBe("completed");
  });

  it("persists failures, error, timestamp, and retry count", async () => {
    await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto" }, { cwd });
    await executeTaskDispatch({ dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "in_progress", agent_id: "agent-1" } }, { cwd });
    const failed = parse(await executeTaskDispatch({ dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "failed", error: "test failed" } }, { cwd }));
    expect(failed.task.status).toBe("failed");
    const saved = persisted();
    expect(saved.tasks[0].error).toBe("test failed");
    expect(saved.tasks[0].retry_count).toBe(1);
    expect(typeof saved.tasks[0].completed_at).toBe("string");
    expect(saved.state).toBe("failed");
  });

  it("rejects duplicate planning and invalid or duplicate transitions", async () => {
    await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto" }, { cwd });
    expect(parse(await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto" }, { cwd })).status).toBe("error");
    expect(parse(await executeTaskDispatch({ dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "completed", result: "no start" } }, { cwd })).status).toBe("error");
    await executeTaskDispatch({ dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "in_progress", agent_id: "agent-1" } }, { cwd });
    const duplicate = parse(await executeTaskDispatch({ dag_id: "DAG-test", strategy: "step", transition: { task_id: "P1", status: "in_progress", agent_id: "agent-1" } }, { cwd }));
    expect(duplicate.status).toBe("error");
    expect(duplicate.validation.errors.join(" ")).toMatch(/duplicate|invalid transition/i);
  });

  it("force performs a real reset of terminal task state before replanning", async () => {
    const p = plan();
    Object.assign(p.tasks[0], { status: "completed", agent_id: "old", result: "old result", output: "old", error: "old", started_at: "2025-01-01", completed_at: "2025-01-02", retry_count: 2 });
    p.state = "completed";
    writeFileSync(join(cwd, ".pi/orchestrator/dag-DAG-test.yaml"), yaml.dump(p), "utf8");
    const r = parse(await executeTaskDispatch({ dag_id: "DAG-test", strategy: "auto", force: true }, { cwd }));
    expect(r.status).toBe("in_progress");
    const reset = persisted().tasks[0];
    expect(reset.status).toBe("pending");
    expect(reset.retry_count).toBe(0);
    for (const field of ["agent_id", "result", "output", "error", "started_at", "completed_at"]) expect((reset as any)[field]).toBeUndefined();
  });
});
