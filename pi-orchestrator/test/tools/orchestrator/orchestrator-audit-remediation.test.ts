import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { executeOrchestratorAudit } from "@/orchestrator-audit.js";
import type { OrchestrationPlan, TaskNode } from "@/types.js";

const task: TaskNode = {
  id: "P1", description: "task P1", plane: "Business", priority: "high", depends_on: [], files: [], subagent_type: "developer",
  batch: 1, isolation: "current-workspace", tdd: "strict", prompt: "implement with regression tests", output_schema: { kind: "code_changes" },
  acceptance: { covers: ["SC1"] }, status: "completed", retry_count: 0, max_retries: 2,
};
const plan: OrchestrationPlan = {
  id: "DAG-test", goal_id: "GC-test", title: "test", tasks: [task], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), state: "completed", prompts: {},
};
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sages-audit-identity-"));
  mkdirSync(join(cwd, ".pi/orchestrator"), { recursive: true });
  writeFileSync(join(cwd, ".pi/orchestrator/dag-DAG-test.yaml"), yaml.dump(plan), "utf8");
  writeFileSync(join(cwd, ".pi/orchestrator/audit-P1.md"), "# Audit\n\n## Final Verdict\n\n**CERTIFIED**\n", "utf8");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const parse = (r: any) => JSON.parse(r.content[0].text);

describe("orchestrator audit identity and verdict policy", () => {
  it("binds persisted state to workflow scope and depth and rejects cross-scope reuse", async () => {
    const init = parse(await executeOrchestratorAudit({ dag_id: "DAG-test", depth: "full" }, { cwd }));
    expect(init.audit_identity).toEqual({ dag_id: "DAG-test", scope: "workflow", scope_key: "workflow", depth: "full" });
    const crossScope = parse(await executeOrchestratorAudit({
      dag_id: "DAG-test", task_id: "P1", depth: "full",
      observation: { finding: { category: "ink", severity: "minor", issue: "scope confusion" } },
    }, { cwd }));
    expect(crossScope.status).toBe("error");
    expect(crossScope.validation.errors.join(" ")).toMatch(/scope/i);
    const crossDepth = parse(await executeOrchestratorAudit({
      dag_id: "DAG-test", depth: "fast",
      observation: { finding: { category: "ink", severity: "minor", issue: "depth confusion" } },
    }, { cwd }));
    expect(crossDepth.status).toBe("error");
    expect(crossDepth.validation.errors.join(" ")).toMatch(/depth/i);
  });

  it("allows a certified clean audit with no findings to PASS", async () => {
    await executeOrchestratorAudit({ dag_id: "DAG-test", depth: "fast" }, { cwd });
    const result = parse(await executeOrchestratorAudit({
      dag_id: "DAG-test", depth: "fast", observation: { complete: { verdict: "PASS", score: 100, summary: "clean" } },
    }, { cwd }));
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  it("a critical finding blocks PASS with REJECT", async () => {
    await executeOrchestratorAudit({ dag_id: "DAG-test" }, { cwd });
    const result = parse(await executeOrchestratorAudit({
      dag_id: "DAG-test", observation: {
        findings: [{ category: "foot", severity: "critical", issue: "verification fails" }],
        complete: { verdict: "PASS", score: 100, summary: "claimed pass" },
      },
    }, { cwd }));
    expect(result.verdict).toBe("REJECT");
  });

  it("a major finding forces at least REVISE", async () => {
    await executeOrchestratorAudit({ dag_id: "DAG-test" }, { cwd });
    const result = parse(await executeOrchestratorAudit({
      dag_id: "DAG-test", observation: {
        findings: [{ category: "nose", severity: "major", issue: "coverage gap" }],
        complete: { verdict: "PASS", score: 100, summary: "claimed pass" },
      },
    }, { cwd }));
    expect(result.verdict).toBe("REVISE");
  });
});
