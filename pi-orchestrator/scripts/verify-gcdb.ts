#!/usr/bin/env bun
/**
 * verify-gcdb.ts — GC-2026-051 T5.2
 *
 * Assert every Goal Contract in `.pi/orchestrator/goal-GC-*.yaml`
 * has institutional coverage.
 *
 * For each goal file:
 *   1. Read the `id` field (parsed via js-yaml).
 *   2. Check that `docs/postmortem/<id>.md` exists.
 *   3. If not, check that `docs/gc-index.md` has the id in a
 *      section titled "## Open / no postmortem" (the carve-out).
 *
 * Exit 0 if every GC is covered (postmortem or carve-out).
 * Exit 1 with the list of uncovered IDs otherwise.
 *
 * The script resolves its root relative to its own location, so it
 * works from any cwd as long as it lives at `pi/scripts/verify-gcdb.ts`.
 * Tests import the `uncovered()`, `goalIds()`, and `carveOutIds()`
 * helpers to drive the same logic against a temp directory.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PI_ROOT = resolve(__dirname, "..");

const GOAL_DIR = join(PI_ROOT, ".pi", "orchestrator");
const POSTMORTEM_DIR = join(PI_ROOT, "docs", "postmortem");
const GC_INDEX = join(PI_ROOT, "docs", "gc-index.md");

/**
 * Find every `goal-GC-*.yaml` file under `goalDir`, parse the `id`
 * field, and return a sorted array of unique ids.
 */
export function goalIds(goalDir: string = GOAL_DIR): string[] {
  if (!existsSync(goalDir)) return [];
  const files = readdirSync(goalDir).filter(
    (f) => f.startsWith("goal-GC-") && f.endsWith(".yaml"),
  );
  const ids = new Set<string>();
  for (const f of files) {
    const raw = readFileSync(join(goalDir, f), "utf-8");
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch {
      // Malformed YAML is not a coverage issue — skip silently so the
      // gate stays focused on institutional coverage. Syntax errors
      // belong to a different verify gate.
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const id = (parsed as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return Array.from(ids).sort();
}

/**
 * Read the carve-out section of `gc-index.md` and return the set of
 * GC ids listed under "## Open / no postmortem".
 *
 * The section body is captured until the next `## ` heading, the
 * next `# ` heading, or end-of-file.
 */
export function carveOutIds(gcIndexPath: string = GC_INDEX): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(gcIndexPath)) return ids;
  const raw = readFileSync(gcIndexPath, "utf-8");
  const m = raw.match(/## Open \/ no postmortem\s*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (!m) return ids;
  for (const hit of m[1].matchAll(/GC-\d{4}-\d{3,}/g)) {
    ids.add(hit[0]);
  }
  return ids;
}

/**
 * Return the list of goal IDs that are NOT covered by a postmortem
 * and NOT listed in the carve-out section. Empty list = full coverage.
 */
export function uncovered(
  goalDir: string = GOAL_DIR,
  postmortemDir: string = POSTMORTEM_DIR,
  gcIndexPath: string = GC_INDEX,
): string[] {
  const goals = goalIds(goalDir);
  const carve = carveOutIds(gcIndexPath);
  const out: string[] = [];
  for (const id of goals) {
    const postmortemPath = join(postmortemDir, `${id}.md`);
    if (existsSync(postmortemPath)) continue;
    if (carve.has(id)) continue;
    out.push(id);
  }
  return out;
}

function main(): void {
  const goals = goalIds();
  const missing = uncovered();
  if (missing.length === 0) {
    if (goals.length === 0) {
      console.log(
        `verify:gcdb: OK — no goal contracts in .pi/orchestrator/; coverage trivially satisfied`,
      );
    } else {
      console.log(
        `verify:gcdb: OK — ${goals.length} GC(s) all covered (postmortem or carve-out)`,
      );
    }
    process.exit(0);
  }
  console.error(`verify:gcdb: FAIL — ${missing.length} uncovered GC(s):`);
  for (const id of missing) console.error(`  ${id}`);
  process.exit(1);
}

// Only run main() when this file is the script entrypoint. This
// allows the helpers to be imported by tests (`uncovered`,
// `goalIds`, `carveOutIds`) without spawning a subprocess and
// without `process.exit(0)` terminating the test runner.
const ENTRY = process.argv[1] ?? "";
if (ENTRY.endsWith("verify-gcdb.ts") || ENTRY.endsWith("verify-gcdb.js")) {
  main();
}
