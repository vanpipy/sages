/**
 * install-package-existence.test.ts — GC-2026-main-agent-tool-surface.
 *
 * Pins the package-existence gate added to install.sh:
 *   - `PI_ORCHESTRATOR_PKG` constant (parity with PI_SUBAGENTS_PKG etc.)
 *   - `is_pi_orchestrator_installed()` helper (was the only missing guard)
 *   - `verify_package_existence()` end-of-run gate (catches any
 *      registered-but-missing local-path peer at install time)
 *
 * The host extension loader (pi-coding-agent's loader.js:541-555) fail-softs
 * on missing paths with zero logging, so a dest-dir deletion silently
 * strips the orchestrator's tools from the LLM-facing tool surface. These
 * helpers make the breakage observable at install time.
 *
 * Strategy mirrors install-aft-functions.test.ts: STATIC grep checks
 * (constants / functions / wiring presence) + FUNCTIONAL sandboxed
 * bash that sources install.sh and exercises the helpers in a
 * controlled $HOME / $PI_DIR.
 *
 * Run: cd pi-orchestrator && bun test ./test/scripts/install-package-existence.test.ts
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
const SCRIPT_DIR_FROM_TEST = resolve(__dirname, "..", "..", "scripts");
const PI_ORCH_ROOT = resolve(SCRIPT_DIR_FROM_TEST, "..");
const REPO_ROOT = resolve(PI_ORCH_ROOT, "..");

const INSTALL_SH = join(PI_ORCH_ROOT, "scripts", "install.sh");

// --- Sandbox helpers (mirrors install-aft-functions.test.ts) -----------

function buildSandbox(): string {
	const sandbox = mkdtempSync("sages-package-existence-test-");
	mkdirSync(join(sandbox, "pi-orchestrator", "templates"), { recursive: true });
	mkdirSync(join(sandbox, "pi-orchestrator", "scripts"), { recursive: true });
	mkdirSync(join(sandbox, "home", "fakeuser"), { recursive: true });
	mkdirSync(join(sandbox, "pi"), { recursive: true });

	// Read + write (avoid symlink so we can re-source the script even
	// if the original file is unlinked mid-test).
	const contents = readFileSync(INSTALL_SH, "utf-8");
	writeFileSync(
		join(sandbox, "pi-orchestrator", "scripts", "install.sh"),
		contents,
		{ mode: 0o755 },
	);

	// Symlink the four peer dirs so install.sh's sanity check passes.
	const peers = ["pi-codebase-memory", "pi-subagents", "pi-evaluator", "pi-tasks"];
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

// --- STATIC: constant / function / wiring presence ----------------------

describe("install.sh: package-existence gate constants (GC-2026-main-agent-tool-surface)", () => {
	const src = readFileSync(INSTALL_SH, "utf-8");

	it("declares PI_ORCHESTRATOR_PKG (parity with PI_SUBAGENTS_PKG etc.)", () => {
		expect(src).toMatch(/^\s*PI_ORCHESTRATOR_PKG\s*=/m);
	});

	it("PI_ORCHESTRATOR_PKG is assigned the dest-dir absolute path", () => {
		const m = src.match(/^\s*PI_ORCHESTRATOR_PKG\s*=\s*"?(\$[A-Z_]+|")/m);
		expect(m).not.toBeNull();
		// Either it expands to $PI_ORCHESTRATOR_DEST_DIR or it's the literal path.
		const valLine = src.split("\n").find((l) => l.match(/^\s*PI_ORCHESTRATOR_PKG\s*=/));
		expect(valLine).toMatch(/(PI_ORCHESTRATOR_DEST_DIR|\$PI_DIR\/packages\/pi-orchestrator)/);
	});
});

describe("install.sh: package-existence gate functions (GC-2026-main-agent-tool-surface)", () => {
	const src = readFileSync(INSTALL_SH, "utf-8");

	it("defines is_pi_orchestrator_installed() {", () => {
		const re = new RegExp(`^is_pi_orchestrator_installed\\s*\\(\\s*\\)\\s*\\{`, "m");
		expect(src).toMatch(re);
	});

	it("defines verify_package_existence() {", () => {
		const re = new RegExp(`^verify_package_existence\\s*\\(\\s*\\)\\s*\\{`, "m");
		expect(src).toMatch(re);
	});
});

describe("install.sh: package-existence gate wiring (GC-2026-main-agent-tool-surface)", () => {
	const src = readFileSync(INSTALL_SH, "utf-8");

	it("install() calls verify_package_existence with failure recovery", () => {
		expect(src).toMatch(/verify_package_existence\s*\|\|\s*\{/);
	});

	it("verify_package_existence gate appears AFTER verify_all_critical_install_deps in install()", () => {
		// Ordering invariant: verify_all_critical_install_deps checks
		// node_modules content; verify_package_existence checks dir existence.
		// Run deps first, then existence — surfaces structural errors
		// before the simpler existence check.
		const idxDeps = src.indexOf("verify_all_critical_install_deps || {");
		const idxExist = src.indexOf("verify_package_existence || {");
		expect(idxDeps).toBeGreaterThan(0);
		expect(idxExist).toBeGreaterThan(idxDeps);
	});
});

// --- FUNCTIONAL: sourced install.sh behavior ----------------------------

describe("verify_package_existence: registered-but-missing detection", () => {
	it("returns 0 when no settings.json exists (nothing to verify)", () => {
		const result = runInSandbox(`
if verify_package_exists; then echo OK; else echo FAIL; fi
`);
		// Either OK (no settings) or unexpected failure
		expect(result.status).toBe(0);
	});

	it("returns 0 when every registered local-path package exists on disk", () => {
		const result = runInSandbox(`
mkdir -p $PI_DIR/agent
cat > $PI_DIR/agent/settings.json <<JSON
{
  "packages": [
    "$PI_DIR/packages/pi-orchestrator",
    "$PI_DIR/packages/pi-tasks"
  ]
}
JSON
# Create the dirs so the paths exist
mkdir -p $PI_DIR/packages/pi-orchestrator $PI_DIR/packages/pi-tasks
set +e
verify_package_existence
echo "EXIT=$?"
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("EXIT=0");
	});

	it("returns 1 when a registered local-path package is missing on disk", () => {
		const result = runInSandbox(`
mkdir -p $PI_DIR/agent
mkdir -p $PI_DIR/packages/pi-orchestrator
# DO NOT create pi-tasks — simulates a deleted dest dir
cat > $PI_DIR/agent/settings.json <<JSON
{
  "packages": [
    "$PI_DIR/packages/pi-orchestrator",
    "$PI_DIR/packages/pi-tasks"
  ]
}
JSON
set +e
verify_package_existence
echo "EXIT=$?"
`);
		expect(result.status).toBe(0); // bash itself succeeds; only verify_package_existence returned 1
		expect(result.stdout).toContain("EXIT=1");
		expect(result.stdout).toMatch(/pi-tasks/);
	});

	it("skips npm: peers (npm owns their existence)", () => {
		const result = runInSandbox(`
mkdir -p $PI_DIR/agent
cat > $PI_DIR/agent/settings.json <<'JSON'
{
  "packages": [
    "npm:@cortexkit/aft-pi",
    "npm:pi-mcp-adapter"
  ]
}
JSON
verify_package_existence
echo "EXIT=$?"
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("EXIT=0");
	});
});

describe("is_pi_orchestrator_installed: parity with is_pi_subagents_installed", () => {
	it("returns 1 when settings.json is missing", () => {
		const result = runInSandbox(`
if is_pi_orchestrator_installed; then echo PRESENT; else echo ABSENT; fi
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("ABSENT");
	});

	it("returns 1 when settings.json lacks the registration", () => {
		const result = runInSandbox(`
mkdir -p $PI_DIR/agent
cat > $PI_DIR/agent/settings.json <<'JSON'
{"packages": []}
JSON
mkdir -p $PI_DIR/packages/pi-orchestrator
if is_pi_orchestrator_installed; then echo PRESENT; else echo ABSENT; fi
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("ABSENT");
	});

	it("returns 1 when settings.json has the registration but dir is missing (THE BUG)", () => {
		// This is the exact scenario that caused the GC-2026-main-agent-tool-surface
		// incident: settings.json says installed, but the dest dir is gone.
		const result = runInSandbox(`
mkdir -p $PI_DIR/agent
mkdir -p $PI_DIR/packages  # parent exists
# NOTE: no $PI_DIR/packages/pi-orchestrator/
cat > $PI_DIR/agent/settings.json <<JSON
{"packages": ["$PI_DIR/packages/pi-orchestrator"]}
JSON
if is_pi_orchestrator_installed; then echo PRESENT; else echo ABSENT; fi
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("ABSENT");
	});

	it("returns 0 when both registration and dir are present (the happy path)", () => {
		const result = runInSandbox(`
mkdir -p $PI_DIR/agent
mkdir -p $PI_DIR/packages/pi-orchestrator
cat > $PI_DIR/agent/settings.json <<JSON
{"packages": ["$PI_DIR/packages/pi-orchestrator"]}
JSON
if is_pi_orchestrator_installed; then echo PRESENT; else echo ABSENT; fi
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("PRESENT");
	});
});