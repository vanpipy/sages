#!/usr/bin/env bun
// verify-task-source-invariant.ts — Static verifier for task source-model
// invariants (GC-2026-120 AC8).
//
// Walks pi-tasks source tree (excluding test/ and dist/) and asserts:
//   - Every `store.create(` call site in `materializeDecomposeChain`
//     stamps `user_task_ref` on the new task. This keeps
//     `traceUserTaskChain` sound: chain tasks must carry the
//     originating user task's id.
//
// The kind / agentType / requires_decomposition invariants are auto-
// satisfied by `inferKind` in `task-store.ts` (GC-2026-120 AC1). They
// don't need a separate static check — the inference layer is the
// single source of truth.
//
// Failure modes:
//   - Any chain-task create site in materializeDecomposeChain lacking
//     `user_task_ref` → exit 1 with a report.
//
// Usage: `bun run verify:task-source-invariant` from pi-orchestrator/.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "pi-tasks");
const SCAN_FILES = [join(ROOT, "src", "index.ts")]; // materializeDecomposeChain lives here
const EXCLUDE_DIR_NAMES = new Set(["test", "dist", "node_modules"]);

interface Finding {
  file: string;
  line: number;
  context: string;
  rule: "chain-task-needs-user-task-ref";
}

const STORE_CREATE_RE = /\.store\.create\s*\(/g;

function findChainTaskCreateSites(file: string): Finding[] {
  const text = readFileSync(file, "utf-8");
  const lines = text.split("\n");
  const findings: Finding[] = [];
  // Locate the materializeDecomposeChain function. Lines after it
  // until the matching closing brace belong to its body.
  let inFn = false;
  let braceDepth = 0;
  let fnStartLine = -1;
  let fnEndLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFn && line.includes("async function materializeDecomposeChain")) {
      inFn = true;
      fnStartLine = i;
      // Count braces from the function declaration line forward.
      for (const ch of line) {
        if (ch === "{") braceDepth += 1;
        else if (ch === "}") braceDepth -= 1;
      }
      continue;
    }
    if (inFn) {
      for (const ch of line) {
        if (ch === "{") braceDepth += 1;
        else if (ch === "}") braceDepth -= 1;
      }
      if (braceDepth === 0) {
        fnEndLine = i;
        break;
      }
    }
  }
  if (fnStartLine < 0 || fnEndLine < 0) {
    console.error(`verify-task-source-invariant: WARN materializeDecomposeChain not found in ${file}`);
    return [];
  }
  for (let i = fnStartLine; i <= fnEndLine; i++) {
    if (!STORE_CREATE_RE.test(lines[i])) continue;
    // Walk forward to find the call's closing paren.
    let depth = 0;
    let endLine = i;
    for (let j = i; j < Math.min(i + 80, fnEndLine + 1); j++) {
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
    // Chain task create site must carry user_task_ref.
    if (!block.includes("user_task_ref")) {
      findings.push({
        file,
        line: i + 1,
        context: lines[i].trim(),
        rule: "chain-task-needs-user-task-ref",
      });
    }
  }
  return findings;
}

function main(): void {
  const allFindings: Finding[] = [];
  for (const f of SCAN_FILES) {
    allFindings.push(...findChainTaskCreateSites(f));
  }
  if (allFindings.length === 0) {
    console.log(
      `verify:task-source-invariant: PASS (chain-task create sites in materializeDecomposeChain all carry user_task_ref)`,
    );
    process.exit(0);
  }
  console.error(
    `verify-task-source-invariant: FAIL (${allFindings.length} finding(s))`,
  );
  for (const f of allFindings) {
    console.error(`  [${f.rule}] ${f.file}:${f.line}  ${f.context}`);
  }
  process.exit(1);
}

main();