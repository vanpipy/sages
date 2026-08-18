#!/usr/bin/env bun
/**
 * gen-gcdb.ts — GC-2026-051 T5.1
 *
 * Generate `pi/docs/gc-index.md` from `git log --grep='GC-2026'`.
 *
 * Walks every commit whose subject contains a `GC-YYYY-NNN` token
 * (GC-2026-* today; the regex is year-agnostic so post-2027 GCs work
 * without a code change) and emits a markdown table with one row per
 * unique GC id, sorted ascending:
 *
 *   | ID         | Title (one line)                       | Goal contract path  |
 *   |------------|----------------------------------------|---------------------|
 *   | GC-2026-029| meta-allowlist contraction              | .pi/orchestrator/...|
 *   | ...        | ...                                    | ...                 |
 *
 * Title extraction strips:
 *   - the leading Conventional Commits type prefix (`feat:`,
 *     `feat(scope):`, `fix:`, `chore:`, `docs:`, `refactor:`,
 *     `test:`, `perf:`, `merge:`, `merge(scope):`, `wip:`, `wip(scope):`,
 *     and the rare `merge(GC-...):` / `merge(scope):` shapes);
 *   - the trailing GC id suffix `(GC-2026-NNN)` or
 *     `(GC-2026-NNN, Tn.m)` / `(GC-2026-NNN, Tn)`;
 *   - the trailing dash separator `- GC-2026-NNN` or
 *     `— GC-2026-NNN` (em-dash);
 *   - the surrounding `(...)` when the entire body is one parenthetical.
 *
 * If extraction yields empty, the full subject is used as the title.
 *
 * The relative path in the table cells assumes the reader views the
 * file from `pi/docs/gc-index.md`, so `../../.pi/orchestrator/...`
 * resolves to the goal contract YAML.
 *
 * Usage:
 *   bun scripts/gen-gcdb.ts                 (writes pi/docs/gc-index.md)
 *   bun scripts/gen-gcdb.ts --stdout        (prints to stdout, no write)
 *   bun scripts/gen-gcdb.ts --check         (exits 1 if file would change)
 *
 * No external dependencies beyond Node's `child_process` and `Bun.write`.
 */

import { execSync } from "node:child_process";

interface GcRow {
  id: string;
  title: string;
  sha: string;
}

const GC_ID_REGEX = /GC-\d{4}-\d{3,}/;
// Matches Conventional Commits prefixes of these shapes (case-insensitive):
//   `feat:` / `feat(scope):` / `feat!:`
//   `fix:` / `fix(scope):` / `fix!:`
//   `chore:` / `docs:` / `refactor:` / `test:` / `perf:` / `style:` / `build:` / `ci:`
//   `wip:` / `wip(scope):`
//   `merge:` / `merge(scope):` / `merge(scope)!:`
// Also matches the merge-id-prefix shapes that integration merges use:
//   `merge(GC-YYYY-NNN): <desc>` / `merge(GC-YYYY-NNN) <desc>`
//   `merge <GC-YYYY-NNN>: <desc>` / `merge <GC-YYYY-NNN> <desc>` (no parens)
//   `merge(scope) GC-YYYY-NNN <desc>`
const CC_PREFIX_REGEX =
  /^(?:merge\(\s*GC-\d{4}-\d{3,}\s*\)\s*:?|merge\(\s*GC-\d{4}-\d{3,}\s*\)|merge\(\s*[^)]+\s*\)\s*:\s*GC-\d{4}-\d{3,}\s+|merge\(\s*[^)]+\s*\)\s+GC-\d{4}-\d{3,}\s*|merge\(\s*[^)]+\s*\)\s*:?|merge\s+GC-\d{4}-\d{3,}\s*[:\-—]\s*|merge\s+GC-\d{4}-\d{3,}\s+|merge\s*:\s*|feat\(\s*[^)]+\s*\)\s*:?|feat\s*:\s*|fix\(\s*[^)]+\s*\)\s*:?|fix\s*:\s*|chore\(\s*[^)]+\s*\)\s*:?|chore\s*:\s*|docs\(\s*[^)]+\s*\)\s*:?|docs\s*:\s*|refactor\(\s*[^)]+\s*\)\s*:?|refactor\s*:\s*|test\(\s*[^)]+\s*\)\s*:?|test\s*:\s*|perf\(\s*[^)]+\s*\)\s*:?|perf\s*:\s*|style\(\s*[^)]+\s*\)\s*:?|style\s*:\s*|build\(\s*[^)]+\s*\)\s*:?|build\s*:\s*|ci\(\s*[^)]+\s*\)\s*:?|ci\s*:\s*|wip\(\s*[^)]+\s*\)\s*:?|wip\s*:\s*)/i;

function extractTitle(subject: string): string {
  let s = subject.trim();

  // Strip Conventional Commits prefixes; some commits nest a `merge GC-...`
  // body after a `docs(...):` or `feat(...):` outer prefix, so loop the
  // strip until the regex stops matching.
  let safety = 0;
  while (safety++ < 5) {
    const stripped = s.replace(CC_PREFIX_REGEX, "").trim();
    if (stripped === s || stripped.length === 0) break;
    s = stripped;
  }

  // Some old subjects start with the GC ID itself, e.g.
  // `GC-2026-003 T1: Fix F4 bash-guard bypasses`.
  s = s.replace(/^GC-\d{4}-\d{3,}\s+/, "").trim();

  // Strip trailing `(GC-YYYY-NNN[, Tn.m])` or `(Pn of GC-YYYY-NNN)`.
  s = s.replace(
    /\s*\(\s*(?:[PT]\d+(?:\s+of\s+)?)?GC-\d{4}-\d{3,}(?:\s*[,—\-]\s*[A-Za-z0-9._-]+)?\s*\)\s*$/,
    "",
  ).trim();

  // Strip trailing ` — Refs: GC-YYYY-NNN-...` and similar dash suffixes.
  s = s.replace(/\s*[-—]\s*(?:Refs?:|SC\s+for|Refs)\s*GC-\d{4}-\d{3,}[A-Za-z0-9._-]*\s*$/, "").trim();

  // Strip trailing ` - GC-YYYY-NNN` or ` — GC-YYYY-NNN` (bare dash before id).
  s = s.replace(/\s*[-—]\s*GC-\d{4}-\d{3,}(?:\s*,\s*[A-Za-z0-9._-]+)?\s*$/, "").trim();

  // Strip a single trailing parenthetical task marker if left over,
  // e.g. `(T1.1)`.
  s = s.replace(/\s*\(\s*T\d+(?:\.\d+)?\s*\)\s*$/, "").trim();

  return s.length > 0 ? s : subject.trim();
}

function rows(): GcRow[] {
  const raw = execSync(
    "git log --all --grep='GC-' --format='%H %s'",
    { encoding: "utf-8" },
  );
  const seen = new Map<string, GcRow>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx < 0) continue;
    const sha = line.slice(0, spaceIdx);
    const subject = line.slice(spaceIdx + 1);
    const m = subject.match(GC_ID_REGEX);
    if (!m) continue;
    const id = m[0];
    if (seen.has(id)) continue;
    const title = extractTitle(subject);
    seen.set(id, { id, title, sha });
  }
  return Array.from(seen.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function render(rows: GcRow[]): string {
  const today = new Date().toISOString().slice(0, 10);
  let md = `# GC Index\n\n`;
  md += `> **Maintained by:** \`bun run gen:gcdb\` (run from \`pi/\`).\n`;
  md += `> **Source:** \`git log --all --grep='GC-'\`\n`;
  md += `> **Last generated:** ${today}\n\n`;
  md += `| ID | Title | Goal contract |\n`;
  md += `| --- | --- | --- |\n`;
  for (const r of rows) {
    const path = `../../.pi/orchestrator/goal-${r.id}.yaml`;
    md += `| ${r.id} | ${escapePipe(r.title)} | [.pi/orchestrator/goal-${r.id}.yaml](${path}) |\n`;
  }
  md += `\n_Total: ${rows.length} GCs_\n`;
  return md;
}

const argv = process.argv.slice(2);
const stdoutOnly = argv.includes("--stdout");
const checkOnly = argv.includes("--check");

const rowsList = rows();
const out = render(rowsList);
const outPath = "docs/gc-index.md";

if (stdoutOnly) {
  process.stdout.write(out);
} else if (checkOnly) {
  const fs = await import("node:fs/promises");
  let current = "";
  try {
    current = await fs.readFile(outPath, "utf-8");
  } catch {
    process.stderr.write(`gen:gcdb: ${outPath} does not exist; would create (${rowsList.length} entries)\n`);
    process.exit(1);
  }
  if (current !== out) {
    process.stderr.write(`gen:gcdb: ${outPath} is stale (regen would change ${rowsList.length} entries)\n`);
    process.exit(1);
  }
  process.stderr.write(`gen:gcdb: ${outPath} is up to date (${rowsList.length} entries)\n`);
} else {
  await Bun.write(outPath, out);
  console.log(`gen:gcdb: wrote ${outPath} (${rowsList.length} entries)`);
}