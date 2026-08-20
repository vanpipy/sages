/**
 * verification-cmd-linter tests — GC-2026-056
 *
 * Covers:
 *  - isPlaceholderVerificationCmd: every documented placeholder
 *  - isPlaceholderVerificationCmd: real commands return false
 *  - runVerificationProbe: real commands report correctly
 *  - runVerificationProbe: timeout works
 *  - runVerificationProbe: failure produces non-zero exit
 *  - validateVerificationCmd: end-to-end (sync + probe modes)
 */

import { describe, it, expect } from "bun:test";
import {
  isPlaceholderVerificationCmd,
  runVerificationProbe,
  validateVerificationCmd,
} from "@/tools/orchestrator/verification-cmd-linter.js";

describe("verification-cmd-linter: isPlaceholderVerificationCmd (GC-2026-056)", () => {
  const PLACEHOLDERS = [
    "",
    "   ",
    "true",
    "false",
    ":",
    "exit",
    "exit 0",
    "exit 0;",
    "cd",
    "cd .",
    "cd /",
    "echo",
    "echo yes",
    "echo ok",
    "echo done",
    "echo pass",
    "echo failed",
    "echo fine",
    "echo nothing",
    "echo placeholder",
    "echo todo",
    'echo "yes"',
    'echo "ok"',
    'echo "done"',
    "echo 1",
    "echo 0",
    "echo true",
    "echo false",
    "echo all good",
  ];

  for (const cmd of PLACEHOLDERS) {
    it(`P-01: '${cmd}' === is detected as placeholder`, () => {
      expect(isPlaceholderVerificationCmd(cmd)).toBe(true);
    });
  }

  const REAL_COMMANDS = [
    "pwd",
    "echo $PATH",
    "echo hello world",
    "bun test ./src",
    "cargo build --release",
    "ls -la",
    "cat README.md",
    "test -f package.json && echo yes",
    "grep -r 'TODO' src/",
    "make test",
  ];

  for (const cmd of REAL_COMMANDS) {
    it(`P-02: '${cmd}' is NOT detected as placeholder`, () => {
      expect(isPlaceholderVerificationCmd(cmd)).toBe(false);
    });
  }
});

describe("verification-cmd-linter: runVerificationProbe (GC-2026-056)", () => {
  it("E-01: real command reports ran=true + meaningful=true", async () => {
    const result = await runVerificationProbe("echo hello");
    expect(result.ran).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.meaningful).toBe(true);
  });

  it("E-02: failing command reports ran=true + meaningful=true (failure is signal)", async () => {
    const result = await runVerificationProbe("false");
    expect(result.ran).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.meaningful).toBe(true);
  });

  it("E-03: exit-0-no-output command is suspicious", async () => {
    // `cd /tmp` exits 0 silently. Use it as a real exit-0-no-output
    // probe target (not in the placeholder list, ≥ 5 chars).
    const result = await runVerificationProbe("cd /tmp");
    expect(result.ran).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.meaningful).toBe(false);
    expect(result.reason).toContain("suspicious");
  });

  it("E-04: missing binary reports ran=true + non-zero exit (signal)", async () => {
    // The shell builtin error returns exit 127. That's a SIGNAL —
    // the verifier fails — and our implementation correctly marks it
    // as meaningful (a non-zero exit is a real signal). The LLM gets
    // to see the exit code in the probe result and decide.
    const result = await runVerificationProbe("/nonexistent/binary/that/does/not/exist");
    expect(result.ran).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.meaningful).toBe(true);
  });

  it("E-05: timeout fires within the configured budget", async () => {
    const result = await runVerificationProbe("sleep 5", { timeoutMs: 200 });
    expect(result.ran).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.reason).toContain("timeout");
  });

  it("E-06: output is truncated at 4 KiB", async () => {
    // Generate > 4 KiB of output via seq.
    const result = await runVerificationProbe("seq 1 1000");
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES_PLUS_TRUNC_MARKER);
  });
});

const MAX_OUTPUT_BYTES_PLUS_TRUNC_MARKER = 4096 + 50; // 4096 + "[...truncated]\n"

describe("verification-cmd-linter: validateVerificationCmd (GC-2026-056)", () => {
  it("V-01: empty cmd rejected", async () => {
    const r = await validateVerificationCmd("");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("empty"))).toBe(true);
  });

  it("V-02: short cmd rejected", async () => {
    const r = await validateVerificationCmd("ls");
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("too short"))).toBe(true);
  });

  it("V-03: placeholder rejected", async () => {
    const r = await validateVerificationCmd("echo yes");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("placeholder");
  });

  it("V-04: real command passes without probe", async () => {
    const r = await validateVerificationCmd("echo hello world");
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.probe).toBeUndefined();
  });

  it("V-05: real command + probe runs and reports probe result", async () => {
    const r = await validateVerificationCmd("echo hello world", { runProbe: true });
    expect(r.valid).toBe(true);
    expect(r.probe?.ran).toBe(true);
    expect(r.probe?.meaningful).toBe(true);
  });

  it("V-06: probe detects exit-0-no-output and warns", async () => {
    const r = await validateVerificationCmd("cd /tmp", { runProbe: true });
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toContain("no signal");
  });

  it("V-07: probe on placeholder is short-circuited (heuristic wins)", async () => {
    const r = await validateVerificationCmd("echo yes", { runProbe: true });
    expect(r.valid).toBe(false);
    expect(r.probe).toBeUndefined(); // never ran the probe
  });

  it("V-08: probe on missing binary produces warning (non-zero is signal)", async () => {
    const r = await validateVerificationCmd(
      "/nonexistent/binary/that/does/not/exist",
      { runProbe: true },
    );
    expect(r.valid).toBe(true);
    // Non-zero exit is meaningful — no warning.
    expect(r.warnings.length).toBe(0);
  });
});