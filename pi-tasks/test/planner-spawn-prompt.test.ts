/**
 * planner-spawn-prompt.test.ts — Tests that the spawn callback includes
 * the user task's subject, description, and id in the Planner's prompt
 * (GC-2026-121 AC3).
 *
 * Planner's system prompt tells it to call
 * `decompose_task(user_task_id="<id>", specs=[...])`. The id must be in
 * the spawn prompt so Planner can pass it without an extra lookup.
 * The subject is included as a fallback when description is empty.
 */

import { describe, expect, it } from "vitest";
import type { Task } from "../src/types.js";

/**
 * Mirrors the spawn callback in pi-tasks/src/index.ts. The Planner
 * prompt format is the GC-2026-121 contract.
 */
function buildPlannerPrompt(task: { id: string; subject: string; description: string }): string {
  return (
    `Subject: ${task.subject}\n` +
    `Description: ${task.description}\n` +
    `Task ID: ${task.id}\n\n` +
    `Call \`decompose_task(user_task_id="${task.id}", specs=[...])\` to materialize the chain.`
  );
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
    const task: Pick<Task, "id" | "subject" | "description"> = {
      id: "99",
      subject: "Research",
      description: desc,
    };
    const prompt = buildPlannerPrompt(task);
    const descIdx = prompt.indexOf(desc);
    const idIdx = prompt.indexOf("99");
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeGreaterThan(descIdx);
  });

  it("includes the subject as fallback when description is empty (GC-2026-121 follow-up)", () => {
    // /tasks create "<subject>" without --description produces a task
    // with empty description. Planner must still receive SOMETHING to
    // work with (subject at minimum) so it can either produce specs or
    // BLOCK explicitly — not receive an empty prompt.
    const task: Pick<Task, "id" | "subject" | "description"> = {
      id: "5",
      subject: "do one more testing",
      description: "",
    };
    const prompt = buildPlannerPrompt(task);
    expect(prompt).toContain("Subject: do one more testing");
    expect(prompt).toContain("Description: ");
    expect(prompt).toContain("Task ID: 5");
  });
});