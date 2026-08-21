/**
 * GC-2026-062 regression — subagent registry resolution from any cwd.
 *
 * Bug (latent): `pi/src/tools/orchestrator/subagent-registry.ts`
 * resolved the bundled `registry.yaml` with cwd-relative candidates
 * (`resolve("pi/subagents/registry.yaml")` else
 * `resolve("subagents/registry.yaml")`), so a dispatch from a non-repo
 * cwd would throw ENOENT at load time.
 *
 * Fix contract: `SUBAGENT_REGISTRY_PATH` env override first, then a
 * module-relative (package-root) path, then the legacy cwd-relative
 * candidates as fallbacks. These tests chdir into a throwaway temp
 * dir and assert the bundled registry still loads.
 *
 * This file MUST have failed before the fix (cwd-relative resolution
 * → ENOENT) and passes after.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRegistryCache, loadRegistry } from "../src/tools/orchestrator/subagent-registry.js";

describe("subagent registry loading from a non-repo cwd (GC-2026-062 regression)", () => {
  const originalCwd = process.cwd();
  let tmpCwd: string;

  beforeAll(() => {
    delete process.env.SUBAGENT_REGISTRY_PATH;
    tmpCwd = mkdtempSync(join(tmpdir(), "registry-cwd-regression-"));
    process.chdir(tmpCwd);
    clearRegistryCache();
  });

  afterAll(() => {
    process.chdir(originalCwd);
    delete process.env.SUBAGENT_REGISTRY_PATH;
    clearRegistryCache();
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("loadRegistry() resolves the bundled registry from any cwd", () => {
    const registry = loadRegistry();
    expect(registry.subagents).toHaveLength(6);
    expect(registry.subagents.map((entry) => entry.id)).toContain("developer");
  });
});
