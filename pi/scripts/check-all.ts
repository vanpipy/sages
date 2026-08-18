#!/usr/bin/env bun
/**
 * check:all — aggregate verifier
 *
 * Runs the full verify matrix in sequence:
 *   1. typecheck
 *   2. bun test ./src ./test
 *   3. verify:catalog
 *   4. verify:subagent-roster
 *   5. verify:isolation-modes
 *   6. verify:namespace-ownership
 *   7. verify:soft-mode-mental-model
 *
 * Exits non-zero on first failure. Designed to be the single gate CI
 * can wire up.
 */

interface Step {
  name: string;
  cmd: string[];
}

const STEPS: Step[] = [
  { name: "typecheck", cmd: ["bun", "run", "typecheck"] },
  { name: "test:unit", cmd: ["bun", "test", "./src", "./test"] },
  { name: "verify:catalog", cmd: ["bun", "run", "verify:catalog"] },
  { name: "verify:subagent-roster", cmd: ["bun", "run", "verify:subagent-roster"] },
  { name: "verify:isolation-modes", cmd: ["bun", "run", "verify:isolation-modes"] },
  { name: "verify:namespace-ownership", cmd: ["bun", "run", "verify:namespace-ownership"] },
  { name: "verify:soft-mode-mental-model", cmd: ["bun", "run", "verify:soft-mode-mental-model"] },
];

async function runStep(step: Step): Promise<number> {
  console.log(`\n=== check:all step: ${step.name} ===`);
  const proc = Bun.spawn(step.cmd, {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  return await proc.exited;
}

async function main(): Promise<void> {
  const start = Date.now();
  for (const step of STEPS) {
    const exit = await runStep(step);
    if (exit !== 0) {
      console.error(`\ncheck:all: FAIL at step "${step.name}" (exit ${exit})`);
      process.exit(exit);
    }
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\ncheck:all: OK — all ${STEPS.length} gates green (${elapsed}s)`);
}

if (process.argv[1] === import.meta.path) {
  main();
}
