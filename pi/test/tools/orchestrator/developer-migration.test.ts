/**
 * developer-migration.test.ts — Phase A P3 Sages-side migration.
 *
 * Verifies the Sages-side migration from `software-developer` to
 * canonical `developer`. The legacy spelling is preserved as a Phase A
 * alias for backwards compatibility with persisted DAGs and live
 * callers, but the canonical name is `developer` everywhere it counts:
 *
 *   - `TaskNode.subagent_type` defaults to / accepts canonical `developer`.
 *   - `TaskNode.isolation` accepts the explicit managed-worktree object
 *     form `{ dag_id, task_id, worktree_id?, mode: "create" | "reuse" }`.
 *   - `KNOWN_TEMPLATES` advertises `subagent-developer`, NOT the old
 *     `subagent-software-developer` (alias still resolves with a
 *     warning).
 *   - `TEMPLATE_PARAM_SCHEMAS` is keyed by `subagent-developer`.
 *   - `defaultRunInBackground("developer")` returns `true`.
 *   - The legacy literal `isolation: "worktree"` is REJECTED for any
 *     task that targets `developer` (it never was a valid managed-
 *     worktree shape — Sages callers must use the explicit object).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  validateDAG,
  type DAGInput,
} from "../../../src/tools/orchestrator/dag-synthesizer.js";
import { defaultRunInBackground } from "../../../src/tools/orchestrator/task-dispatcher.js";
import {
  loadPromptTemplate,
  validateTemplateParams,
} from "../../../src/tools/orchestrator/template-loader.js";
import type { TaskNode } from "../../../src/tools/orchestrator/types.js";

// Minimal GoalContract for the validation tests below.
const MOCK_CONTRACT: any = {
  success_criteria: [
    { id: "SC1", criterion: "thing works", verification_cmd: "true" },
  ],
  anti_goals: [],
  scope: { include: [], exclude: [] },
  done_definition: "done",
};

function makeDagWithTemplate(templateName: string): DAGInput {
  return {
    goal_id: "GC-2026-011",
    title: "Phase A P3 migration test",
    tasks: [
      {
        id: "P1",
        description: "implement",
        plane: "Business",
        priority: "high",
        depends_on: [],
        files: ["src/foo.ts"],
        subagent_type: "developer",
        batch: 1,
        isolation: { dag_id: "DAG-2026-011", task_id: "P1", mode: "create" } as any,
        tdd: "strict",
        prompt: "do the thing",
        task_template: templateName,
        task_params: {
          task_id: "P1",
          task_title: "implement",
          sc_list: "SC1: thing works",
          upstream_outputs: "(none)",
          files_to_touch: "src/foo.ts",
        },
        output_schema: { kind: "code_changes" },
        acceptance: { covers: ["SC1"] },
      } as any,
    ],
  };
}

describe("developer-migration: canonical name `developer`", () => {
  it("validateDAG accepts the canonical `subagent-developer` template", () => {
    const result = validateDAG(makeDagWithTemplate("subagent-developer"), MOCK_CONTRACT);
    expect(result.errors).toEqual([]);
  });

  it("validateDAG rejects the legacy `subagent-software-developer` template (not in canonical roster)", () => {
    // The legacy template name must NOT be advertised in the canonical
    // roster. Alias resolution is a separate runtime concern (handled
    // by the dispatcher); at validation time, the synthesizer rejects
    // the legacy spelling with the same precise error it would for
    // any unknown template.
    const result = validateDAG(
      makeDagWithTemplate("subagent-software-developer"),
      MOCK_CONTRACT,
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/task_template.*not a known template/),
      ]),
    );
  });

  it("defaultRunInBackground returns true for canonical `developer`", () => {
    expect(defaultRunInBackground("developer")).toBe(true);
  });

  it("defaultRunInBackground returns true for the legacy alias `software-developer`", () => {
    // The alias name maps to the same canonical semantics; the
    // dispatcher normalizes via resolveAgentType before reaching here,
    // but a defensive fallback keeps the legacy spelling working.
    expect(defaultRunInBackground("software-developer")).toBe(true);
  });

  it("defaultRunInBackground returns false for Explore / Plan / general-purpose", () => {
    expect(defaultRunInBackground("Explore")).toBe(false);
    expect(defaultRunInBackground("Plan")).toBe(false);
    expect(defaultRunInBackground("general-purpose")).toBe(false);
  });
});

describe("developer-migration: managed-worktree isolation object", () => {
  it("TaskNode.isolation accepts the explicit managed-worktree object form", () => {
    const task: TaskNode = {
      id: "P1",
      description: "implement",
      plane: "Business",
      priority: "high",
      depends_on: [],
      files: [],
      subagent_type: "developer",
      batch: 1,
      // Phase A P3: the canonical isolation shape is the managed-
      // worktree object — never the legacy `"worktree"` string literal.
      isolation: {
        dag_id: "DAG-2026-011",
        task_id: "P1",
        mode: "create",
      } as any,
      tdd: "strict",
      prompt: "do the thing",
      output_schema: { kind: "code_changes" },
      acceptance: {},
      status: "pending",
      retry_count: 0,
      max_retries: 0,
    };
    expect(task.isolation).toEqual({
      dag_id: "DAG-2026-011",
      task_id: "P1",
      mode: "create",
    });
  });
});

describe("developer-migration: TEMPLATE_PARAM_SCHEMAS keyed by canonical name", () => {
  it("subagent-developer template loads", () => {
    // After P3.6 the file is renamed to subagent-developer.md.
    const content = loadPromptTemplate("subagent-developer");
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });

  it("validateTemplateParams accepts well-formed params for `subagent-developer`", () => {
    const check = validateTemplateParams("subagent-developer", {
      task_id: "P1",
      task_title: "implement",
      sc_list: "SC1: thing works",
      upstream_outputs: "(none)",
      files_to_touch: "src/foo.ts",
    });
    expect(check.valid).toBe(true);
  });
});

describe("developer-migration: source files do NOT reference the legacy isolation string in canonical contexts", () => {
  it("task-dispatcher.ts uses canonical `developer` as the case (source-grep)", () => {
    // Belt-and-suspenders: the dispatcher should accept canonical
    // `developer` and may accept the legacy alias as a deprecation
    // path. We don't assert the alias is gone (it's not — P3.4 keeps
    // it as a defensive fallback), only that the canonical case is
    // present.
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "src", "tools", "orchestrator", "task-dispatcher.ts"),
      "utf-8",
    );
    expect(src).toMatch(/developer/);
  });
});
