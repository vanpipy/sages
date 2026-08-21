/**
 * GC-2026-062 regression — built-in profile resolution from any cwd.
 *
 * Bug: `pi` crashed at extension load when launched from outside the
 * repo root (`ENOENT .../pi/profiles/standard.yaml`). Root cause:
 * `pi/src/profile.ts` resolved built-in profile YAMLs against a
 * cwd-relative constant (`BUILTIN_PROFILE_DIR = "pi/profiles"`), so
 * from e.g. `$HOME` the loader looked for `$HOME/pi/profiles/...`.
 *
 * Fix contract: built-in profile lookup must resolve module-relative
 * (package root), with the legacy cwd-relative candidates as
 * fallbacks. These tests chdir into a throwaway temp dir — a cwd with
 * no `pi/profiles` sibling — and assert the built-ins still load.
 *
 * This file MUST have failed before the fix (cwd-relative resolution
 * → ENOENT) and passes after.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProfileCache, loadBuiltInProfile, loadProfile } from "@/profile.js";

describe("profile loading from a non-repo cwd (GC-2026-062 regression)", () => {
  const originalCwd = process.cwd();
  let tmpCwd: string;

  beforeAll(() => {
    // A cwd with no `pi/` sibling — the exact environment that crashed
    // at extension load (`ENOENT .../pi/profiles/standard.yaml`).
    tmpCwd = mkdtempSync(join(tmpdir(), "profile-cwd-regression-"));
    process.chdir(tmpCwd);
    clearProfileCache();
  });

  afterAll(() => {
    process.chdir(originalCwd);
    clearProfileCache();
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it("loadProfile() resolves the standard built-in from any cwd", () => {
    const p = loadProfile();
    expect(p.id).toBe("standard");
  });

  it("loadBuiltInProfile('light') resolves from any cwd", () => {
    expect(loadBuiltInProfile("light").id).toBe("light");
  });
});
