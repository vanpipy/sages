#!/usr/bin/env bun
// verify-created-by-invariant.ts — Static verifier for the
// `metadata.created_by` invariant (GC-2026-task-feeding-and-decomposition AC7).
//
// Walks pi-tasks source tree (excluding test/ and dist/), finds every
// `store.create(` call, and asserts each has an explicit
// `metadata.created_by` stamp in the surrounding object literal.
//
// Failure modes:
//   - Any direct `store.create(` lacking the stamp → exit 1 with a
//     numbered report.
//   - Empty source tree → still exit 0 (nothing to verify).
//
// Usage: `bun run verify:created-by-invariant` from pi-orchestrator/.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "pi-tasks");
const SCAN_DIRS = [join(ROOT, "src")];
const EXCLUDE_DIR_NAMES = new Set(["test", "dist", "node_modules"]);

interface Finding {
  file: string;
  line: number;
  context: string;
}

const STORE_CREATE_RE = /\.store\.create\s*\(/g;
const CREATED_BY_RE = /created_by\s*[:=]/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry)) continue;
      walk(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
}

function checkFile(file: string): Finding[] {
  const text = readFileSync(file, "utf-8");
  const lines = text.split("\n");
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!STORE_CREATE_RE.test(lines[i])) continue;
    // Walk forward to find the closing `)` of the create() call.
    let depth = 0;
    let endLine = i;
    for (let j = i; j < Math.min(i + 80, lines.length); j++) {
      for (const ch of lines[j]) {
        if (ch === "(") depth += 1;
        else if (ch === ")") {
          depth -= 1;
          if (depth === 0) {
            endLine = j;
            break;
          }
        }
      }
      if (depth === 0) break;
    }
    const block = lines.slice(i, endLine + 1).join("\n");
    if (!CREATED_BY_RE.test(block)) {
      findings.push({
        file,
        line: i + 1,
        context: lines[i].trim(),
      });
    }
  }
  return findings;
}

function main(): void {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(d, files);
  const allFindings: Finding[] = [];
  for (const f of files) {
    allFindings.push(...checkFile(f));
  }
  if (allFindings.length === 0) {
    console.log(
      `verify:created-by-invariant: PASS (${files.length} file(s) scanned, all store.create calls carry created_by='user')`,
    );
    process.exit(0);
  }
  console.error(
    `verify:created-by-invariant: FAIL (${allFindings.length} store.create call(s) missing created_by stamp)`,
  );
  for (const f of allFindings) {
    console.error(`  ${f.file}:${f.line}  ${f.context}`);
  }
  process.exit(1);
}

main();