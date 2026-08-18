import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ROOT = dirname(__dirname); // pi/test → pi/
const REGISTRY_PATH = join(PI_ROOT, "subagents/registry.yaml");
const CATALOG_PATH = join(PI_ROOT, "catalogs/subagent.json");

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

describe("registry.yaml ↔ subagent.json cross-consistency (GC-2026-048 T2.2)", () => {
  // The catalog is a snapshot of the registry. Whenever the registry
  // changes, `bun run gen:catalog` must be re-run; whenever the catalog
  // is hand-edited, the diff must be reverted. These tests pin the
  // invariant and protect against accidental drift in either direction.

  function readCatalogEntries(): Array<{ id: string; run_in_background_default: boolean }> {
    const raw = readFileSync(CATALOG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) {
      throw new Error("subagent.json: 'entries' is not an array");
    }
    return parsed.entries.map((candidate) => {
      if (typeof candidate !== "object" || candidate === null) {
        throw new Error("subagent.json: entry is not an object");
      }
      const entry = candidate as { id?: unknown; run_in_background_default?: unknown };
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        throw new Error("subagent.json: missing 'id' on entry");
      }
      if (typeof entry.run_in_background_default !== "boolean") {
        throw new Error(`subagent.json: entry '${entry.id}' missing run_in_background_default`);
      }
      return { id: entry.id, run_in_background_default: entry.run_in_background_default };
    });
  }

  it("registry.yaml and subagent.json share the same set of ids", () => {
    const registryIds = [...knownSubagentIds()].sort();
    const catalogIds = readCatalogEntries().map((e) => e.id).sort();
    expect(catalogIds).toEqual(registryIds);
  });

  it("registry.yaml and subagent.json agree on run_in_background for every shared id", () => {
    const registryEntries = new Map(loadRegistry().subagents.map((s) => [s.id, s.run_in_background]));
    const catalogEntries = new Map(
      readCatalogEntries().map((e) => [e.id, e.run_in_background_default]),
    );
    expect(catalogEntries.size).toBe(registryEntries.size);
    for (const [id, regVal] of registryEntries.entries()) {
      const catVal = catalogEntries.get(id);
      expect(catVal).toBe(regVal);
    }
  });

  it("verify:catalog exits 0 when run as a subprocess from pi/", async () => {
    // The script reads the on-disk registry.yaml + catalogs/subagent.json
    // and confirms both the per-file hash chain and the cross-consistency
    // invariant. We invoke it via subprocess so the test exercises the
    // same code path the pre-commit hook does.
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn("bun", ["run", "verify:catalog"], {
          cwd: PI_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      },
    );
    if (result.code !== 0) {
      // Surface diagnostics on failure for fast triage.
      console.error("verify:catalog stdout:", result.stdout);
      console.error("verify:catalog stderr:", result.stderr);
    }
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/OK: \d+ catalogues current/);
    expect(result.stdout).toMatch(/registry\.yaml ↔ subagent\.json consistent/);
  });
});
