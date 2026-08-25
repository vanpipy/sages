/**
 * cwd / env independence tests for the orchestrator template loader.
 *
 * GC-2026-062 regression pin: sages is a GLOBAL pi extension installed at
 * ~/.pi/packages/sages — every resource lookup must work from any cwd on
 * any machine. template-loader.ts previously baked in a machine-specific
 * absolute path (/home/leroy/...) and made resolution depend on
 * process.cwd(); this suite pins the module-relative fix.
 *
 * The test file lives at pi/test/tools/orchestrator/ — up 3 = pi/ = the
 * sages package root, which is exactly what the source module resolves
 * from pi/src/tools/orchestrator/.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSagesRoot,
  findTemplatesRoot,
  loadPromptTemplate,
} from "@/template-loader.js";

/**
 * Module-relative package root, computed the same way the source module does:
 * test file lives at pi-orchestrator/test/tools/orchestrator/ → up 3 = pi-orchestrator/
 * (the orchestrator package root). Mirrors `join(dirname(fileURLToPath(import.meta.url)),
 * "..", "..", "..")` inside template-loader.ts.
 */
const EXPECTED_PACKAGE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const ORIG = {
  home: process.env.HOME,
  sagesPath: process.env.SAGES_PATH,
  sagesDev: process.env.SAGES_DEV,
  cwd: process.cwd(),
};

/** Simulate a foreign machine: throwaway HOME, no SAGES_PATH / SAGES_DEV. */
function simulateForeignMachine(): void {
  process.env.HOME = mkdtempSync(join(tmpdir(), "sages-fake-home-"));
  delete process.env.SAGES_PATH;
  delete process.env.SAGES_DEV;
}

describe("template-loader cwd/env independence (GC-2026-062)", () => {
  afterAll(() => {
    if (ORIG.home === undefined) delete process.env.HOME;
    else process.env.HOME = ORIG.home;
    if (ORIG.sagesPath === undefined) delete process.env.SAGES_PATH;
    else process.env.SAGES_PATH = ORIG.sagesPath;
    if (ORIG.sagesDev === undefined) delete process.env.SAGES_DEV;
    else process.env.SAGES_DEV = ORIG.sagesDev;
    process.chdir(ORIG.cwd);
  });

  it("findSagesRoot resolves module-relative on a foreign machine (never the hardcoded author path)", () => {
    simulateForeignMachine();

    const root = findSagesRoot();
    expect(root).not.toBeNull();
    // The machine-specific absolute path baked into the old SAGES_LOCATIONS
    // must never be returned — it leaks /home/leroy onto other machines.
    expect(root).not.toBe("/home/leroy/.pi/packages/pi-orchestrator");
    // The module knows its own location — that is the source of truth.
    expect(root).toBe(EXPECTED_PACKAGE_ROOT);
  });

  it("findTemplatesRoot + loadPromptTemplate work from an arbitrary cwd with no installed package", () => {
    simulateForeignMachine();
    const foreignCwd = mkdtempSync(join(tmpdir(), "sages-fake-cwd-"));
    process.chdir(foreignCwd);

    const templatesRoot = findTemplatesRoot();
    expect(templatesRoot).not.toBeNull();
    expect(
      existsSync(join(templatesRoot as string, "prompts", "subagent-developer.md")),
    ).toBe(true);
    expect(loadPromptTemplate("subagent-developer")).not.toBeNull();
  });
});
