/**
 * verification-cmd-linter.ts — GC-2026-056
 *
 * Rejects placeholder `verification_cmd` values at goal-contract
 * creation time. Before this GC, the orchestrator only checked that
 * `verification_cmd` was a non-empty string — the LLM could submit
 * `echo "yes"` or `pwd`, and the workflow would proceed with a
 * meaningless verifier. At audit time, that command would PASS and
 * `orchestrator_audit` would report success despite verifying nothing.
 *
 * Two layers of defense:
 *
 *   1. **Heuristics** — fast, no I/O, catches obvious placeholders:
 *      empty, single-token echo, `true`, tautologies, missing-binary
 *      refs. This is the primary rejection mechanism.
 *
 *   2. **Execution probe** (optional) — actually runs the command once
 *      in a sandboxed subprocess with a 30s timeout. Captures stdout,
 *      stderr, and exit code. Detects "command exists but produces no
 *      observable signal" (e.g. `cd /tmp` exits 0 but does nothing
 *      meaningful). Used only when the heuristic passes — i.e. for
 *      commands that LOOK meaningful but might still be no-ops.
 *
 * The heuristic check is the primary gate. The execution probe is a
 * deeper check that's called only when the heuristic passes. Both
 * are non-blocking failures — they return structured errors that
 * the LLM can act on.
 */

import { spawn } from "node:child_process";

// ─── Heuristics ──────────────────────────────────────────────────────────────

/**
 * Single-token echo / placeholder detectors.
 *
 * Returns true for things like:
 *   - "" (empty)
 *   - "echo" (no argument — likely forgot the message)
 *   - "echo yes" / "echo done" / "echo ok" / "echo pass"
 *   - "echo \"yes\"" (quoted placeholder)
 *   - "true" (no-op shell builtin)
 *   - "false" (always returns 1, but the LLM might intend it)
 *   - ":", "exit 0", "exit 0;" (no-op colon / exit builtin)
 *   - "cd ." (no-op cd)
 *
 * Returns false for:
 *   - "pwd" (does output the working dir)
 *   - "echo $PATH" (variable expansion)
 *   - "bun test ./src" (a real command)
 *   - anything with shell metacharacters that suggest real work
 */
export function isPlaceholderVerificationCmd(cmd: string): boolean {
  const trimmed = cmd.trim();

  // Empty or whitespace-only.
  if (trimmed.length === 0) return true;

  // Strip outer quotes.
  const unquoted = trimmed
    .replace(/^["']/, "")
    .replace(/["']$/, "")
    .trim();

  // Single-token no-ops.
  const SINGLETON_NOOP = new Set([
    "true",
    "false",
    ":",
    "exit",
    "exit 0",
    "exit 0;",
    "cd",
    "cd .",
    "cd /",
  ]);
  if (SINGLETON_NOOP.has(unquoted)) return true;

  // Echo with placeholder argument.
  // Match: echo <yes|ok|done|pass|fine|alright|nothing|none|placeholder|...>
  const PLACEHOLDER_ECHO_ARGS = new Set([
    "yes",
    "ok",
    "okay",
    "done",
    "pass",
    "passed",
    "fail",
    "failed",
    "fine",
    "alright",
    "all good",
    "nothing",
    "none",
    "placeholder",
    "todo",
    "fixme",
    "xxx",
    "test",
    "true",
    "false",
    "1",
    "0",
    '"yes"',
    '"ok"',
    '"done"',
  ]);
  const echoMatch = /^echo\s+(\S.*)$/.exec(unquoted);
  if (echoMatch) {
    const arg = echoMatch[1].replace(/^["']/, "").replace(/["']$/, "").trim();
    if (PLACEHOLDER_ECHO_ARGS.has(arg.toLowerCase())) return true;
  }

  // Echo with no arg.
  if (unquoted === "echo") return true;

  return false;
}

// ─── Execution probe ────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 30_000;

export interface VerificationProbeResult {
  /** Whether the command ran without timing out. */
  ran: boolean;
  /** Exit code from the subprocess (null if timed out / spawn failed). */
  exitCode: number | null;
  /** Captured stdout (truncated to 4 KiB). */
  stdout: string;
  /** Captured stderr (truncated to 4 KiB). */
  stderr: string;
  /** True when exit code is 0 AND output is meaningful. */
  meaningful: boolean;
  /** Why it's not meaningful (when meaningful=false). */
  reason?: string;
}

const MAX_OUTPUT_BYTES = 4096;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + "\n[...truncated]";
}

/**
 * Actually run the verification_cmd once in a sandboxed subprocess.
 * The harness has a 30-second timeout. We report meaningfulness based
 * on exit code + output volume; the LLM gets to see the actual exit
 * code and stdout/stderr to judge for itself.
 */
export async function runVerificationProbe(
  cmd: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<VerificationProbeResult> {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    try {
      const child = spawn(cmd, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        // Detach so we can kill on timeout.
        detached: false,
      });

      // Timeout escalation: SIGTERM after `timeoutMs`, then SIGKILL
      // after a 1s grace period if the child is still alive. We
      // also force-resolve the promise after the grace period even if
      // the child's `close` event never fires (some commands ignore
      // SIGTERM and survive SIGKILL only briefly). The promise is
      // guaranteed to settle within timeoutMs + 1500ms.
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore — process already gone */
          }
          // Force-resolve in case close event never fires.
          if (!resolved) {
            resolved = true;
            resolve({
              ran: false,
              exitCode: null,
              stdout: truncate(stdout),
              stderr: truncate(stderr + `\n[forced timeout after ${timeoutMs}ms + 1000ms grace]`),
              meaningful: false,
              reason: `timeout after ${timeoutMs}ms (force-resolved)`,
            });
          }
        }, 1000);
      }, timeoutMs);

      let resolved = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
        if (stdout.length > MAX_OUTPUT_BYTES * 2) {
          stdout = stdout.slice(0, MAX_OUTPUT_BYTES * 2);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
        if (stderr.length > MAX_OUTPUT_BYTES * 2) {
          stderr = stderr.slice(0, MAX_OUTPUT_BYTES * 2);
        }
      });

      child.on("error", (err) => {
        if (resolved) return;
        clearTimeout(timer);
        resolved = true;
        resolve({
          ran: false,
          exitCode: null,
          stdout: truncate(stdout),
          stderr: truncate(stderr + `\n[spawn error: ${err.message}]`),
          meaningful: false,
          reason: `spawn failed: ${err.message}`,
        });
      });

      child.on("close", (code) => {
        if (resolved) return;
        clearTimeout(timer);
        resolved = true;
        const exitCode = code;

        if (timedOut) {
          resolve({
            ran: false,
            exitCode: null,
            stdout: truncate(stdout),
            stderr: truncate(stderr + `\n[timeout after ${timeoutMs}ms]`),
            meaningful: false,
            reason: `timeout after ${timeoutMs}ms`,
          });
          return;
        }

        // Decide meaningfulness:
        //  - exit 0 AND has output (or is a complex enough command): meaningful
        //  - exit 0 AND no output AND command was a no-op shell builtin: not meaningful
        const out = truncate(stdout);
        const err = truncate(stderr);
        const hasOutput = out.trim().length > 0 || err.trim().length > 0;

        if (exitCode === 0) {
          if (hasOutput) {
            resolve({ ran: true, exitCode, stdout: out, stderr: err, meaningful: true });
          } else {
            // Exit 0 with no output. Could be a true no-op (e.g. `:`)
            // or a command that always exits 0 silently. Treat as not
            // meaningful — LLM should add a meaningful action.
            resolve({
              ran: true,
              exitCode,
              stdout: out,
              stderr: err,
              meaningful: false,
              reason: "exit 0 with no output (suspicious — verifier should produce observable signal)",
            });
          }
        } else {
          // Non-zero exit. The LLM's command failed; that's already
          // a signal — the verifier will fail at audit time anyway.
          // Mark as meaningful (failure is signal).
          resolve({
            ran: true,
            exitCode,
            stdout: out,
            stderr: err,
            meaningful: true,
            reason: `non-zero exit code ${exitCode}`,
          });
        }
      });
    } catch (err) {
      resolve({
        ran: false,
        exitCode: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        meaningful: false,
        reason: `exception: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

// ──── Combined validator ────────────────────────────────────────────────────

export interface VerificationCmdValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** When probe was run, the probe result. */
  probe?: VerificationProbeResult;
}

/**
 * Full validation pipeline for a single verification_cmd:
 *   1. Non-empty
 *   2. Heuristic placeholder check
 *   3. (optional) execution probe — only when heuristics pass; warns if
 *      the command exits 0 silently (suspicious)
 *
 * Pure-validate mode skips the probe (used by tests + by the synchronous
 * path inside `validateGoalContract`). Probe-on mode runs the probe
 * asynchronously; the goal contract creation must await it.
 */
export async function validateVerificationCmd(
  cmd: string,
  options: { runProbe?: boolean; cwd?: string; timeoutMs?: number } = {},
): Promise<VerificationCmdValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (cmd.trim().length === 0) {
    errors.push("verification_cmd is empty");
    return { valid: false, errors, warnings };
  }
  if (cmd.trim().length < 5) {
    errors.push("verification_cmd is too short (min 5 chars)");
    return { valid: false, errors, warnings };
  }

  if (isPlaceholderVerificationCmd(cmd)) {
    errors.push(
      `verification_cmd looks like a placeholder: '${cmd}'. Write something that produces an observable signal (e.g. a test command, a typecheck, a file-existence check).`,
    );
    return { valid: false, errors, warnings };
  }

  let probe: VerificationProbeResult | undefined;
  if (options.runProbe) {
    probe = await runVerificationProbe(cmd, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    });
    if (!probe.ran) {
      warnings.push(
        `verification_cmd probe did not run: ${probe.reason ?? "unknown"}`,
      );
    } else if (!probe.meaningful) {
      warnings.push(
        `verification_cmd exits cleanly but produces no signal: ${probe.reason ?? "unknown"}`,
      );
    }
  }

  return { valid: true, errors, warnings, probe };
}