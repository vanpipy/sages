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
 * The heuristic check is the primary gate. It's the same check an
 * execution probe would run but without I/O, so it stays synchronous
 * and fast inside `validateGoalContract`.
 *
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