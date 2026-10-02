/**
 * Tests for orchestrator template loader.
 * RED phase: tests should fail until template-loader.ts is implemented.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      // GC-2026-072: the previous `expect(root).toContain("sages")` was
      // path-fragile — any install layout whose path does not literally
      // contain the substring "sages" (e.g. /tmp/merge-<gc>/...) would
      // fail. Verify the actual invariant instead: the path is the
      // directory of a `@sages/*` package (the orchestrator package itself
      // counts when tests run inside it). PACKAGE_ROOT = `dirname(...)` of
      // template-loader.js, so when the orchestrator tests run the returned
      // root is the pi-orchestrator package, whose name starts with `@sages/`.
      const pkg = JSON.parse(
        readFileSync(join(root as string, "package.json"), "utf-8"),
      );
      expect(pkg.name).toMatch(/^@sages\//);
    });

    it("the returned path contains a package.json", () => {
      // Sanity check via findTemplatesRoot which depends on it
      expect(findTemplatesRoot()).not.toBeNull();
    });
  });

  describe("loadPromptTemplate", () => {
    // GC-2026-path-B-swap: subagent-developer.md is preserved as a
    // path-A-compat reference. The canonical Developer prompt now lives
    // in pi-subagents/src/agent-prompts/developer.ts (with the new
    // Fix Phase Behavior section); the task description is rendered
    // inline by pi-tasks/src/phase-prompts.ts. This template now
    // documents its own obsolescence rather than carrying task params.
    it("loads subagent-developer.md (preserved as path-A-compat reference)", () => {
      const content = loadPromptTemplate("subagent-developer");
      expect(content).not.toBeNull();
      expect(content).toContain("GC-2026-path-B-swap");
      expect(content).toContain("phase-prompts.ts");
      expect(content).toContain("Fix Phase Behavior");
    });

    // GC-2026-path-B-swap: subagent-merger.md is preserved as a
    // path-A-compat reference. The canonical Merger prompt now lives
    // in pi-subagents/src/agent-prompts/merger.ts; the cross-workspace
    // merge protocol is rendered inline. This template now documents
    // its own obsolescence rather than carrying merge-specific params.
    it("loads subagent-merger.md (preserved as path-A-compat reference)", () => {
      const content = loadPromptTemplate("subagent-merger");
      expect(content).not.toBeNull();
      expect(content).toContain("GC-2026-path-B-swap");
      expect(content).toContain("phase-prompts.ts");
      expect(content).toContain("mergePrompt");
    });

    it("returns null for the deleted subagent-auditor template", () => {
      // GC-2026-rename-auditor: prompt rewritten to multi-dimensional
      // review (correctness / completeness / scope / anti-goal /
      // documentation). The Reviewer canonical prompt now lives in
      // pi-subagents/src/agent-prompts/reviewer.ts; the template-loader
      // entry was deleted.
      const content = loadPromptTemplate("subagent-auditor");
      expect(content).toBeNull();
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
        "subagent-explore",
        "subagent-merger",
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

    // GC-2026-path-B-swap: the dag/ directory was deleted — path B uses
    // workflow_run (no DAG template). listTemplates("dag") now returns
    // []; the per-file load tests are removed.
    it.skip("loads dag-tdd-refactor.yaml (removed by GC-2026-path-B-swap)", () => {});
    it.skip("loads dag-bug-fix.yaml (removed by GC-2026-path-B-swap)", () => {});

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
    // GC-2026-path-B-swap: renderTaskPrompt is the path A mechanism.
    // Path B builds the task prompt inline in
    // `pi-tasks/src/phase-prompts.ts` and passes it as the task
    // description. The two renderTaskPrompt cases below are kept as
    // smoke tests for the template-loader machinery; new code should
    // not depend on them.
    it("renders a developer task prompt with params (path A compat)", () => {
      // subagent-developer.md is now a path-A-compat reference doc.
      // renderTaskPrompt returns its content (no template vars) regardless
      // of params. Verify it loads and references the path B hand-off.
      const out = renderTaskPrompt("subagent-developer", {
        task_id: "P4",
        task_title: "Implement UserRepository",
        sc_list: "- SC1: typecheck passes\n- SC2: tests pass",
        upstream_outputs: "(none)",
        files_to_touch: "src/auth/repository/UserRepository.ts",
        acceptance_cmd: "npm test",
      });
      expect(out).not.toBeNull();
      expect(out).toContain("GC-2026-path-B-swap");
      expect(out).toContain("phase-prompts.ts");
    });

    // Auditor template was deleted (renamed to Reviewer). The
    // renderTaskPrompt call should return null now.
    it("returns null for the deleted subagent-auditor template", () => {
      const out = renderTaskPrompt("subagent-auditor", { task_id: "P7" });
      expect(out).toBeNull();
    });

    it("returns null for unknown template name", () => {
      const out = renderTaskPrompt("nonexistent-template", {});
      expect(out).toBeNull();
    });
  });

  describe("listTemplates", () => {
    // GC-2026-path-B-swap: subagent-auditor.md was deleted (renamed
    // to Reviewer; canonical prompt lives in
    // pi-subagents/src/agent-prompts/reviewer.ts). The remaining
    // 3 templates are path-A-shape but still loadable for legacy
    // template-loader callers.
    it("returns the 3 remaining path-A-compat prompt templates", () => {
      const names = listTemplates("prompts");
      expect(names).toContain("subagent-developer");
      expect(names).toContain("subagent-explore");
      expect(names).toContain("subagent-merger");
      expect(names).not.toContain("subagent-auditor");
      expect(names).not.toContain("subagent-general-purpose");
      expect(names).not.toContain("subagent-software-developer");
      expect(names).not.toContain("subagent-software-auditor");
      expect(names.length).toBe(3);
    });

    it("returns the 4 known goal templates", () => {
      const names = listTemplates("goals");
      expect(names).toContain("goal-refactor");
      expect(names).toContain("goal-new-feature");
      expect(names).toContain("goal-fix-bug");
      expect(names).toContain("goal-add-tests");
    });

    // GC-2026-path-B-swap: the dag/ directory was deleted. Path B uses
    // workflow_run, not a DAG template. listTemplates("dag") returns [].
    it("returns no dag templates (path B uses workflow_run, no DAG)", () => {
      const names = listTemplates("dag");
      expect(names).toEqual([]);
    });

    it("returns empty for responses (templates/responses/ removed in v2)", () => {
      // v2: response patterns are inlined in SKILL.md §6.4
      // listTemplates still works for prompts/goals/dag, just not responses
      const names = listTemplates("responses");
      expect(names).toEqual([]);
    });
  });
});