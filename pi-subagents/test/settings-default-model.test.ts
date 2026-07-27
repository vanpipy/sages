/**
 * settings-default-model.test.ts — Settings-driven model fallback helper.
 *
 * GC-2026-014 follow-up: the Agent dispatcher used to return "Model not found"
 * whenever the LLM passed an unresolvable model — most commonly Anthropic
 * fuzzy names ("haiku", "sonnet") on a non-Anthropic registry. The new policy
 * is to fall back to `defaultProvider` + `defaultModel` from pi's settings.json
 * (project overrides global), reading live at runtime.
 *
 * These tests pin:
 *
 *   1. The helper reads both project (<cwd>/.pi/settings.json) and global
 *      (<agentDir>/settings.json), with project winning on conflict.
 *   2. The helper returns `{ provider, model }` only when BOTH fields are
 *      present (and both are non-empty strings). A file missing either is
 *      treated as if the file had no default — undefined.
 *   3. Missing file → undefined. Malformed JSON → undefined. Non-object top
 *      level → undefined.
 *   4. Stat-cache invalidation: writing to either file re-reads on the next
 *      call (mtime-driven, the same pattern as `enabled-models.ts`).
 *   5. No hardcoded model id surfaces in production code — tests construct
 *      unique throwaway provider/model strings per run.
 *
 * Production code path: `getSettingsDefaultModel()` in
 * `pi-subagents/src/settings-default-model.ts`.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSettingsDefaultModel } from "../src/settings-default-model.js";

/**
 * Build a unique throwaway project directory under the OS temp dir. We
 * intentionally avoid hardcoding the user's `~/.pi/agent/` path because
 * that directory is shared across projects and would carry over the
 * current user's defaultProvider/defaultModel into the test — defeating
 * the "no hardcoded model in tests" invariant.
 *
 * Uses `process.env.PI_CODING_AGENT_DIR` to redirect `getAgentDir()` to
 * a sibling temp dir for the global read; the project's read uses
 * `<projectCwd>/.pi/settings.json` directly.
 */
function makeTempDirs(label: string): {
	project: string;
	global: string;
	envKey: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), `pi-sdm-${label}-`));
	const project = join(baseDir, "project");
	const global = join(baseDir, "global");
	// Folders must exist so JSON-path writing helpers work; the helper itself
	// should not depend on the directory pre-existing (it tolerates absence).
	return { project, global, envKey: "PI_CODING_AGENT_DIR" };
}

/**
 * Write JSON to `path`, creating any missing parent directories. Mirrors
 * how `pi/scripts/install.sh` and other callers assume the file location
 * exists — but for tests we want the file write to be the only side effect.
 */
function writeSettingsJson(path: string, body: object): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(body, null, 2), "utf-8");
}

describe("settings-default-model: precedence + happy path", () => {
	let dirs: ReturnType<typeof makeTempDirs>;
	let prevEnv: string | undefined;

	beforeEach(() => {
		dirs = makeTempDirs("happy");
		prevEnv = process.env[dirs.envKey];
		// Point getAgentDir() at the temp "global" dir so the helper reads from
		// there instead of the real ~/.pi/agent.
		process.env[dirs.envKey] = dirs.global;
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env[dirs.envKey];
		else process.env[dirs.envKey] = prevEnv;
		rmSync(dirs.project, { recursive: true, force: true });
		rmSync(dirs.global, { recursive: true, force: true });
	});

	it("returns the global default when the project has no settings file", () => {
		// Build a unique provider/model id per run so the test never asserts a
		// hardcoded model name — the GC-2026-014 invariant is "no model string
		// in production code", but the assertion still has to be specific.
		const provider = `test-provider-${Math.random().toString(16).slice(2, 10)}`;
		const model = `test-model-${Math.random().toString(16).slice(2, 10)}`;
		writeSettingsJson(join(dirs.global, "settings.json"), {
			defaultProvider: provider,
			defaultModel: model,
		});
		const got = getSettingsDefaultModel(dirs.project);
		expect(got).toEqual({ provider, model });
	});

	it("returns the project default when only the project file is set", () => {
		const provider = `proj-${Math.random().toString(16).slice(2, 10)}`;
		const model = `proj-${Math.random().toString(16).slice(2, 10)}`;
		// Mimic `<cwd>/.pi/settings.json` — the helper joins `${cwd}/.pi`.
		writeSettingsJson(join(dirs.project, ".pi", "settings.json"), {
			defaultProvider: provider,
			defaultModel: model,
		});
		const got = getSettingsDefaultModel(dirs.project);
		expect(got).toEqual({ provider, model });
	});

	it("project wins over global when both files are set", () => {
		const projProvider = `proj-${Math.random().toString(16).slice(2, 10)}`;
		const projModel = `proj-${Math.random().toString(16).slice(2, 10)}`;
		const globalProvider = `glb-${Math.random().toString(16).slice(2, 10)}`;
		const globalModel = `glb-${Math.random().toString(16).slice(2, 10)}`;
		writeSettingsJson(join(dirs.global, "settings.json"), {
			defaultProvider: globalProvider,
			defaultModel: globalModel,
		});
		writeSettingsJson(join(dirs.project, ".pi", "settings.json"), {
			defaultProvider: projProvider,
			defaultModel: projModel,
		});
		const got = getSettingsDefaultModel(dirs.project);
		expect(got).toEqual({ provider: projProvider, model: projModel });
	});
});

describe("settings-default-model: missing / malformed inputs", () => {
	let dirs: ReturnType<typeof makeTempDirs>;
	let prevEnv: string | undefined;

	beforeEach(() => {
		dirs = makeTempDirs("missing");
		prevEnv = process.env[dirs.envKey];
		process.env[dirs.envKey] = dirs.global;
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env[dirs.envKey];
		else process.env[dirs.envKey] = prevEnv;
		rmSync(dirs.project, { recursive: true, force: true });
		rmSync(dirs.global, { recursive: true, force: true });
	});

	it("returns undefined when neither project nor global settings.json exists", () => {
		expect(getSettingsDefaultModel(dirs.project)).toBeUndefined();
	});

	it("returns undefined when defaultProvider is present but defaultModel is missing", () => {
		writeSettingsJson(join(dirs.global, "settings.json"), {
			defaultProvider: "x-test-only",
		});
		expect(getSettingsDefaultModel(dirs.project)).toBeUndefined();
	});

	it("returns undefined when defaultModel is present but defaultProvider is missing", () => {
		writeSettingsJson(join(dirs.global, "settings.json"), {
			defaultModel: "x-test-only",
		});
		expect(getSettingsDefaultModel(dirs.project)).toBeUndefined();
	});

	it("returns undefined when defaultProvider is an empty string", () => {
		writeSettingsJson(join(dirs.global, "settings.json"), {
			defaultProvider: "",
			defaultModel: "x-test-only",
		});
		expect(getSettingsDefaultModel(dirs.project)).toBeUndefined();
	});

	it("returns undefined when the JSON is malformed", () => {
		mkdirSync(join(dirs.global), { recursive: true });
		writeFileSync(
			join(dirs.global, "settings.json"),
			"{not valid json",
			"utf-8",
		);
		expect(getSettingsDefaultModel(dirs.project)).toBeUndefined();
	});

	it("returns undefined when the top-level value is not an object", () => {
		mkdirSync(join(dirs.global), { recursive: true });
		writeFileSync(join(dirs.global, "settings.json"), "[]", "utf-8");
		expect(getSettingsDefaultModel(dirs.project)).toBeUndefined();
	});
});

describe("settings-default-model: stat-cache invalidation", () => {
	let dirs: ReturnType<typeof makeTempDirs>;
	let prevEnv: string | undefined;

	beforeEach(() => {
		dirs = makeTempDirs("cache");
		prevEnv = process.env[dirs.envKey];
		process.env[dirs.envKey] = dirs.global;
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env[dirs.envKey];
		else process.env[dirs.envKey] = prevEnv;
		rmSync(dirs.project, { recursive: true, force: true });
		rmSync(dirs.global, { recursive: true, force: true });
	});

	it("re-reads the file when the project's settings.json mtime advances", () => {
		const first = {
			provider: `first-${Math.random().toString(16).slice(2, 10)}`,
			model: `first-${Math.random().toString(16).slice(2, 10)}`,
		};
		const second = {
			provider: `second-${Math.random().toString(16).slice(2, 10)}`,
			model: `second-${Math.random().toString(16).slice(2, 10)}`,
		};
		const projectSettingsPath = join(dirs.project, ".pi", "settings.json");

		writeSettingsJson(projectSettingsPath, {
			defaultProvider: first.provider,
			defaultModel: first.model,
		});
		expect(getSettingsDefaultModel(dirs.project)).toEqual(first);

		// Some filesystems (e.g. ext4 with coarse mtime granularity) record the
		// same mtime for back-to-back writes; nudge the mtime forward explicitly
		// so the cache key genuinely changes.
		const FUTURE = (Date.now() + 5_000) / 1000;
		writeSettingsJson(projectSettingsPath, {
			defaultProvider: second.provider,
			defaultModel: second.model,
		});
		utimesSync(projectSettingsPath, FUTURE, FUTURE);

		expect(getSettingsDefaultModel(dirs.project)).toEqual(second);
	});

	it("re-reads the file when the global settings.json mtime advances", () => {
		const first = {
			provider: `gfirst-${Math.random().toString(16).slice(2, 10)}`,
			model: `gfirst-${Math.random().toString(16).slice(2, 10)}`,
		};
		const second = {
			provider: `gsecond-${Math.random().toString(16).slice(2, 10)}`,
			model: `gsecond-${Math.random().toString(16).slice(2, 10)}`,
		};
		const globalSettingsPath = join(dirs.global, "settings.json");

		writeSettingsJson(globalSettingsPath, {
			defaultProvider: first.provider,
			defaultModel: first.model,
		});
		expect(getSettingsDefaultModel(dirs.project)).toEqual(first);

		const FUTURE = (Date.now() + 5_000) / 1000;
		writeSettingsJson(globalSettingsPath, {
			defaultProvider: second.provider,
			defaultModel: second.model,
		});
		utimesSync(globalSettingsPath, FUTURE, FUTURE);

		expect(getSettingsDefaultModel(dirs.project)).toEqual(second);
	});
});
