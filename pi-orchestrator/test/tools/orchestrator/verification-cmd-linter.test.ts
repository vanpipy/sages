/**
 * verification-cmd-linter tests — GC-2026-056
 *
 * Covers the `isPlaceholderVerificationCmd` heuristic that gates goal
 * contract creation. The execution probe + sync validator surfaces were
 * dropped when their consumers (the goal-contract creation probe path)
 * were simplified; only the heuristic remains.
 */

import { describe, it, expect } from "bun:test";
import { isPlaceholderVerificationCmd } from "@/verification-cmd-linter.js";

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
		it(`P-01: '${cmd}' is detected as placeholder`, () => {
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