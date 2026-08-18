import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_DIR = dirname(__dirname); // pi/test → pi/

describe("verify matrix — script presence", () => {
  const expected = [
    "scripts/verify-subagent-roster.ts",
    "scripts/verify-isolation-modes.ts",
    "scripts/verify-namespace-ownership.ts",
    "scripts/verify-soft-mode-mental-model.ts",
    "scripts/check-all.ts",
  ];

  for (const path of expected) {
    it(`${path} exists`, () => {
      expect(existsSync(join(PI_DIR, path))).toBe(true);
    });
  }
});

describe("verify matrix — script run", () => {
  it("verify:subagent-roster exits 0", () => {
    const r = spawnSync("bun", ["run", "scripts/verify-subagent-roster.ts"], { cwd: PI_DIR });
    expect(r.status).toBe(0);
  });

  it("verify:isolation-modes exits 0", () => {
    const r = spawnSync("bun", ["run", "scripts/verify-isolation-modes.ts"], { cwd: PI_DIR });
    expect(r.status).toBe(0);
  });

  it("verify:namespace-ownership exits 0", () => {
    const r = spawnSync("bun", ["run", "scripts/verify-namespace-ownership.ts"], { cwd: PI_DIR });
    expect(r.status).toBe(0);
  });

  it("verify:soft-mode-mental-model exits 0", () => {
    const r = spawnSync("bun", ["run", "scripts/verify-soft-mode-mental-model.ts"], { cwd: PI_DIR });
    expect(r.status).toBe(0);
  });
});
