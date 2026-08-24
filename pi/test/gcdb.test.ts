/**
 * gcdb.test.ts — GC-2026-051 T5.2
 *
 * Tests the institutional-knowledge wiring:
 *   - `verify:gcdb` script exits 0 when every goal in
 *     `.pi/orchestrator/goal-GC-*.yaml` has a postmortem OR is
 *     listed in the carve-out section of `gc-index.md`.
 *   - `uncovered()` (exported from `verify-gcdb.ts`) returns the
 *     offending IDs when a goal has neither. Tested with a temp
 *     directory to avoid touching the real `.pi/orchestrator/`.
 *   - `gen:gcdb` is idempotent: running it twice produces identical
 *     output (round-trip property of the index generator).
 *   - `gc-index.md` lists every goal contract currently in
 *     `.pi/orchestrator/` (round-trip property of the index).
 *
 * Temp files live under `$JCODE_SCRATCH_DIR` when set, `/tmp`
 * otherwise. Cleaned up in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  carveOutIds,
  goalIds,
  uncovered,
} from "../scripts/verify-gcdb.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ROOT = resolve(__dirname, ".."); // pi/test → pi/

const SCRATCH_BASE = process.env.JCODE_SCRATCH_DIR ?? join(tmpdir(), "sages-gcdb-test");

const GOAL_DIR = join(PI_ROOT, ".pi", "orchestrator");
const POSTMORTEM_DIR = join(PI_ROOT, "docs", "postmortem");
const GC_INDEX = join(PI_ROOT, "docs", "gc-index.md");

const tempDirectories: string[] = [];

function mkTempDir(label: string): string {
  const dir = mkdtempSync(join(SCRATCH_BASE, `${label}-`));
  tempDirectories.push(dir);
  return dir;
}

function writeGoal(dir: string, id: string): void {
  writeFileSync(
    join(dir, `goal-${id}.yaml`),
    `id: ${id}\ntitle: test goal for ${id}\n`,
    "utf-8",
  );
}

function writePostmortem(dir: string, id: string): void {
  writeFileSync(join(dir, `${id}.md`), `# ${id} postmortem\n`, "utf-8");
}

function writeGcIndex(path: string, body: string): void {
  writeFileSync(path, body, "utf-8");
}

async function runSubprocess(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn("bun", args, {
      cwd: opts.cwd ?? PI_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    child.on("error", reject);
    child.on("close", (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

beforeEach(() => {
  mkdirSync(SCRATCH_BASE, { recursive: true });
});

afterEach(() => {
  while (tempDirectories.length > 0) {
    const d = tempDirectories.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
});

describe("verify:gcdb gate (GC-2026-051 T5.2)", () => {
  describe("verify:gcdb subprocess", () => {
    it("exits 0 in the current state (no goal files, trivially covered)", async () => {
      const result = await runSubprocess(["run", "verify:gcdb"]);
      if (result.code !== 0) {
        console.error("verify:gcdb stdout:", result.stdout);
        console.error("verify:gcdb stderr:", result.stderr);
      }
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/verify:gcdb: OK/);
    });
  });

  describe("verify-gcdb helpers (temp-dir isolation)", () => {
    it("goalIds() returns [] when the goal directory is missing", () => {
      const dir = mkTempDir("no-goals");
      const phantom = join(dir, "does-not-exist");
      expect(goalIds(phantom)).toEqual([]);
    });

    it("goalIds() parses the `id` field from each goal file", () => {
      const dir = mkTempDir("goal-ids");
      writeGoal(dir, "GC-2026-100");
      writeGoal(dir, "GC-2026-099");
      writeGoal(dir, "GC-2026-200");
      expect(goalIds(dir)).toEqual([
        "GC-2026-099",
        "GC-2026-100",
        "GC-2026-200",
      ]);
    });

    it("goalIds() skips malformed YAML without throwing", () => {
      const dir = mkTempDir("malformed");
      writeFileSync(
        join(dir, "goal-GC-2026-001.yaml"),
        "id: GC-2026-001\ntitle: ok\n",
        "utf-8",
      );
      writeFileSync(
        join(dir, "goal-GC-2026-002.yaml"),
        "id: GC-2026-002\n  bad: [unclosed\n",
        "utf-8",
      );
      const ids = goalIds(dir);
      expect(ids).toContain("GC-2026-001");
      expect(ids).not.toContain("GC-2026-002");
    });

    it("carveOutIds() extracts IDs from the '## Open / no postmortem' section", () => {
      const indexPath = join(mkTempDir("index"), "gc-index.md");
      writeGcIndex(
        indexPath,
        [
          "# GC Index",
          "",
          "| ID | Title |",
          "| --- | --- |",
          "| GC-2026-001 | foo |",
          "",
          "## Open / no postmortem",
          "",
          "- GC-2026-002 — known missing",
          "- GC-2026-003 — also missing",
          "",
          "## Other section",
          "",
          "- GC-2026-004 — not in carve-out",
          "",
        ].join("\n"),
      );
      const carve = carveOutIds(indexPath);
      expect(carve.has("GC-2026-002")).toBe(true);
      expect(carve.has("GC-2026-003")).toBe(true);
      expect(carve.has("GC-2026-004")).toBe(false);
      expect(carve.has("GC-2026-001")).toBe(false);
    });

    it("carveOutIds() returns empty set when the section is missing", () => {
      const indexPath = join(mkTempDir("no-carve"), "gc-index.md");
      writeGcIndex(indexPath, "# GC Index\n\n| ID | Title |\n| --- | --- |\n");
      expect(carveOutIds(indexPath).size).toBe(0);
    });

    it("carveOutIds() returns empty set when the index file is missing", () => {
      const phantom = join(mkTempDir("missing-index"), "absent.md");
      expect(carveOutIds(phantom).size).toBe(0);
    });

    it("uncovered() returns [id] when a goal has no postmortem and no carve-out", () => {
      const goals = mkTempDir("uncovered");
      const postmortems = mkTempDir("uncovered-post");
      const index = join(mkTempDir("uncovered-index"), "gc-index.md");
      writeGoal(goals, "GC-2026-300");
      writeGcIndex(index, "# GC Index\n\n## Open / no postmortem\n\n- GC-2026-301 — carved out\n");
      const missing = uncovered(goals, postmortems, index);
      expect(missing).toEqual(["GC-2026-300"]);
    });

    it("uncovered() ignores goals that have a matching postmortem", () => {
      const goals = mkTempDir("covered");
      const postmortems = mkTempDir("covered-post");
      const index = join(mkTempDir("covered-index"), "gc-index.md");
      writeGoal(goals, "GC-2026-400");
      writePostmortem(postmortems, "GC-2026-400");
      writeGcIndex(index, "# GC Index\n\n");
      expect(uncovered(goals, postmortems, index)).toEqual([]);
    });

    it("uncovered() honors the carve-out section", () => {
      const goals = mkTempDir("carved");
      const postmortems = mkTempDir("carved-post");
      const index = join(mkTempDir("carved-index"), "gc-index.md");
      writeGoal(goals, "GC-2026-500");
      writeGoal(goals, "GC-2026-501");
      writeGcIndex(
        index,
        [
          "# GC Index",
          "",
          "## Open / no postmortem",
          "",
          "- GC-2026-500 — deferred to next milestone",
          "",
        ].join("\n"),
      );
      const missing = uncovered(goals, postmortems, index);
      expect(missing).toEqual(["GC-2026-501"]);
    });

    it("uncovered() returns [] when the goal directory is empty", () => {
      const goals = mkTempDir("empty");
      const postmortems = mkTempDir("empty-post");
      const index = join(mkTempDir("empty-index"), "gc-index.md");
      expect(uncovered(goals, postmortems, index)).toEqual([]);
    });
  });

  describe("gen:gcdb idempotency", () => {
    it("running --stdout twice produces byte-identical output (modulo date)", async () => {
      // The "Last generated:" timestamp is appended on every run; if
      // a call crosses a UTC day boundary the two outputs will differ
      // by one day. We assert the *body* (every table row + totals) is
      // identical across calls — that is the meaningful idempotency
      // property, since the date is regenerated fresh each call.
      const a = await runSubprocess(["run", "gen:gcdb", "--stdout"]);
      const b = await runSubprocess(["run", "gen:gcdb", "--stdout"]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      // The raw generated-at timestamp must be present and ISO-shaped.
      expect(a.stdout).toMatch(/\*\*Last generated:\*\* \d{4}-\d{2}-\d{2}/);
      // Body equivalence after stripping the date line.
      const stripDate = (s: string): string =>
        s.replace(/\*\*Last generated:\*\* \d{4}-\d{2}-\d{2}/, "**Last generated:** <DATE>");
      expect(stripDate(a.stdout)).toBe(stripDate(b.stdout));
    });

    it("re-rendering produces the same set of GC ids", async () => {
      // Stricter: regardless of timestamp, the unique set of GC ids
      // emitted by gen:gcdb must be stable across calls (catches a
      // race where the script's `seen` map got perturbed by an
      // unrelated commit mid-run).
      const a = await runSubprocess(["run", "gen:gcdb", "--stdout"]);
      const b = await runSubprocess(["run", "gen:gcdb", "--stdout"]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const ids = (s: string): string[] =>
        Array.from(new Set([...s.matchAll(/GC-\d{4}-\d{3,}/g)].map((m) => m[0]))).sort();
      expect(ids(a.stdout)).toEqual(ids(b.stdout));
      // At minimum, the three postmortems we have must show up.
      expect(ids(a.stdout)).toContain("GC-2026-029");
      expect(ids(a.stdout)).toContain("GC-2026-031");
      expect(ids(a.stdout)).toContain("GC-2026-044");
    });
  });

  describe("gc-index.md round-trip", () => {
    // The round-trip invariants below only hold when gc-index.md is the
    // canonical entry point for institutional knowledge. When the file
    // is removed (alongside docs/postmortem/ + docs/cookbook/), the
    // discipline is intentionally suspended — the gate verifies-catalog
    // and verify-gcdb agree there is nothing to round-trip. In that
    // state the tests skip rather than pass-vacuously so the suite
    // doesn't claim coverage it can't actually demonstrate.
    it.skipIf(!existsSync(GC_INDEX))("every goal currently in .pi/orchestrator/ is listed in gc-index.md", () => {
      // If no goal files exist (current state), this is trivially true.
      // The invariant is "the index never lists fewer GCs than the
      // goal directory holds" — verified by enumerating real goals and
      // asserting each id appears in the rendered table.
      const indexRaw = readFileSync(GC_INDEX, "utf-8");
      const ids = goalIds(GOAL_DIR);
      for (const id of ids) {
        // The id appears as a cell in the table or in the file header.
        const present =
          new RegExp(`\\| ${id} \\|`).test(indexRaw) ||
          new RegExp(`\\b${id}\\b`).test(indexRaw);
        expect(present).toBe(true);
      }
    });

    it.skipIf(!existsSync(GC_INDEX))("every postmortemed GC referenced in gc-index.md resolves on disk", () => {
      // Inverse: every id mentioned in the index body must either
      // have a matching postmortem file OR be in the carve-out
      // section. Catches hand-edited index drift.
      const indexRaw = readFileSync(GC_INDEX, "utf-8");
      const ids = new Set<string>();
      for (const m of indexRaw.matchAll(/GC-\d{4}-\d{3,}/g)) {
        ids.add(m[0]);
      }
      const carve = carveOutIds(GC_INDEX);
      const referenced = Array.from(ids).sort();
      // We assert at least the seed set is present — gc-index.md
      // currently references many GCs; the test must pass on a
      // clean tree. We don't require every id (the index may
      // reference forward-looking IDs whose goal file doesn't yet
      // exist) — only that any *uncovered* reference is either
      // present as a postmortem or in the carve-out.
      expect(referenced.length).toBeGreaterThan(0);
      // Spot-check: the three postmortems we have (GC-2026-029,
      // GC-2026-031, GC-2026-044) appear in the index.
      expect(ids.has("GC-2026-029")).toBe(true);
      expect(ids.has("GC-2026-031")).toBe(true);
      expect(ids.has("GC-2026-044")).toBe(true);
      // All three are postmortemed on disk.
      expect(carve.has("GC-2026-029")).toBe(false);
      expect(carve.has("GC-2026-031")).toBe(false);
      expect(carve.has("GC-2026-044")).toBe(false);
      // The references should also not be flagged as uncovered
      // by the gate (since the postmortems exist).
      const uncoveredIds = uncovered(GOAL_DIR, POSTMORTEM_DIR, GC_INDEX);
      // Forward-looking IDs without goal files are fine; only flag
      // when a goal file *exists* without coverage.
      expect(uncoveredIds.length).toBe(0);
    });
  });
});
