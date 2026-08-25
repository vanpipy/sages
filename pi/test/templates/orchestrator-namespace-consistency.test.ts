import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
// Post-PR-2: orchestrator skill files live in the sibling pi-orchestrator
// package, not under pi/. Paths here use the conductor repo root (../../..)
// + the relative path within the new layout.
const requiredDocs = [
  "AGENTS.md",
  "README.md",
  "pi/README.md",
  "pi/templates/SYSTEM.md",
  "pi/templates/SUBAGENTS.md",
  "pi-orchestrator/skills/orchestrator/SKILL.md",
  "pi-orchestrator/skills/orchestrator/templates/prompts/subagent-developer.md",
  "pi-orchestrator/skills/orchestrator/templates/prompts/subagent-auditor.md",
  "pi-orchestrator/skills/orchestrator/templates/prompts/subagent-explore.md",
];

describe("orchestrator namespace documentation consistency", () => {
  it("removes the blanket subagent write prohibition", () => {
    for (const relative of requiredDocs) {
      const content = readFileSync(join(root, relative), "utf8");
      expect(content).not.toMatch(/subagents?.{0,40}(?:MUST NOT|must not|never).{0,40}write.{0,40}\.pi\/orchestrator/is);
    }
  });

  it("documents role-owned paths in operational docs", () => {
    for (const relative of ["AGENTS.md", "README.md", "pi/README.md", "pi/templates/SYSTEM.md", "pi/templates/SUBAGENTS.md", "pi-orchestrator/skills/orchestrator/SKILL.md"]) {
      const content = readFileSync(join(root, relative), "utf8");
      expect(content).toContain("task-{task_id}-report.md");
      expect(content).toContain("audit-{task_id}.md");
      expect(content).toContain("handoff/{workspace_id}/{task_id}-handoff.md");
      expect(content).toContain("goal-{id}.yaml");
      expect(content).toMatch(/cross-namespace|namespace ownership/i);
    }
  });

  it("keeps Explore and Plan read-only while developer and auditor prompts use only their namespaces", () => {
    const developer = readFileSync(join(root, "pi-orchestrator/skills/orchestrator/templates/prompts/subagent-developer.md"), "utf8");
    const auditor = readFileSync(join(root, "pi-orchestrator/skills/orchestrator/templates/prompts/subagent-auditor.md"), "utf8");
    const explore = readFileSync(join(root, "pi-orchestrator/skills/orchestrator/templates/prompts/subagent-explore.md"), "utf8");
    expect(developer).toContain(".pi/orchestrator/task-{{task_id}}-report.md");
    expect(developer).toContain(".pi/orchestrator/handoff/{{workspace_id}}/{{task_id}}-handoff.md");
    expect(auditor).toContain(".pi/orchestrator/audit-{{task_id}}.md");
    expect(explore).not.toMatch(/Write structured findings to `.pi\/orchestrator/);
    expect(explore).toMatch(/inline.*response/i);
  });
});
