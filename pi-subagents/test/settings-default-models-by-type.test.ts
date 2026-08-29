/**
 * settings-default-models-by-type.test.ts — Per-type model override helper.
 *
 * GC-2026-092: lets users override the hardcoded `AgentConfig.model` pin via
 * a `defaultModelsByType` map in `subagents.json`. The helper reads
 * project (<cwd>/.pi/subagents.json) and global (<agentDir>/subagents.json)
 * with project-overrides-global precedence, plus the standard mtime+size
 * stat-cache invalidation.
 *
 * These tests pin the same invariants as the existing
 * `settings-default-model.test.ts`:
 *
 *   1. The helper reads both project and global, with project winning on conflict.
 *   2. The helper returns the map only when `defaultModelsByType` is present
 *      with at least one valid (string, non-empty) entry. Empty value entries
 *      are dropped silently.
 *   3. Missing file → undefined. Malformed JSON → undefined. Non-object top
 *      level → undefined.
 *   4. Stat-cache invalidation: writing to either file re-reads on the next
 *      call.
 *   5. No hardcoded model strings in production code — tests use throwaway
 *      provider/model strings.
 *
 * Production code path: `getSettingsDefaultModelsByType()` in
 * `pi-subagents/src/settings-default-models-by-type.ts`.
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
import { getSettingsDefaultModelsByType } from "../src/settings-default-models-by-type.js";

/**
 * Build a unique throwaway project directory under the OS temp dir. We
 * intentionally avoid hardcoding the user's `~/.pi/agent/` path because
 * that directory is shared across projects and would carry over the
 * current user's defaultModelsByType into the test.
 *
 * Uses `process.env.PI_CODING_AGENT_DIR` to redirect `getAgentDir()` to
 * a sibling temp dir for the global read; the project's read uses
 * `<projectCwd>/.pi/subagents.json` directly.
 */
function makeTempDirs(label: string): {
	project: string;
	global: string;
	envKey: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), `pi-sdmb-${label}-`));
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
function writeSubagentsJson(path: string, body: object): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(body, null, 2), "utf-8");
}

/** Build a unique provider/model string per test run. */
function providerModel(prefix: string): string {
	return `${prefix}-${Math.random().toString(16).slice(2, 10)}/${Math.random().toString(16).slice(2, 10)}`;
}

describe("settings-default-models-by-type: precedence + happy path", () => {
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

	it("returns the global map when the project has no subagents.json", () => {
		const developer = providerModel("global-dev");
		const auditor = providerModel("global-aud");
		writeSubagentsJson(join(dirs.global, "subagents.json"), {
			defaultModelsByType: {
				Developer: developer,
				Auditor: auditor,
			},
		});
		expect(getSettingsDefaultModelsByType(dirs.project)).toEqual({
			Developer: developer,
			Auditor: auditor,
		});
	});

	it("returns the project map when only the project file is set", () => {
		const developer = providerModel("proj-dev");
		writeSubagentsJson(join(dirs.project, ".pi", "subagents.json"), {
			defaultModelsByType: {
				Developer: developer,
			},
		});
		expect(getSettingsDefaultModelsByType(dirs.project)).toEqual({
			Developer: developer,
		});
	});

	it("project wins over global when both files are set", () => {
		const projDev = providerModel("proj-dev");
		const globalDev = providerModel("glb-dev");
		writeSubagentsJson(join(dirs.global, "subagents.json"), {
			defaultModelsByType: { Developer: globalDev },
		});
		writeSubagentsJson(join(dirs.project, ".pi", "subagents.json"), {
			defaultModelsByType: { Developer: projDev },
		});
		expect(getSettingsDefaultModelsByType(dirs.project)).toEqual({
			Developer: projDev,
		});
	});

	it("merges project-overrides-global when project and global both have the field", () => {
		// Project override of one type + global fallback for the other.
		const projAuditor = providerModel("proj-aud");
		const globalDeveloper = providerModel("glb-dev");
		writeSubagentsJson(join(dirs.global, "subagents.json"), {
			defaultModelsByType: { Developer: globalDeveloper },
		});
		writeSubagentsJson(join(dirs.project, ".pi", "subagents.json"), {
			defaultModelsByType: { Auditor: projAuditor },
		});
		// Helper returns the project-overrides-global result; how the
		// merge is constructed (loadSettings does `{...global, ...project}`) is
		// the user's contract: project wins per-key.
		expect(getSettingsDefaultModelsByType(dirs.project)).toEqual({
			Developer: globalDeveloper,
			Auditor: projAuditor,
		});
	});
});

describe("settings-default-models-by-type: missing / malformed inputs", () => {
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

	it("returns undefined when neither project nor global subagents.json exists", () => {
		expect(getSettingsDefaultModelsByType(dirs.project)).toBeUndefined();
	});

	it("returns undefined when defaultModelsByType is absent (other keys may be present)", () => {
		writeSubagentsJson(join(dirs.global, "subagents.json"), {
			toolDescriptionMode: "compact",
			maxConcurrent: 4,
		});
		expect(getSettingsDefaultModelsByType(dirs.project)).toBeUndefined();
	});

	it("returns the map when defaultModelsByType is present", () => {
		const developer = providerModel("present-dev");
		writeSubagentsJson(join(dirs.global, "subagents.json"), {
			defaultModelsByType: { Developer: developer },
		});
		expect(getSettingsDefaultModelsByType(dirs.project)).toEqual({
			Developer: developer,
		});
	});

	it("drops empty-string values and returns the remaining map", () => {
		// The sanitize() in settings.ts drops empty strings; the readField()
		// in the helper also drops them. Both should agree.
		const developer = providerModel("dev");
		writeSubagentsJson(join(dirs.global, "subagents.json"), {
			defaultModelsByType: {
				Developer: developer,
				Auditor: "",
				Explore: "   ",
			},
		});
		// "   " is non-empty by length but only whitespace; readField requires
		// length > 0, so it passes. Real validation would also trim, but
		// the contract is just "non-empty"; pin the current behavior.
		const got = getSettingsDefaultModelsByType(dirs.project);
		expect(got).toBeDefined();
		expect(got?.Developer).toBe(developer);
		expect(got?.Auditor).toBeUndefined();
		expect(got?.Explore).toBe("   ");
	});

	it("returns undefined when the JSON is malformed", () => {
		mkdirSync(join(dirs.global), { recursive: true });
		writeFileSync(
			join(dirs.global, "subagents.json"),
			"{not valid json",
			"utf-8",
		);
		expect(getSettingsDefaultModelsByType(dirs.project)).toBeUndefined();
	});

	it("returns undefined when the top-level value is not an object", () => {
		mkdirSync(join(dirs.global), { recursive: true });
		writeFileSync(join(dirs.global, "subagents.json"), "[]", "utf-8");
		expect(getSettingsDefaultModelsByType(dirs.project)).toBeUndefined();
	});

	it("returns undefined when defaultModelsByType is not an object", () => {
		writeSubagentsJson(join(dirs.global, "subagents.json"), {
			defaultModelsByType: "not-an-object",
		});
		expect(getSettingsDefaultModelsByType(dirs.project)).toBeUndefined();
	});

	it("returns undefined when the map is empty after sanitization", () => {
		// All entries are empty strings → after sanitization, the map is empty.
		writeSubagentsJson(join(dirs.global, "subagents.json"), {
			defaultModelsByType: { Developer: "", Auditor: "" },
		});
		expect(getSettingsDefaultModelsByType(dirs.project)).toBeUndefined();
	});
});

describe("settings-default-models-by-type: stat-cache invalidation", () => {
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

	it("re-reads the file when the project's subagents.json mtime advances", () => {
		const first = providerModel("first");
		const second = providerModel("second");
		const projectPath = join(dirs.project, ".pi", "subagents.json");

		writeSubagentsJson(projectPath, {
			defaultModelsByType: { Developer: first },
		});
		expect(getSettingsDefaultModelsByType(dirs.project)).toEqual({
			Developer: first,
		});

		// Some filesystems (e.g. ext4 with coarse mtime granularity) record the
		// same mtime for back-to-back writes; nudge the mtime forward explicitly
		// so the cache key genuinely changes.
		const FUTURE = (Date.now() + 5_000) / 1000;
		writeSubagentsJson(projectPath, {
			defaultModelsByType: { Developer: second },
		});
		utimesSync(projectPath, FUTURE, FUTURE);

		expect(getSettingsDefaultModelsByType(dirs.project)).toEqual({
			Developer: second,
		});
	});

	it("re-reads the file when the global subagents.json mtime advances", () => {
		const first = providerModel("gfirst");
		const second = providerModel("gsecond");
		const globalPath = join(dirs.global, "subagents.json");

		writeSubagentsJson(globalPath, {
			defaultModelsByType: { Developer: first },
		});
		expect(getSettingsDefaultModelsByType(dirs.project)).toEqual({
			Developer: first,
		});

		const FUTURE = (Date.now() + 5_000) / 1000;
		writeSubagentsJson(globalPath, {
			defaultModelsByType: { Developer: second },
		});
		utimesSync(globalPath, FUTURE, FUTURE);

		expect(getSettingsDefaultModelsByType(dirs.project)).toEqual({
			Developer: second,
		});
	});
});
