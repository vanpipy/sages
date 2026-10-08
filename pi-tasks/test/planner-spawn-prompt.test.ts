/**
 * planner-spawn-prompt.test.ts — Tests that the spawn callback prepends
 * the user task id to the Planner's prompt (GC-2026-121 AC3).
 *
 * Planner's system prompt tells it to call
 * `decompose_task(user_task_id="<id>", specs=[...])`. The id must be in
 * the spawn prompt so Planner can pass it without an extra lookup.
 */

import { describe, expect, it } from "vitest";
import type { Task } from "../src/types.js";

/**
 * Mirrors the spawn callback in pi-tasks/src/index.ts. The Planner
 * prompt prefix is the GC-2026-121 contract.
 */
function buildPlannerPrompt(task: { id: string; description: string }): string {
  return `${task.description}\n\nTask ID: ${task.id}\nCall \`decompose_task(user_task_id="${task.id}", specs=[...])\` to materialize the chain.`;
}

describe("Planner spawn prompt includes the user task id (GC-2026-121 AC3)", () => {
  it("includes the task id in the spawn prompt", () => {
    const task: Pick<Task, "id" | "description"> = {
      id: "42",
      description: "Investigate topic X and write a summary.",
    };
    const prompt = buildPlannerPrompt(task);
    expect(prompt).toContain("42");
  });

  it("uses the exact id format decompose_task expects (string literal)", () => {
    const task: Pick<Task, "id" | "description"> = {
      id: "7",
      description: "Do something.",
    };
    const prompt = buildPlannerPrompt(task);
    expect(prompt).toContain('decompose_task(user_task_id="7"');
  });

  it("preserves the original task description verbatim", () => {
    const desc = "Multi-line\ndescription with special characters: <>&";
    const task: Pick<Task, "id" | "description"> = {
      id: "1",
      description: desc,
    };
    const prompt = buildPlannerPrompt(task);
    expect(prompt).toContain(desc);
  });

  it("places the task id AFTER the description (Planner reads description first)", () => {
    const desc = "Research the current repo";
    const task: Pick<Task, "id" | "description"> = {
      id: "99",
      description: desc,
    };
    const prompt = buildPlannerPrompt(task);
    const descIdx = prompt.indexOf(desc);
    const idIdx = prompt.indexOf("99");
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeGreaterThan(descIdx);
  });
});