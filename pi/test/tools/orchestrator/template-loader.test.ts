/**
 * Tests for orchestrator template loader.
 * RED phase: tests should fail until template-loader.ts is implemented.
 */

import { describe, it, expect } from "bun:test";
import {
  findSagesRoot,
  findTemplatesRoot,
  loadPromptTemplate,
  loadGoalTemplate,
  loadDagTemplate,
  loadResponseTemplate,
  renderTemplate,
  renderTaskPrompt,
  listTemplates,
} from "@/tools/orchestrator/template-loader.js";

describe("template-loader", () => {
  describe("findSagesRoot", () => {
    it("returns a path to the installed sages package", () => {
      const root = findSagesRoot();
      expect(root).not.toBeNull();
      expect(root).toContain("sages");
    });

    it("the returned path contains a package.json", () => {
      // Sanity check via findTemplatesRoot which depends on it
      expect(findTemplatesRoot()).not.toBeNull();
    });
  });

  describe("loadPromptTemplate", () => {
    it("loads subagent-software-developer.md", () => {
      const content = loadPromptTemplate("subagent-software-developer");
      expect(content).not.toBeNull();
      expect(content).toContain("Your Task");
      expect(content).toContain("STRICT TDD");
      expect(content).toContain("{{task_id}}");
    });

    it("loads subagent-software-auditor.md", () => {
      const content = loadPromptTemplate("subagent-software-auditor");
      expect(content).not.toBeNull();
      expect(content).toContain("NEEDS WORK");
      expect(content).toContain("verification_cmd");
    });

    it("loads subagent-explore.md", () => {
      const content = loadPromptTemplate("subagent-explore");
      expect(content).not.toBeNull();
      expect(content).toContain("READ-ONLY");
    });

    it("loads subagent-general-purpose.md", () => {
      const content = loadPromptTemplate("subagent-general-purpose");
      expect(content).not.toBeNull();
      expect(content).toContain("First Action Protocol");
    });

    it("returns null for unknown template", () => {
      const content = loadPromptTemplate("nonexistent-template-xxx");
      expect(content).toBeNull();
    });
  });

  describe("loadGoalTemplate / loadDagTemplate / loadResponseTemplate", () => {
    it("loads goal-refactor.yaml", () => {
      const content = loadGoalTemplate("goal-refactor");
      expect(content).not.toBeNull();
      expect(content).toContain("success_criteria");
      expect(content).toContain("verification_cmd");
    });

    it("loads goal-fix-bug.yaml", () => {
      const content = loadGoalTemplate("goal-fix-bug");
      expect(content).not.toBeNull();
      expect(content).toContain("anti_goals");
    });

    it("loads dag-tdd-refactor.yaml", () => {
      const content = loadDagTemplate("dag-tdd-refactor");
      expect(content).not.toBeNull();
      expect(content).toContain("tasks:");
      expect(content).toContain("batch: 1");
      expect(content).toContain("task_template:");
    });

    it("loads dag-bug-fix.yaml", () => {
      const content = loadDagTemplate("dag-bug-fix");
      expect(content).not.toBeNull();
      expect(content).toContain("batch: 2");
      expect(content).toContain("tdd: strict");
    });

    it("loads response goal-intake.md", () => {
      const content = loadResponseTemplate("goal-intake");
      expect(content).not.toBeNull();
      expect(content).toContain("I understand you want to");
      expect(content).toContain("My draft goal");
      expect(content).toContain("Proposed Success Criteria");
    });

    it("loads response progress-update.md", () => {
      const content = loadResponseTemplate("progress-update");
      expect(content).not.toBeNull();
      expect(content).toContain("Progress Update");
    });
  });

  describe("renderTemplate", () => {
    it("substitutes simple {{var}} placeholders", () => {
      const out = renderTemplate("Hello {{name}}", { name: "world" });
      expect(out).toBe("Hello world");
    });

    it("substitutes multiple variables", () => {
      const out = renderTemplate(
        "Task {{task_id}}: {{title}} (status: {{status}})",
        { task_id: "P1", title: "Find imports", status: "in_progress" },
      );
      expect(out).toBe("Task P1: Find imports (status: in_progress)");
    });

    it("leaves a placeholder marker for missing variables", () => {
      const out = renderTemplate("Hello {{name}}", {});
      expect(out).toBe("Hello [name]");
    });

    it("handles {{#if var}}...{{/if}} truthy blocks", () => {
      const tpl = "{{#if strict}}STRICT MODE{{/if}}{{#if none}}LIGHT{{/if}}";
      expect(renderTemplate(tpl, { strict: true, none: false })).toBe("STRICT MODE");
    });

    it("handles {{#if var == 'value'}}...{{/if}} equality blocks", () => {
      const tpl = "{{#if mode == 'strict'}}USE TDD{{/if}}";
      expect(renderTemplate(tpl, { mode: "strict" })).toBe("USE TDD");
      expect(renderTemplate(tpl, { mode: "none" })).toBe("");
    });

    it("renders array values via stringification", () => {
      const out = renderTemplate("Files: {{files}}", { files: ["a.ts", "b.ts"] });
      expect(out).toBe("Files: a.ts,b.ts");
    });
  });

  describe("renderTaskPrompt", () => {
    it("renders a software-developer task prompt with params", () => {
      const out = renderTaskPrompt("subagent-software-developer", {
        task_id: "P4",
        task_title: "Implement UserRepository",
        sc_list: "- SC1: typecheck passes\n- SC2: tests pass",
        tdd_mode: "strict",
        upstream_outputs: "(none)",
        files_to_touch: "src/auth/repository/UserRepository.ts",
      });
      expect(out).not.toBeNull();
      // Markdown bold uses ** — be lenient
      expect(out).toContain("Task ID");
      expect(out).toContain("P4");
      expect(out).toContain("Implement UserRepository");
      expect(out).toContain("STRICT TDD");
      expect(out).toContain("First Action Protocol");
      expect(out).toContain("src/auth/repository/UserRepository.ts");
    });

    it("renders auditor prompt with audit-specific guidance", () => {
      const out = renderTaskPrompt("subagent-software-auditor", {
        task_id: "P7",
        task_title: "Audit refactor",
        sc_list: "- SC1: refactor complete",
        depth: "full",
        task_report_path: ".pi/orchestrator/task-P7-report.md",
        isolation: "none",
      });
      expect(out).not.toBeNull();
      expect(out).toContain("Audit Task");
      expect(out).toContain("NEEDS WORK");
      expect(out).toContain("Full mode");
    });

    it("returns null for unknown template name", () => {
      const out = renderTaskPrompt("nonexistent-template", {});
      expect(out).toBeNull();
    });
  });

  describe("listTemplates", () => {
    it("returns the 4 known prompt templates", () => {
      const names = listTemplates("prompts");
      expect(names).toContain("subagent-software-developer");
      expect(names).toContain("subagent-software-auditor");
      expect(names).toContain("subagent-general-purpose");
      expect(names).toContain("subagent-explore");
      expect(names.length).toBeGreaterThanOrEqual(4);
    });

    it("returns the 4 known goal templates", () => {
      const names = listTemplates("goals");
      expect(names).toContain("goal-refactor");
      expect(names).toContain("goal-new-feature");
      expect(names).toContain("goal-fix-bug");
      expect(names).toContain("goal-add-tests");
    });

    it("returns the 2 known dag templates", () => {
      const names = listTemplates("dag");
      expect(names).toContain("dag-tdd-refactor");
      expect(names).toContain("dag-bug-fix");
    });

    it("returns the 2 known response templates", () => {
      const names = listTemplates("responses");
      expect(names).toContain("goal-intake");
      expect(names).toContain("progress-update");
    });
  });
});