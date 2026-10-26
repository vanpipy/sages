/**
 * install-system-prompt.test.ts — the GLOBAL policy install path.
 *
 * `templates/SYSTEM.md` is not a repo-local file: `scripts/install.sh`
 * copies it to `$AGENT_DIR/SYSTEM.md` (`~/.pi/agent/SYSTEM.md`), and pi
 * loads that path as the base system prompt for every session in every
 * project (`pi-coding-agent/dist/core/resource-loader.js:808`
 * `discoverSystemPromptFile`). Two consequences this file pins:
 *
 *   1. A copy THIS installer wrote must be refreshed on every install
 *      run — a stale global policy is read by every pi session, so
 *      "already exists, skip" would leave the whole runtime on an
 *      outdated policy forever.
 *   2. A copy the user hand-edited must be preserved (NEVER-TOUCH),
 *      exactly like the other templated user files
 *      (`agent-tool-description.md`, `aft.jsonc`).
 *
 * The two are told apart by the `SAGES_TEMPLATE_V1` sentinel the template
 * carries in an HTML comment — the same pattern the AFT config and the
 * Agent tool description already use.
 *
 * Run: cd pi-orchestrator && bun test ./test/scripts/install-system-prompt.test.ts
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
const SYSTEM_TEMPLATE = join(PI_ORCH_ROOT, "templates", "SYSTEM.md");

const SENTINEL = "SAGES_TEMPLATE_V1";

let sandbox = "";
let sbHome = "";
let sbPi = "";
let agentDir = "";

function buildSandbox(): string {
	const box = mkdtempSync("sages-system-prompt-install-test-");
	mkdirSync(join(box, "pi-orchestrator", "templates"), { recursive: true });
	mkdirSync(join(box, "pi-orchestrator", "scripts"), { recursive: true });
	mkdirSync(join(box, "home", "fakeuser"), { recursive: true });
	mkdirSync(join(box, "pi"), { recursive: true });

	// The sandbox gets its own copy of the template so a test can mutate
	// the source without touching the real repo.
	writeFileSync(
		join(box, "pi-orchestrator", "templates", "SYSTEM.md"),
		readFileSync(SYSTEM_TEMPLATE),
	);

	// Copy (not symlink) the installer so it can be re-sourced freely.
	writeFileSync(
		join(box, "pi-orchestrator", "scripts", "install.sh"),
		readFileSync(INSTALL_SH, "utf-8"),
		{ mode: 0o755 },
	);

	// The peer dirs install.sh's LOCAL_REPO_ROOT sanity check requires.
	for (const peer of [
		"pi-codebase-memory",
		"pi-subagents",
		"pi-evaluator",
		"pi-routines",
		"pi-sidebar",
	]) {
		const real = join(REPO_ROOT, peer);
		if (!existsSync(real)) continue;
		try {
			symlinkSync(real, join(box, peer), "dir");
		} catch {
			// Some CI envs disallow symlinks — the sanity check then fails
			// loudly inside install.sh, which the test surfaces.
		}
	}

	return box;
}

beforeEach(() => {
	sandbox = buildSandbox();
	sbHome = join(sandbox, "home", "fakeuser");
	sbPi = join(sandbox, "pi");
	agentDir = join(sbPi, "agent");
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

/** Run a snippet with install.sh sourced (main() patched out). */
function runInSandbox(
	snippet: string,
	force = false,
): { stdout: string; stderr: string; status: number } {
	const script = `
set -e
export HOME="${sbHome}"
export PI_DIR="${sbPi}"
export FORCE="${force ? "true" : "false"}"
export SCRIPT_DIR="${sandbox}/pi-orchestrator/scripts"
export LOCAL_REPO_ROOT="${sandbox}"
sed 's|^main .*$||' "${sandbox}/pi-orchestrator/scripts/install.sh" > "${sandbox}/_sourced.sh"
source "${sandbox}/_sourced.sh"
${snippet}
`;
	const result = spawnSync("bash", ["-c", script], {
		encoding: "utf-8",
		env: { ...process.env, PATH: process.env.PATH ?? "" },
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? 1,
	};
}

const installedPath = () => join(agentDir, "SYSTEM.md");

describe("install.sh — the global SYSTEM.md policy", () => {
	it("installs the template on a fresh prefix", () => {
		const res = runInSandbox("install_system_prompt");
		expect(res.status).toBe(0);
		expect(existsSync(installedPath())).toBe(true);
		const installed = readFileSync(installedPath(), "utf-8");
		const template = readFileSync(SYSTEM_TEMPLATE, "utf-8");
		expect(installed).toBe(template);
		expect(installed).toContain(SENTINEL);
	});

	it("refreshes a managed copy so the global policy stays current", () => {
		// Simulate an installed copy from an older release: it carries the
		// sentinel (we wrote it) but its text is out of date.
		writeFileSync(
			installedPath(),
			`<!--\n    ${SENTINEL} — managed by pi-orchestrator/scripts/install.sh.\n-->\n\n# Sages — Orchestrator Operating Policy\n\nOLD\n`,
		);
		const res = runInSandbox("install_system_prompt");
		expect(res.status).toBe(0);
		const installed = readFileSync(installedPath(), "utf-8");
		expect(installed).toBe(readFileSync(SYSTEM_TEMPLATE, "utf-8"));
		expect(installed).not.toContain("OLD");
	});

	it("preserves a user-customized copy (no sentinel) and says so", () => {
		writeFileSync(installedPath(), "# My own policy\n\nHAND EDITED\n");
		const res = runInSandbox("install_system_prompt");
		expect(res.status).toBe(0);
		expect(readFileSync(installedPath(), "utf-8")).toContain("HAND EDITED");
		expect(res.stdout).toContain("user-customized");
	});

	it("overwrites a user-customized copy under --force", () => {
		writeFileSync(installedPath(), "# My own policy\n\nHAND EDITED\n");
		const res = runInSandbox("install_system_prompt", true);
		expect(res.status).toBe(0);
		expect(readFileSync(installedPath(), "utf-8")).toBe(
			readFileSync(SYSTEM_TEMPLATE, "utf-8"),
		);
	});

	it("fails loud when the template is missing", () => {
		rmSync(join(sandbox, "pi-orchestrator", "templates", "SYSTEM.md"));
		const res = runInSandbox("install_system_prompt");
		expect(res.status).not.toBe(0);
		expect(res.stdout + res.stderr).toContain("template not found");
	});

	it("upgrades a legacy pre-sentinel copy and keeps a backup", () => {
		// Copies installed before the sentinel existed carry one of the old
		// policy titles. They must not be left in place: pi would keep
		// reading the stale Sages-scoped policy in every project.
		writeFileSync(installedPath(), "# Sages — Orchestrator Constitution\n\nOLD\n");
		const res = runInSandbox("install_system_prompt");
		expect(res.status).toBe(0);
		expect(readFileSync(installedPath(), "utf-8")).toBe(
			readFileSync(SYSTEM_TEMPLATE, "utf-8"),
		);
		// The previous copy is kept, so any local edit survives.
		const backup = join(agentDir, "SYSTEM.md.pre-global.bak");
		expect(existsSync(backup)).toBe(true);
		expect(readFileSync(backup, "utf-8")).toContain(
			"# Sages — Orchestrator Constitution",
		);
	});

	it("removes a managed copy on uninstall, keeps a user-customized one", () => {
		writeFileSync(
			installedPath(),
			`<!--\n    ${SENTINEL} — managed by pi-orchestrator/scripts/install.sh.\n-->\n\n# Sages — Orchestrator Operating Policy\n\nOLD\n`,
		);
		const managed = runInSandbox("uninstall_system_prompt");
		expect(managed.status).toBe(0);
		expect(existsSync(installedPath())).toBe(false);

		writeFileSync(installedPath(), "# My own policy\n");
		const customized = runInSandbox("uninstall_system_prompt");
		expect(customized.status).toBe(0);
		expect(existsSync(installedPath())).toBe(true);
	});

	it("removes a legacy copy on uninstall and backs it up", () => {
		writeFileSync(installedPath(), "# Sages — Orchestrator Constitution\n\nOLD\n");
		const res = runInSandbox("uninstall_system_prompt");
		expect(res.status).toBe(0);
		expect(existsSync(installedPath())).toBe(false);
		expect(existsSync(join(agentDir, "SYSTEM.md.pre-global.bak"))).toBe(true);
	});
});
