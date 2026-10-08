/**
 * install-post-install-gates.test.ts -- GC-2026-110 (FU1b)
 *
 * Verifies the post-install gate consolidation in install.sh:
 *
 *   1. The new `run_post_install_gates` function is defined.
 *   2. The `--no-smoke` flag is parsed (sets $SMOKE=false).
 *   3. With $SMOKE=true (default), the function invokes the
 *      `verify-extension-load` smoke test (gate 3).
 *   4. With $SMOKE=false, the function skips the smoke test and
 *      prints "skipped (--no-smoke)".
 *   5. The `--help` output documents `--no-smoke`.
 *
 * Static + behavioral coverage. Bash-script testing strategy mirrors
 * install-aft-functions.test.ts: source install.sh in a subshell
 * with controlled env vars.
 *
 * Run: cd pi-orchestrator && bun test ./test/scripts/install-post-install-gates.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR_FROM_TEST = resolve(__dirname, "..", "..", "scripts");
const PI_ORCH_ROOT = resolve(SCRIPT_DIR_FROM_TEST, "..");

const INSTALL_SH = join(PI_ORCH_ROOT, "scripts", "install.sh");

// --- Static: assert the function + flag + banner strings exist in
// install.sh's source. Cheap, no shell needed.

function readInstallSh(): string {
	return readFileSync(INSTALL_SH, "utf-8");
}

describe("install.sh post-install gates (GC-2026-110 FU1b) — static", () => {
	const src = readInstallSh();

	it("declares run_post_install_gates function", () => {
		expect(src).toMatch(/^run_post_install_gates\(\)\s*\{/m);
	});

	it("declares SMOKE local variable in main()", () => {
		expect(src).toMatch(/local SMOKE=true/);
	});

	it("accepts --no-smoke in the case statement", () => {
		expect(src).toMatch(/--no-smoke\)\s+SMOKE=false/);
	});

	it("prints POST-INSTALL SMOKE TEST banner", () => {
		expect(src).toContain("==> POST-INSTALL SMOKE TEST");
	});

	it("prints PASS summary on success", () => {
		expect(src).toMatch(/POST-INSTALL SMOKE TEST: PASS/);
	});

	it("prints FAIL summary on failure", () => {
		expect(src).toMatch(/POST-INSTALL SMOKE TEST: FAIL/);
	});

	it("prints skipped message when --no-smoke is set", () => {
		expect(src).toMatch(/POST-INSTALL SMOKE TEST: skipped \(--no-smoke\)/);
	});

	it("documents --no-smoke in the usage() block", () => {
		expect(src).toMatch(/--no-smoke\s+Skip the post-install extension-load smoke test/);
	});
});

// --- Behavioral: run install.sh --help and verify --no-smoke is
// documented. Also source install.sh in a subshell and verify the
// function exists + behaves correctly.

// Resolve the real repo path so we can override LOCAL_REPO_ROOT in the
// sandbox. The sanity check in install.sh (line 84) requires the 4 peer
// dirs at $LOCAL_REPO_ROOT; we point it at the real repo (which has
// them) and run the snippet in a sandboxed cwd.
const REPO_ROOT = resolve(PI_ORCH_ROOT, "..");

// Locate `bun` on PATH. Returns the absolute path or undefined.
function which(cmd: string): string | undefined {
	const result = spawnSync("which", [cmd], { encoding: "utf-8" });
	if (result.status !== 0) return undefined;
	const out = result.stdout?.trim();
	return out && out.length > 0 ? out : undefined;
}

function buildSandbox(): string {
	const sandbox = mkdtempSync("sages-fu1b-gates-test-");
	mkdirSync(join(sandbox, "pi-orchestrator", "scripts"), { recursive: true });
	mkdirSync(join(sandbox, "pi-orchestrator", "templates"), { recursive: true });
	// Copy install.sh so sourcing works without mutating the original
	const installShPath = join(sandbox, "pi-orchestrator", "scripts", "install.sh");
	const installShContents = readFileSync(INSTALL_SH, "utf-8");
	writeFileSync(installShPath, installShContents, { mode: 0o755 });
	// Also write a truncated copy (everything up to but not including the
	// bottom-of-file `main "$@"` call). The behavioral tests source THIS
	// version so the install flow doesn't actually run.
	const truncated = installShContents.split(/\nmain "\$@"\s*$/m)[0];
	const truncatedPath = join(
		sandbox,
		"pi-orchestrator",
		"scripts",
		"install-truncated.sh",
	);
	writeFileSync(truncatedPath, truncated, { mode: 0o755 });
	return sandbox;
}

function runInSandbox(
	sandbox: string,
	snippet: string,
	env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
	// Source the truncated install.sh (no main "$@" call) so the snippet
	// can call run_post_install_gates directly without triggering the
	// full install flow. Static tests don't need this — they only read
	// the source file.
	const truncatedPath = join(
		sandbox,
		"pi-orchestrator",
		"scripts",
		"install-truncated.sh",
	);
	// LOCAL_REPO_ROOT must be set to the real repo (the sandbox doesn't
	// carry the 4 peer dirs). The sanity check at install.sh:84 looks for
	// them at $LOCAL_REPO_ROOT/{pi-orchestrator,pi-codebase-memory,...}.
	const result = spawnSync(
		"bash",
		["-c", `source "${truncatedPath}" &>/dev/null; ${snippet}`],
		{
			env: {
				...process.env,
				...env,
				SCRIPT_DIR: dirname(truncatedPath),
				LOCAL_REPO_ROOT: REPO_ROOT,
			},
			encoding: "utf-8",
		},
	);
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? -1,
	};
}

describe("install.sh post-install gates (GC-2026-110 FU1b) — behavioral", () => {
	let sandbox: string;

	beforeEach(() => {
		sandbox = buildSandbox();
	});

	afterEach(() => {
		if (sandbox && existsSync(sandbox)) {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});

	it("--help output documents --no-smoke", () => {
		// Invoke the FULL install.sh with --help. The script intercepts
		// --help in main() and exits 0 after printing usage(). We can't
		// use the truncated script here because it lacks the main "$@"
		// call that processes the --help flag.
		const result = spawnSync(
			"bash",
			[join(sandbox, "pi-orchestrator", "scripts", "install.sh"), "--help"],
			{
				encoding: "utf-8",
				env: { ...process.env, HOME: sandbox, LOCAL_REPO_ROOT: REPO_ROOT },
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--no-smoke");
	});

	it("run_post_install_gates function is callable in a sourced subshell", () => {
		// Source install.sh and call the function. Gates 1 + 2 will fail
		// in a sandbox (no real packages installed), but the function
		// itself should be defined and callable (returns non-zero).
		const result = runInSandbox(
			sandbox,
			`type run_post_install_gates &>/dev/null && echo "function defined" || echo "function MISSING"`,
		);
		expect(result.stdout).toContain("function defined");
	});

	it("with SMOKE=false, the function prints the skipped message and returns 0 (no gates to fail)", () => {
		// We construct a degenerate sandbox where verify_all_critical_install_deps
		// and verify_package_existence are stubbed to return 0 (success).
		// With SMOKE=false the function should also skip gate 3 and return 0.
		const snippet = `
			verify_all_critical_install_deps() { return 0; }
			verify_package_existence() { return 0; }
			SMOKE=false
			run_post_install_gates 2>&1
			echo "exit=$?"
		`;
		const result = runInSandbox(sandbox, snippet);
		expect(result.stdout).toContain("skipped (--no-smoke)");
		expect(result.stdout).toContain("exit=0");
		expect(result.status).toBe(0);
	});

	it("with SMOKE=true and bun on PATH, the function attempts the smoke test (prints the banner)", () => {
		// Stub the two cheap gates to return 0, then let gate 3 actually
		// try to run. We expect the banner to print, then the smoke test
		// to fail (no real extensions in the sandbox) -- the important
		// assertion is the BANNER printed, not the smoke test result.
		const bunPath = which("bun");
		if (!bunPath) {
			// bun is not installed in the test env; skip the assertion
			// (the static test on line 32 already pins the banner string).
			return;
		}
		const snippet = `
			verify_all_critical_install_deps() { return 0; }
			verify_package_existence() { return 0; }
			SMOKE=true
			run_post_install_gates 2>&1
			echo "exit=$?"
		`;
		// Pass the parent PATH so the sandbox's `command -v bun` check
		// finds the same bun binary the test runner uses.
		const parentPath = process.env.PATH ?? "/usr/bin:/bin";
		const result = runInSandbox(sandbox, snippet, { PATH: parentPath });
		// Banner MUST print (stdout + stderr merged)
		expect(result.stdout).toMatch(/POST-INSTALL SMOKE TEST/);
	});
});
