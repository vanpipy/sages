/**
 * install-sages-routines-templates.test.ts — pins the fix that copies
 * the Sages routine template to BOTH the user-extensions dir AND the
 * local pi-routines sage peer's templates dir.
 *
 * Background (regression): `/routine-install sages-board-watch` used to
 * fail with "Template not found" because install.sh was copying the
 * template only to `$HOME/.pi/agent/extensions/routines/templates/`,
 * but `pi-routines` reads templates from its own source dir's bundled
 * location at `<pi-routines>/templates` (resolves via
 * `import.meta.url` in `src/types.ts` → `../templates`). The fix:
 * install_sages_routines_templates copies to BOTH locations, so
 * `/routine-install sages-board-watch` works AND the state.json seed
 * in install_sages_board_watch_routine still arms the watch by default.
 *
 * Post-fork (Sages pi-routines-fork-2026-Q1 GC): pi-routines is a
 * SAGES WORKSPACE PEER rather than an npm dependency. The "package's
 * bundled templates dir" is now `$PI_ROUTINES_DEST_DIR/templates` (the
 * file-copy install target at `~/.pi/packages/pi-routines/templates`),
 * NOT the historical `$PI_ROUTINES_NPM_DIR/templates` (`npm:@davecodes/
 * pi-routines/templates`). The dual-copy contract is preserved because
 * pi-routines reads templates via `import.meta.url` regardless of the
 * install path — the templates dir just needs to coexist with the
 * installed source tree.
 *
 * Pins:
 *   1. STATIC — the function + both destination constants exist in
 *      install.sh; the stale "not via the npm package" comment is gone.
 *   2. FUNCTIONAL — running the function in a sandboxed HOME copies
 *      the template to both destinations and is idempotent.
 *
 * Run: cd pi-orchestrator && bun test ./test/scripts/install-sages-routines-templates.test.ts
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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PI_ORCH_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(PI_ORCH_ROOT, "..");
const INSTALL_SH = join(PI_ORCH_ROOT, "scripts", "install.sh");

/** Build a sandbox that mirrors the PI_DIR layout + a fake Sages source dir. */
function buildSandbox(): string {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-orch-sages-routines-"));
	// Fake HOME (for $SAGES_ROUTINES_TEMPLATES_DEST).
	mkdirSync(join(sandbox, "home", "fakeuser"), { recursive: true });
	// Fake PI_DIR + the local sage peer package's templates dir
	// ($PI_ROUTINES_DEST_DIR/templates). Post-fork the pi-routines
	// extension lives at ~/.pi/packages/pi-routines (file-copy
	// install of the ./pi-routines/ sage workspace peer), so
	// `routine-install` reads templates from <peer>/templates.
	mkdirSync(join(sandbox, "pi", "packages", "pi-routines", "templates"), {
		recursive: true,
	});
	// Fake Sages source tree: $SCRIPT_DIR/../templates/sages-routines.
	mkdirSync(join(sandbox, "pi-orchestrator", "scripts"), { recursive: true });
	mkdirSync(join(sandbox, "pi-orchestrator", "templates", "sages-routines"), { recursive: true });
	writeFileSync(
		join(sandbox, "pi-orchestrator", "templates", "sages-routines", "sages-board-watch.json"),
		JSON.stringify(
			{
				name: "sages-board-watch",
				description: "test template",
				prompt: "test prompt",
				quiet: true,
				trigger: { kind: "pulse", interval: "30s" },
			},
			null,
			2,
		),
	);
	// Copy install.sh so we can source it in a sandboxed env.
	const contents = readFileSync(INSTALL_SH, "utf-8");
	writeFileSync(join(sandbox, "pi-orchestrator", "scripts", "install.sh"), contents, {
		mode: 0o755,
	});
	// Symlink the peer dirs so install.sh's sanity checks pass
	// (matches the pattern in install-aft-functions.test.ts).
	for (const peer of ["pi-codebase-memory", "pi-subagents", "pi-evaluator", "pi-routines"]) {
		const realPath = join(REPO_ROOT, peer);
		const linkPath = join(sandbox, peer);
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

let sandbox = "";
let sbHome = "";
let sbPi = "";

beforeEach(() => {
	sandbox = buildSandbox();
	sbHome = join(sandbox, "home", "fakeuser");
	sbPi = join(sandbox, "pi");
});

afterEach(() => {
	if (sandbox) {
		try {
			rmSync(sandbox, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

/**
 * Run a bash snippet with install.sh sourced (the main dispatch is
 * stripped, so only the function definitions are loaded). Mirrors
 * install-aft-functions.test.ts:runInSandbox.
 */
function runInSandbox(snippet: string): { stdout: string; stderr: string; status: number } {
	const scriptPath = join(sandbox, "pi-orchestrator", "scripts", "install.sh");
	const script = `
set -e
export HOME="${sbHome}"
export PI_DIR="${sbPi}"
export FORCE="\${FORCE:-false}"
export SCRIPT_DIR="${sandbox}/pi-orchestrator/scripts"
export LOCAL_REPO_ROOT="${sandbox}"
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

// ── STATIC: presence in install.sh ──────────────────────────────────────

describe("install.sh: Sages routines-templates constants", () => {
	const src = readFileSync(INSTALL_SH, "utf-8");

	it("declares SAGES_ROUTINES_TEMPLATES_DEST", () => {
		expect(src).toMatch(/^\s*SAGES_ROUTINES_TEMPLATES_DEST=/m);
	});

	it("declares SAGES_ROUTINES_TEMPLATES_PKG_DEST (the local pi-routines peer templates dir)", () => {
		expect(src).toMatch(/^\s*SAGES_ROUTINES_TEMPLATES_PKG_DEST=/m);
	});

	it("SAGES_ROUTINES_TEMPLATES_PKG_DEST is derived from PI_ROUTINES_DEST_DIR + /templates", () => {
		expect(src).toMatch(
			/SAGES_ROUTINES_TEMPLATES_PKG_DEST=.*PI_ROUTINES_DEST_DIR.*templates/,
		);
	});
});

describe("install.sh: install_sages_routines_templates function", () => {
	const src = readFileSync(INSTALL_SH, "utf-8");

	function fnBody(): string {
		const m = src.match(/^install_sages_routines_templates\s*\(\s*\)\s*\{[\s\S]+?^\}/m);
		if (!m) throw new Error("install_sages_routines_templates not found in install.sh");
		return m[0];
	}

	it("defines install_sages_routines_templates() {", () => {
		expect(src).toMatch(/^install_sages_routines_templates\s*\(\s*\)\s*\{/m);
	});

	it("the function references BOTH destination constants (the fix)", () => {
		const body = fnBody();
		expect(body).toContain("SAGES_ROUTINES_TEMPLATES_DEST");
		expect(body).toContain("SAGES_ROUTINES_TEMPLATES_PKG_DEST");
	});

	it("the function copies to the local pi-routines peer's templates dir (cp ... SAGES_ROUTINES_TEMPLATES_PKG_DEST)", () => {
		const body = fnBody();
		expect(body).toMatch(/cp\s+"\$src"\s+"\$SAGES_ROUTINES_TEMPLATES_PKG_DEST/);
	});

	it("the function tolerates a missing peer package dir (test -d before copy)", () => {
		const body = fnBody();
		expect(body).toMatch(/\[\[\s+-d\s+"\$SAGES_ROUTINES_TEMPLATES_PKG_DEST"\s+\]\]/);
	});

	it("the stale 'not via the npm package' comment is gone", () => {
		// The fix: the comment claiming routines reads from the extensions
		// dir (NOT via the package) was wrong. The corrected comment
		// should describe the dual-destination copy.
		const body = fnBody();
		expect(body).not.toMatch(/not via the npm package/);
	});
});

// ── FUNCTIONAL: run the function in a sandboxed HOME ────────────────────

describe("install_sages_routines_templates: behavior (sandboxed)", () => {
	it("copies the template to the user-extensions dir", () => {
		const result = runInSandbox(`
install_sages_routines_templates
if [[ -f "$SAGES_ROUTINES_TEMPLATES_DEST/sages-board-watch.json" ]]; then
  echo OK_EXT
else
  echo MISSING_EXT >&2
  exit 1
fi
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK_EXT");
	});

	it("copies the template to the local pi-routines peer's templates dir (the fix)", () => {
		const result = runInSandbox(`
install_sages_routines_templates
if [[ -f "$SAGES_ROUTINES_TEMPLATES_PKG_DEST/sages-board-watch.json" ]]; then
  echo OK_PKG
else
  echo MISSING_PKG >&2
  exit 1
fi
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK_PKG");
	});

	it("is idempotent (second run still leaves both files in place)", () => {
		const result = runInSandbox(`
install_sages_routines_templates
install_sages_routines_templates
[[ -f "$SAGES_ROUTINES_TEMPLATES_DEST/sages-board-watch.json" ]] && echo OK_EXT || { echo MISSING_EXT >&2; exit 1; }
[[ -f "$SAGES_ROUTINES_TEMPLATES_PKG_DEST/sages-board-watch.json" ]] && echo OK_PKG || { echo MISSING_PKG >&2; exit 1; }
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK_EXT");
		expect(result.stdout).toContain("OK_PKG");
	});

	it("survives a missing peer package dir (extensions copy still works)", () => {
		const result = runInSandbox(`
# Simulate the case where pi-routines isn't installed yet: the peer
# package dir doesn't exist. The function should still copy to the
# extensions dir without erroring.
rm -rf "$PI_ROUTINES_DEST_DIR"
install_sages_routines_templates
[[ -f "$SAGES_ROUTINES_TEMPLATES_DEST/sages-board-watch.json" ]] && echo OK_EXT || { echo MISSING_EXT >&2; exit 1; }
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK_EXT");
	});
});
