import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateDAG } from "../src/tools/orchestrator/dag-synthesizer.js";
import {
  clearRegistryCache,
  knownSubagentIds,
  loadRegistry,
  lookupSubagent,
} from "../src/tools/orchestrator/subagent-registry.js";
import { defaultRunInBackground } from "../src/tools/orchestrator/task-dispatcher.js";
import type { GoalContract } from "../src/tools/orchestrator/types.js";

const EXPECTED_IDS = ["Explore", "Plan", "developer", "auditor", "merger", "git-expert"];
const temporaryDirectories: string[] = [];

function useTemporaryRegistry(contents: string): void {
  const directory = mkdtempSync(join(tmpdir(), "subagent-registry-"));
  const path = join(directory, "registry.yaml");
  writeFileSync(path, contents, "utf-8");
  temporaryDirectories.push(directory);
  process.env.SUBAGENT_REGISTRY_PATH = path;
  clearRegistryCache();
}

function registryWith(overrides: string): string {
  return `subagents:
  - id: developer
    kind: write-isolated
    isolation: [worktree]
    run_in_background: true
    gather: false
    artifact_schema: [status]
${overrides}`;
}

const contract: GoalContract = {
  id: "GC-registry-test",
  title: "Registry probe",
  rationale: "Verify synthesizer registry integration",
  success_criteria: [{ id: "SC1", criterion: "role is accepted", verification_cmd: "true" }],
  anti_goals: [],
  scope: { include: [], exclude: [] },
  constraints: {},
  done_definition: "role is accepted",
  created_at: "2026-08-18T00:00:00Z",
};

function probeSubagent(subagentType: string) {
  return validateDAG(
    {
      goal_id: contract.id,
      tasks: [
        {
          id: "P1",
          description: "probe registered role",
          plane: "Foundation",
          priority: "medium",
          depends_on: [],
          files: [],
          subagent_type: subagentType,
          batch: 1,
          isolation: "none",
          tdd: "none",
          prompt: "Probe the synthesizer's registered subagent roles.",
          output_schema: { kind: "verdict" },
          acceptance: { covers: ["SC1"] },
        },
      ],
    },
    contract,
  );
}

beforeEach(() => {
  delete process.env.SUBAGENT_REGISTRY_PATH;
  clearRegistryCache();
});

afterEach(() => {
  delete process.env.SUBAGENT_REGISTRY_PATH;
  clearRegistryCache();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("subagent registry", () => {
  it("loads all six subagents", () => {
    expect(loadRegistry().subagents).toHaveLength(6);
  });

  it("populates every required field for each subagent", () => {
    for (const entry of loadRegistry().subagents) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.kind.length).toBeGreaterThan(0);
      expect(entry.isolation.length).toBeGreaterThan(0);
      expect(typeof entry.run_in_background).toBe("boolean");
      expect(typeof entry.gather).toBe("boolean");
      expect(entry.artifact_schema.length).toBeGreaterThan(0);
    }
  });

  it("contains exactly the canonical six ids", () => {
    expect(loadRegistry().subagents.map((entry) => entry.id).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("looks up the developer entry", () => {
    expect(lookupSubagent("developer")).toMatchObject({
      id: "developer",
      kind: "write-isolated",
      run_in_background: true,
    });
  });

  it("returns undefined for an unknown subagent", () => {
    expect(lookupSubagent("nonexistent")).toBeUndefined();
  });

  it("returns all six ids as a Set", () => {
    const ids = knownSubagentIds();
    expect(ids instanceof Set).toBe(true);
    expect(ids.size).toBe(6);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("uses the registry's foreground default for Explore", () => {
    expect(defaultRunInBackground("Explore")).toBe(false);
  });

  it("uses the registry's background default for developer", () => {
    expect(defaultRunInBackground("developer")).toBe(true);
  });

  it("lets the synthesizer recognize every registered subagent", () => {
    for (const id of EXPECTED_IDS) {
      const result = probeSubagent(id);
      expect(result.warnings.some((warning) => warning.includes("not a known role"))).toBe(false);
    }
  });

  it("rejects a registry entry with a missing required field", () => {
    useTemporaryRegistry(`subagents:
  - id: developer
    kind: write-isolated
    isolation: [worktree]
    gather: false
    artifact_schema: [status]
`);

    expect(() => loadRegistry()).toThrow(/run_in_background/);
  });

  it("rejects a registry entry with an invalid kind", () => {
    useTemporaryRegistry(registryWith("").replace("kind: write-isolated", "kind: unsupported"));

    expect(() => loadRegistry()).toThrow(/kind/);
  });

  it("rejects duplicate subagent ids", () => {
    useTemporaryRegistry(registryWith(`  - id: developer
    kind: write-isolated
    isolation: [worktree]
    run_in_background: true
    gather: false
    artifact_schema: [status]
`));

    expect(() => loadRegistry()).toThrow(/duplicate.*developer/i);
  });
});
