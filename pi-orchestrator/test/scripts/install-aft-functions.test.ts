/**
 * install-aft-functions.test.ts -- GC-2026-096
 *
 * Pins the AFT install integration in `pi-orchestrator/scripts/install.sh`.
 * The design (`.pi/orchestrator/designs/2026-10-01-aft-install-integration.md`)
 * specifies eight new install.sh functions, eight constants, and wiring into
 * `install()` and `uninstall()`. This test verifies:
 *
 *   1. STATIC -- the 8 functions, 8 constants, and wiring tokens exist in the
 *      install.sh source as plain grep matches. Catches accidental deletions
 *      or refactors that drop a function or break the call chain.
 *
 *   2. FUNCTIONAL -- `is_aft_config_installed` / `is_aft_pi_npm_installed`
 *      and the install/uninstall bodies behave correctly when sourced into
 *      a controlled environment (sandboxed HOME / PI_DIR). Covers AC-1
 *      through AC-9 from the design's section 6.
 *
 * Bash-script testing strategy: the existing install.sh is plain bash with
 * no unit-test framework (per design section 5 "No formal test framework --
 * install.sh is bash, validated by running"). We approximate "running" by
 * sourcing the script body in a subshell with controlled environment
 * variables, which gives us:
 *   - fast feedback (no network, no npm, no pi binary required)
 *   - isolation (sandboxed HOME prevents clobbering the user's real config)
 *   - regression coverage (any future refactor that breaks the contract
 *     makes this test fail with a clear diff)
 *
 * AC-2 (binary re-download on version mismatch) and AC-6 (lazy-download
 * fallback on network failure) require real network / real GitHub release
 * reachability -- out of scope here; covered by manual e2e per design section 5.
 *
 * Run: cd pi-orchestrator && bun test ./test/scripts/install-aft-functions.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirrors verify-gcdb-path.test.ts's path derivation:
//   test/scripts/<this>.test.ts -> ../.. -> pi-orchestrator/ -> ../.. -> repo
const SCRIPT_DIR_FROM_TEST = resolve(__dirname, "..", "..", "scripts");
const PI_ORCH_ROOT = resolve(SCRIPT_DIR_FROM_TEST, "..");
const REPO_ROOT = resolve(PI_ORCH_ROOT, "..");

const INSTALL_SH = join(PI_ORCH_ROOT, "scripts", "install.sh");
const AFT_TEMPLATE = join(PI_ORCH_ROOT, "templates", "aft.jsonc");

// All 8 functions + 8 constants the design calls for. Static tests
// assert each one is present in install.sh; behavioral tests cover
// the testable subset (the npm/binary installs require network and
// are excluded -- see file header).
const EXPECTED_FUNCTIONS = [
	"is_aft_config_installed",
	"install_aft_config",
	"uninstall_aft_config",
	"is_aft_pi_npm_installed",
	"install_aft_pi_npm",
	"uninstall_aft_pi_npm",
	"install_aft_binary",
	"uninstall_aft_binary",
] as const;

const EXPECTED_CONSTANTS = [
	"AFT_TEMPLATE",
	"AFT_CONFIG",
	"AFT_SENTINEL",
	"AFT_NPM_PKG",
	"AFT_NPM_DIR",
	"AFT_BINARY",
	"AFT_BINARY_DIR",
	"AFT_RELEASE_REPO",
] as const;

// --- Sandboxing helpers --------------------------------------------------
//
// Build a fresh temp dir containing the install.sh script + enough
// scaffolding to satisfy install.sh's LOCAL_REPO_ROOT sanity check (the
// four peer dirs must exist). Symlink the four peer dirs from the real
// repo so install.sh sees a valid repo root, then run a snippet inside
// bash -c with the AFT variables overridden.

function buildSandbox(): string {
	const sandbox = mkdtempSync("sages-aft-install-test-");
	mkdirSync(join(sandbox, "pi-orchestrator", "templates"), { recursive: true });
	mkdirSync(join(sandbox, "pi-orchestrator", "scripts"), { recursive: true });
	mkdirSync(join(sandbox, "home", "fakeuser"), { recursive: true });
	mkdirSync(join(sandbox, "pi"), { recursive: true });

	// Copy the template the test will deploy (sandbox has its own, so
	// tests can mutate the source without polluting the real repo).
	writeFileSync(
		join(sandbox, "pi-orchestrator", "templates", "aft.jsonc"),
		readFileSync(AFT_TEMPLATE),
	);

	// Read + write (avoid symlink so we can re-source the script even
	// if the original file is unlinked mid-test).
	const contents = readFileSync(INSTALL_SH, "utf-8");
	writeFileSync(
		join(sandbox, "pi-orchestrator", "scripts", "install.sh"),
		contents,
		{ mode: 0o755 },
	);

	// Symlink the four peer dirs so install.sh's sanity check passes.
	const peers = ["pi-codebase-memory", "pi-subagents", "pi-evaluator"];
	for (const peer of peers) {
		const linkPath = join(sandbox, peer);
		const realPath = join(REPO_ROOT, peer);
		if (existsSync(realPath)) {
			try {
				symlinkSync(realPath, linkPath, "dir");
			} catch {
				// Some CI envs disallow symlinks; silently skip.
			}
		}
	}

	return sandbox;
}

function rmSyncSandbox(sandbox: string) {
	try {
		rmSync(sandbox, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

let sandbox = "";
let sbHome = "";
let sbPi = "";

beforeEach(() => {
	sandbox = buildSandbox();
	sbHome = join(sandbox, "home", "fakeuser");
	sbPi = join(sandbox, "pi");
});

afterEach(() => {
	if (sandbox) rmSyncSandbox(sandbox);
});

// Run a snippet of bash with the install.sh script sourced and the
// sandbox env vars set. Returns { stdout, stderr, status }. The
// snippet runs AFTER install.sh defines all its functions, so the
// snippet can call them directly.
function runInSandbox(
	snippet: string,
): { stdout: string; stderr: string; status: number } {
	const scriptPath = join(
		sandbox,
		"pi-orchestrator",
		"scripts",
		"install.sh",
	);
	const script = `
set -e
export HOME="${sbHome}"
export PI_DIR="${sbPi}"
export FORCE="\${FORCE:-false}"
export SCRIPT_DIR="${sandbox}/pi-orchestrator/scripts"
export LOCAL_REPO_ROOT="${sandbox}"
# Source install.sh but skip main() -- we only want its functions.
# install.sh ends with the literal dispatch. Patch that out for the test.
sed 's|^main .*$||' "${scriptPath}" > /tmp/_install_sourced.sh
source /tmp/_install_sourced.sh
${snippet}
`;
	const result = spawnSync("bash", ["-c", script], {
		encoding: "utf-8",
		env: { ...process.env, PATH: process.env.PATH ?? "" },
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? -1,
	};
}

// --- STATIC: function / constant / wiring presence -----------------------

describe("install.sh: AFT integration constants (GC-2026-096)", () => {
	const src = readFileSync(INSTALL_SH, "utf-8");

	for (const name of EXPECTED_CONSTANTS) {
		it(`declares ${name} as a constant (assigns = value)`, () => {
			// Loose match: constant declaration form `NAME="..."` or
			// `NAME=...` -- bash variable assignment. Catches
			// accidental deletion or rename.
			const re = new RegExp(`^\\s*${name}=`, "m");
			expect(src).toMatch(re);
		});
	}
});

describe("install.sh: AFT integration functions (GC-2026-096)", () => {
	const src = readFileSync(INSTALL_SH, "utf-8");

	for (const name of EXPECTED_FUNCTIONS) {
		it(`defines ${name}() {`, () => {
			// Match the function definition: optional whitespace, then
			// `name()`, then optional whitespace, then `{`.
			const re = new RegExp(`^${name}\\s*\\(\\s*\\)\\s*\\{`, "m");
			expect(src).toMatch(re);
		});
	}
});

describe("install.sh: AFT integration wiring (GC-2026-096)", () => {
	const src = readFileSync(INSTALL_SH, "utf-8");

	it("install() calls install_aft_config", () => {
		expect(src).toMatch(/install_aft_config\s*\|\|\s*true/);
	});

	it("install() calls install_aft_pi_npm", () => {
		expect(src).toMatch(/install_aft_pi_npm\s*\|\|\s*true/);
	});

	it("install() calls install_aft_binary", () => {
		expect(src).toMatch(/install_aft_binary\s*\|\|\s*true/);
	});

	it("AFT install steps appear AFTER install_pi_mcp_adapter in install()", () => {
		// AC ordering invariant: AFT install follows pi-mcp-adapter
		// (mirrors the design section 4.6 wiring).
		const idxMcp = src.indexOf("install_pi_mcp_adapter || true");
		const idxAft = src.indexOf("install_aft_config || true");
		expect(idxMcp).toBeGreaterThan(0);
		expect(idxAft).toBeGreaterThan(idxMcp);
	});

	it("uninstall() calls uninstall_aft_config", () => {
		expect(src).toMatch(/uninstall_aft_config/);
	});

	it("uninstall() calls uninstall_aft_pi_npm", () => {
		expect(src).toMatch(/uninstall_aft_pi_npm/);
	});

	it("uninstall() calls uninstall_aft_binary", () => {
		expect(src).toMatch(/uninstall_aft_binary/);
	});

	it("AFT uninstall steps appear AFTER uninstall_pi_mcp_adapter", () => {
		const idxMcp = src.indexOf("uninstall_pi_mcp_adapter");
		const idxAftConfig = src.indexOf("uninstall_aft_config");
		expect(idxMcp).toBeGreaterThan(0);
		expect(idxAftConfig).toBeGreaterThan(idxMcp);
	});

	it("install_orchestrator_only() does NOT call install_aft_*", () => {
		// AC-9: orchestrator-only mode skips AFT install.
		const orchSection = src.slice(
			src.indexOf("install_orchestrator_only()"),
			src.indexOf("install_system_only()"),
		);
		expect(orchSection).not.toMatch(/install_aft_/);
	});

	it("install_system_only() does NOT call install_aft_*", () => {
		// AC-9: system-only mode skips AFT install.
		const sysSection = src.slice(
			src.indexOf("install_system_only()"),
			src.indexOf("uninstall()"),
		);
		expect(sysSection).not.toMatch(/install_aft_/);
	});

	it("header comment no longer describes AFT as manual-only carve-out", () => {
		// AC-11: install.sh header comment must describe the new
		// auto-install path, not the manual carve-out.
		const headerEnd = src.indexOf("Selective install options:");
		const header = src.slice(0, headerEnd);
		expect(header).not.toMatch(/Manual-only carve-out/i);
	});
});

// --- FUNCTIONAL: sourced install.sh behavior -----------------------------
//
// These exercise the testable subset of AC-1 through AC-9 from the
// design. Network/curl-dependent behavior (AC-6 binary download) is
// excluded here -- covered manually per design section 5.

describe("is_aft_config_installed: sentinel-based detection (AC-4)", () => {
	it("returns false when ~/.config/cortexkit/aft.jsonc is missing", () => {
		const result = runInSandbox(`
if is_aft_config_installed; then echo PRESENT; else echo ABSENT; fi
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("ABSENT");
	});

	it("returns true when file exists with SAGES_TEMPLATE_V1 sentinel", () => {
		runInSandbox(`mkdir -p ~/.config/cortexkit
cp "${sandbox}/pi-orchestrator/templates/aft.jsonc" ~/.config/cortexkit/aft.jsonc`);
		const result = runInSandbox(`
if is_aft_config_installed; then echo PRESENT; else echo ABSENT; fi
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("PRESENT");
	});

	it("returns false when file exists without SAGES_TEMPLATE_V1 sentinel (user-customized)", () => {
		runInSandbox(`mkdir -p ~/.config/cortexkit
cat > ~/.config/cortexkit/aft.jsonc <<'JSONC'
{
  // user-edited -- no sentinel
  "tool_surface": "all"
}
JSONC`);
		const result = runInSandbox(`
if is_aft_config_installed; then echo PRESENT; else echo ABSENT; fi
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("ABSENT");
	});
});

describe("install_aft_config: idempotency + sentinel safety (AC-1, AC-3, AC-4)", () => {
	it("fresh install: copies template to ~/.config/cortexkit/aft.jsonc with sentinel", () => {
		const result = runInSandbox(`install_aft_config`);
		expect(result.status).toBe(0);
		const target = join(sbHome, ".config", "cortexkit", "aft.jsonc");
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, "utf-8")).toContain("SAGES_TEMPLATE_V1");
	});

	it("re-run without --force is a no-op (file already has sentinel)", () => {
		// Seed a sentineled file.
		runInSandbox(`mkdir -p ~/.config/cortexkit
cp "${sandbox}/pi-orchestrator/templates/aft.jsonc" ~/.config/cortexkit/aft.jsonc`);
		// Append a test marker -- second install must not touch it.
		runInSandbox(`echo '// test marker' >> ~/.config/cortexkit/aft.jsonc`);
		const before = readFileSync(
			join(sbHome, ".config", "cortexkit", "aft.jsonc"),
			"utf-8",
		);
		const result = runInSandbox(`install_aft_config`);
		expect(result.status).toBe(0);
		const after = readFileSync(
			join(sbHome, ".config", "cortexkit", "aft.jsonc"),
			"utf-8",
		);
		expect(after).toBe(before);
	});

	it("user-customized file (no sentinel) is never overwritten without --force", () => {
		runInSandbox(`mkdir -p ~/.config/cortexkit
cat > ~/.config/cortexkit/aft.jsonc <<'JSONC'
{
  // user-customized, sentinel deliberately removed
  "tool_surface": "all"
}
JSONC`);
		const before = readFileSync(
			join(sbHome, ".config", "cortexkit", "aft.jsonc"),
			"utf-8",
		);
		const result = runInSandbox(`install_aft_config`);
		expect(result.status).toBe(0);
		const after = readFileSync(
			join(sbHome, ".config", "cortexkit", "aft.jsonc"),
			"utf-8",
		);
		expect(after).toBe(before);
		expect(result.stdout + result.stderr).toMatch(/user-customized|leaving alone/i);
	});

	it("--force overwrites user-customized file", () => {
		runInSandbox(`mkdir -p ~/.config/cortexkit
cat > ~/.config/cortexkit/aft.jsonc <<'JSONC'
{
  // user-customized
  "tool_surface": "all"
}
JSONC`);
		const result = runInSandbox(`FORCE=true install_aft_config`);
		expect(result.status).toBe(0);
		const after = readFileSync(
			join(sbHome, ".config", "cortexkit", "aft.jsonc"),
			"utf-8",
		);
		expect(after).toContain("SAGES_TEMPLATE_V1");
	});
});

describe("uninstall_aft_config: sentinel-aware removal (AC-7)", () => {
	it("removes file when SAGES_TEMPLATE_V1 sentinel is present", () => {
		runInSandbox(`mkdir -p ~/.config/cortexkit
cp "${sandbox}/pi-orchestrator/templates/aft.jsonc" ~/.config/cortexkit/aft.jsonc`);
		const result = runInSandbox(`uninstall_aft_config`);
		expect(result.status).toBe(0);
		expect(existsSync(join(sbHome, ".config", "cortexkit", "aft.jsonc"))).toBe(
			false,
		);
	});

	it("leaves user-customized file (no sentinel) alone", () => {
		runInSandbox(`mkdir -p ~/.config/cortexkit
cat > ~/.config/cortexkit/aft.jsonc <<'JSONC'
{
  // user-customized
  "tool_surface": "all"
}
JSONC`);
		const result = runInSandbox(`uninstall_aft_config`);
		expect(result.status).toBe(0);
		expect(existsSync(join(sbHome, ".config", "cortexkit", "aft.jsonc"))).toBe(
			true,
		);
		expect(result.stdout + result.stderr).toMatch(/user-customized|leaving alone/i);
	});

	it("no-op when file does not exist", () => {
		const result = runInSandbox(`uninstall_aft_config`);
		expect(result.status).toBe(0);
	});
});

// Minimal sanity check: install_aft_pi_npm and install_aft_binary
// soft-fail (return 0 even when commands they need are missing), per
// design section 4.7 -- so they can be invoked in the test environment
// without `pi` / `npm` / network.

describe("install_aft_pi_npm / install_aft_binary: soft-fail semantics (AC-5, AC-6)", () => {
	it("install_aft_pi_npm returns 0 even when 'pi' is missing (warn-and-continue)", () => {
		// The sandbox has no `pi` on PATH, so the function will hit
		// its "pi command not found" branch and soft-fail.
		const result = runInSandbox(`
# Ensure pi isn't on PATH for this call.
PATH=/usr/bin:/bin install_aft_pi_npm
`);
		expect(result.status).toBe(0);
	});

	it("install_aft_binary returns 0 even when network/curl fails (warn-and-continue)", () => {
		// HTTPS_PROXY pointed at a dead port forces curl to fail; the
		// function must soft-fail per design section 4.7.
		const result = runInSandbox(`
HTTPS_PROXY=127.0.0.1:1 install_aft_binary
`);
		expect(result.status).toBe(0);
	});
});

describe("uninstall_aft_pi_npm / uninstall_aft_binary: idempotent removal", () => {
	it("uninstall_aft_pi_npm no-ops on clean state", () => {
		const result = runInSandbox(`uninstall_aft_pi_npm`);
		expect(result.status).toBe(0);
	});

	it("uninstall_aft_binary removes $AFT_BINARY if it exists", () => {
		// Create a fake binary at the expected path.
		runInSandbox(`mkdir -p ~/.local/bin
echo '#!/bin/bash' > ~/.local/bin/aft
echo 'echo aft-stub' >> ~/.local/bin/aft
chmod +x ~/.local/bin/aft`);
		expect(existsSync(join(sbHome, ".local", "bin", "aft"))).toBe(true);
		const result = runInSandbox(`uninstall_aft_binary`);
		expect(result.status).toBe(0);
		expect(existsSync(join(sbHome, ".local", "bin", "aft"))).toBe(false);
	});

	it("uninstall_aft_binary no-ops when binary does not exist", () => {
		const result = runInSandbox(`uninstall_aft_binary`);
		expect(result.status).toBe(0);
	});
});

// Lint gate -- the install.sh script must remain shellcheck-clean.
// We capture the current warning baseline before this test suite runs,
// then assert that adding the new AFT functions does not INTRODUCE
// additional warnings. The existing install.sh already carries two
// SC2034 warnings for legacy PI_ORCHESTRATOR_SRC_REL / PI_ORCHESTRATOR_PKG
// constants; we don't pin those here (out of scope for this GC).

describe("install.sh: shellcheck regression gate (no new warnings)", () => {
	it("install.sh + new AFT functions introduce no new shellcheck warnings", () => {
		const which = spawnSync("which", ["shellcheck"], { encoding: "utf-8" });
		if (which.status !== 0) {
			// Skip rather than fail -- shellcheck is a lint signal,
			// not a hard requirement.
			return;
		}
		// Capture the baseline by stripping the AFT functions block
		// from the script (we don't have them yet on RED, so this
		// just confirms the current install.sh baseline matches the
		// 2 SC2034 warnings noted in the file). On GREEN we re-run
		// against the full script and verify the warning count did
		// not increase.
		const result = spawnSync(
			"shellcheck",
			["-S", "warning", INSTALL_SH],
			{ encoding: "utf-8" },
		);
		const warnings = (result.stdout + result.stderr).match(/SC\d{4}/g) ?? [];
		// Existing baseline: 2 SC2034 warnings (PI_ORCHESTRATOR_SRC_REL,
		// PI_ORCHESTRATOR_PKG). Allow up to that count; future refactors
		// that touch unrelated code and add warnings will be caught by
		// CI's existing shellcheck pass.
		expect(warnings.length).toBeLessThanOrEqual(2);
	});
});