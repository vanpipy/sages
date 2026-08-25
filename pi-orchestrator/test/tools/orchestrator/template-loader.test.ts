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
} from "@/template-loader.js";

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
    it("loads subagent-developer.md", () => {
      const content = loadPromptTemplate("subagent-developer");
      expect(content).not.toBeNull();
      // Carries ONLY task-specific data (identity lives in agent definition)
      expect(content).toContain("{{task_id}}");
      expect(content).toContain("{{sc_list}}");
      expect(content).toContain("{{files_to_touch}}");
      expect(content).toContain("{{acceptance_cmd}}");
      expect(content).toContain("{{workspace_id}}");
      expect(content).toContain("{{upstream_handoffs}}");
      // GC-2026-028: developer namespace owns
      //   - task-<task_id>-report.md  (developer-owned per-task report)
      //   - handoff/<workspace_id>/<task_id>-handoff.md  (developer-owned handoff)
      expect(content).toContain(
        ".pi/orchestrator/task-{{task_id}}-report.md",
      );
      expect(content).toContain(
        ".pi/orchestrator/handoff/{{workspace_id}}/{{task_id}}-handoff.md",
      );
    });

    it("loads subagent-merger.md with merge-specific task data", () => {
      const content = loadPromptTemplate("subagent-merger");
      expect(content).not.toBeNull();
      for (const field of [
        "task_id",
        "task_title",
        "branch_a",
        "branch_b",
        "base_ref",
        "sc_list",
        "escalation_path",
        "worktree_path_a",
        "worktree_path_b",
      ]) {
        expect(content).toContain(`{{${field}}}`);
      }
      expect(content).toContain("## Verification on Merge Result");
      expect(content).toContain("## Reporting");
      expect(content).toContain(
        ".pi/orchestrator/audit-merge-{{task_id}}.md",
      );
    });

    it("loads subagent-auditor.md (renamed from subagent-software-auditor in GC-2026-014)", () => {
      const content = loadPromptTemplate("subagent-auditor");
      expect(content).not.toBeNull();
      expect(content).toContain("{{task_id}}");
      expect(content).toContain("{{depth}}");
      expect(content).toContain("{{task_report_path}}");
    });

    it("does NOT load the legacy subagent-software-auditor key (renamed in GC-2026-014)", () => {
      // The Phase B template file was renamed via `git mv`; the legacy
      // key now misses the schema and returns null.
      const content = loadPromptTemplate("subagent-software-auditor");
      expect(content).toBeNull();
    });

    it("loads subagent-explore.md", () => {
      const content = loadPromptTemplate("subagent-explore");
      expect(content).not.toBeNull();
      expect(content).toContain("READ-ONLY");
      expect(content).toContain("{{task_id}}");
    });

    it("does NOT load subagent-general-purpose.md (removed in Phase C)", () => {
      // DAG-2026-011 Phase C: the `general-purpose` agent was removed;
      // its prompt template was deleted along with it.
      const content = loadPromptTemplate("subagent-general-purpose");
      expect(content).toBeNull();
    });

    it("returns null for unknown template", () => {
      const content = loadPromptTemplate("nonexistent-template-xxx");
      expect(content).toBeNull();
    });

    /**
     * Skill prompt templates must NOT duplicate content that already lives
     * in the agent definition (templates/agents/software-*.md). Identity
     * content — TDD discipline, Spawn Mode, First Action Protocol, Output
     * Contract, Sub-Agent Boundaries — is loaded by pi-subagents as the
     * subagent's identity body; re-stating it in the task prompt wastes
     * context and risks drift (the 2026-07-24 commit-conventions work
     * already exposed drift between the two layers).
     */
    it("skill prompts do NOT duplicate agent identity content", () => {
      // Render each prompt with minimal params, then assert the rendered
      // body has no identity-section headings (those belong in the agent
      // definition loaded by pi-subagents, not the task prompt).
      const identitySections = [
        /^##\s+.*Spawn Mode/im,
        /^##\s+.*First Action Protocol/im,
        /^##\s+.*Output Contract/im,
        /^##\s+.*Sub-Agent Boundaries/im,
        /^##\s+.*TDD Discipline/im,
        /^###\s+RED/im,
        /^###\s+GREEN/im,
        /^###\s+REFACTOR/im,
      ];
      const renderWith = (name: string): string => {
        const params: Record<string, unknown> = {
          task_id: "P1",
          task_title: "Test task",
          sc_list: "- SC1: x",
          upstream_outputs: "(none)",
          files_to_touch: "src/foo.ts",
          acceptance_cmd: "echo ok",
        };
        if (name === "subagent-auditor") {
          params.depth = "full";
          params.task_report_path = ".pi/orchestrator/task-P1-report.md";
          params.isolation = "none";
        }
        return renderTaskPrompt(name, params) ?? "";
      };
      const templateNames = [
        "subagent-developer",
        "subagent-auditor",
        "subagent-explore",
      ];
      for (const name of templateNames) {
        const rendered = renderWith(name);
        expect(rendered.length).toBeGreaterThan(0);
        for (const re of identitySections) {
          expect(rendered).not.toMatch(re);
        }
      }
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

    it("returns null for response templates (removed in v2 — patterns inlined in SKILL.md)", () => {
      // Response templates were removed: prompts/ are the only file-based templates now.
      // LLM composes response patterns inline from SKILL.md §6.4.
      const content = loadResponseTemplate("goal-intake");
      expect(content).toBeNull();
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

    it("handles {{#each items}}...{{/each}} for string arrays", () => {
      const tpl = "Reports:\n{{#each reports}}- {{this}}\n{{/each}}";
      const out = renderTemplate(tpl, {
        reports: [".pi/r1.md", ".pi/r2.md", ".pi/r3.md"],
      });
      expect(out).toBe("Reports:\n- .pi/r1.md\n- .pi/r2.md\n- .pi/r3.md\n");
    });

    it("{{#each}} with no value renders empty", () => {
      const tpl = "X{{#each missing}}Y{{/each}}Z";
      expect(renderTemplate(tpl, {})).toBe("XZ");
    });

    it("{{#each}} handles mixed conditionals inside (verifies render order)", () => {
      const tpl = "{{#if items}}count={{#each items}}{{this}} {{/each}}{{/if}}";
      expect(renderTemplate(tpl, { items: ["a", "b"] })).toBe("count=a b ");
    });
  });

  describe("renderTaskPrompt", () => {
    it("renders a developer task prompt with params", () => {
      const out = renderTaskPrompt("subagent-developer", {
        task_id: "P4",
        task_title: "Implement UserRepository",
        sc_list: "- SC1: typecheck passes\n- SC2: tests pass",
        upstream_outputs: "(none)",
        files_to_touch: "src/auth/repository/UserRepository.ts",
        acceptance_cmd: "npm test",
      });
      expect(out).not.toBeNull();
      // Task-specific content rendered correctly
      expect(out).toContain("**ID**: P4");
      expect(out).toContain("Implement UserRepository");
      expect(out).toContain("- SC1: typecheck passes");
      expect(out).toContain("src/auth/repository/UserRepository.ts");
      expect(out).toContain("npm test");
    });

    it("renders auditor prompt with audit-specific data", () => {
      const out = renderTaskPrompt("subagent-auditor", {
        task_id: "P7",
        task_title: "Audit refactor",
        sc_list: "- SC1: refactor complete",
        depth: "full",
        task_report_path: ".pi/orchestrator/task-P7-report.md",
        isolation: "none",
      });
      expect(out).not.toBeNull();
      expect(out).toContain("**ID**: P7");
      expect(out).toContain("**Depth**: full");
      expect(out).toContain("**Audited Isolation**: none");
      expect(out).toContain("task-P7-report.md");
    });

    it("returns null for unknown template name", () => {
      const out = renderTaskPrompt("nonexistent-template", {});
      expect(out).toBeNull();
    });
  });

  describe("listTemplates", () => {
    it("returns the 4 known prompt templates (general-purpose removed in Phase C)", () => {
      const names = listTemplates("prompts");
      expect(names).toContain("subagent-developer");
      expect(names).toContain("subagent-auditor");
      expect(names).toContain("subagent-explore");
      expect(names).toContain("subagent-merger");
      // general-purpose was removed in DAG-2026-011 Phase C — its
      // template file is gone, the schema entry is gone. The subagent
      // itself is no longer in `pi-subagents/src/default-agents.ts`.
      expect(names).not.toContain("subagent-general-purpose");
      // The Phase A / Phase B aliases were removed in GC-2026-014.
      expect(names).not.toContain("subagent-software-developer");
      expect(names).not.toContain("subagent-software-auditor");
      expect(names.length).toBe(4);
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

    it("returns empty for responses (templates/responses/ removed in v2)", () => {
      // v2: response patterns are inlined in SKILL.md §6.4
      // listTemplates still works for prompts/goals/dag, just not responses
      const names = listTemplates("responses");
      expect(names).toEqual([]);
    });
  });
});