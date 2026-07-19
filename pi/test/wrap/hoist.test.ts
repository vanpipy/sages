/**
 * Hoist mode tests — register wrap implementations under pi built-in names.
 *
 * When `hoist_builtin_tools: true` is in AFT config, the wrap layer should
 * re-register `read`, `write`, `edit`, `grep` so they OVERRIDE pi's built-ins
 * with AFT-backed versions. By default (hoist=false), only the `sages_*` names
 * are registered — backward compatible.
 *
 * These tests pin down:
 *   - hoist=false (default): only sages_* names register
 *   - hoist=true: pi built-in names (read, write, edit, grep) register as
 *     wrap implementations; sages_* aliases remain for backward compat
 *   - Config source precedence: project > user > default (false)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	loadHoistConfig,
	__resetHoistConfigCache,
} from "../../src/tools/wrap/hoist.js";

// ─── Mock pi (matches runtime-registration.test.ts pattern) ──────────────────

interface MockTool {
	name: string;
	description?: string;
}

class MockExtensionAPI {
	tools: MockTool[] = [];
	activeTools: string[] | null = null;
	registerTool = (tool: MockTool) => {
		this.tools.push(tool);
	};
	setActiveTools = (names: string[]) => {
		this.activeTools = names;
	};
	getActiveTools = () => {
		if (this.activeTools) return this.activeTools;
		return this.tools.map((t) => t.name);
	};
}

// ─── loadHoistConfig tests ───────────────────────────────────────────────────

describe("loadHoistConfig — config source resolution", () => {
	let tmpHome: string;
	let tmpProject: string;
	const savedHome = process.env.HOME;
	const savedXdg = process.env.XDG_CONFIG_HOME;

	beforeEach(() => {
		__resetHoistConfigCache();
		tmpHome = mkdtempSync(join(tmpdir(), "hoist-home-"));
		tmpProject = mkdtempSync(join(tmpdir(), "hoist-proj-"));
		process.env.HOME = tmpHome;
		delete process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		process.env.HOME = savedHome;
		if (savedXdg) process.env.XDG_CONFIG_HOME = savedXdg;
		rmSync(tmpHome, { recursive: true, force: true });
		rmSync(tmpProject, { recursive: true, force: true });
		__resetHoistConfigCache();
	});

	test("defaults to false when no config file exists", () => {
		const config = loadHoistConfig(tmpProject);
		expect(config.hoist_builtin_tools).toBe(false);
	});

	test("reads hoist_builtin_tools:true from user config (~/.config/cortexkit/aft.jsonc)", () => {
		const cfgDir = join(tmpHome, ".config", "cortexkit");
		require("node:fs").mkdirSync(cfgDir, { recursive: true });
		writeFileSync(
			join(cfgDir, "aft.jsonc"),
			`// user config\n{ "hoist_builtin_tools": true }\n`,
		);

		const config = loadHoistConfig(tmpProject);
		expect(config.hoist_builtin_tools).toBe(true);
	});

	test("project config overrides user config", () => {
		const userCfgDir = join(tmpHome, ".config", "cortexkit");
		require("node:fs").mkdirSync(userCfgDir, { recursive: true });
		writeFileSync(
			join(userCfgDir, "aft.jsonc"),
			`{ "hoist_builtin_tools": true }\n`,
		);

		const projCfgDir = join(tmpProject, ".cortexkit");
		require("node:fs").mkdirSync(projCfgDir, { recursive: true });
		writeFileSync(
			join(projCfgDir, "aft.jsonc"),
			`{ "hoist_builtin_tools": false }\n`,
		);

		const config = loadHoistConfig(tmpProject);
		expect(config.hoist_builtin_tools).toBe(false);
	});

	test("ignores comment lines and trailing commas (jsonc tolerance)", () => {
		const userCfgDir = join(tmpHome, ".config", "cortexkit");
		require("node:fs").mkdirSync(userCfgDir, { recursive: true });
		writeFileSync(
			join(userCfgDir, "aft.jsonc"),
			`// comment line\n/* block comment */\n{ "hoist_builtin_tools": true, /* trailing comma OK */ }\n`,
		);

		const config = loadHoistConfig(tmpProject);
		expect(config.hoist_builtin_tools).toBe(true);
	});
});

// ─── registerHoistedTools tests ──────────────────────────────────────────────

describe("registerHoistedTools — registration shape", () => {
	beforeEach(() => __resetHoistConfigCache());
	afterEach(() => __resetHoistConfigCache());

	test("with hoist=false, no built-in names (read/write/edit/grep) are registered", async () => {
		// Dynamically import so we can test the registration function in isolation
		const { registerHoistedTools } = await import(
			"../../src/tools/wrap/hoist.js"
		);
		const mock = new MockExtensionAPI();
		registerHoistedTools(mock as unknown as Parameters<typeof registerHoistedTools>[0], {
			hoist_builtin_tools: false,
		});

		const names = mock.tools.map((t) => t.name);
		expect(names).not.toContain("read");
		expect(names).not.toContain("write");
		expect(names).not.toContain("edit");
		expect(names).not.toContain("grep");
	});

	test("with hoist=true, all four built-in names are registered", async () => {
		const { registerHoistedTools } = await import(
			"../../src/tools/wrap/hoist.js"
		);
		const mock = new MockExtensionAPI();
		registerHoistedTools(mock as unknown as Parameters<typeof registerHoistedTools>[0], {
			hoist_builtin_tools: true,
		});

		const names = mock.tools.map((t) => t.name);
		for (const expected of ["read", "write", "edit", "grep"]) {
			expect(names).toContain(expected);
		}
	});

	test("with hoist=true, only the 4 hoisted tools register (not bash or others)", async () => {
		const { registerHoistedTools } = await import(
			"../../src/tools/wrap/hoist.js"
		);
		const mock = new MockExtensionAPI();
		registerHoistedTools(mock as unknown as Parameters<typeof registerHoistedTools>[0], {
			hoist_builtin_tools: true,
		});

		const names = mock.tools.map((t) => t.name);
		// Exactly 4 tools — read/write/edit/grep. No bash (not supported yet).
		expect(names.filter((n) => !n.startsWith("sages_")).length).toBe(4);
	});
});