import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const { profileInc, readdirSyncSpy } = vi.hoisted(() => ({
	profileInc: vi.fn(),
	readdirSyncSpy: vi.fn(),
}));

vi.mock("node:fs", async () => {
	const actual = await import("node:fs");
	readdirSyncSpy.mockImplementation(actual.readdirSync);
	return { ...actual, readdirSync: readdirSyncSpy };
});

vi.mock("../src/profile.js", () => ({
	inc: profileInc,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => join(tmpdir(), "skill-loader-missing-agent-dir"),
}));

let preloadSkills: typeof import("../src/skill-loader.js").preloadSkills;
let clearSkillCache: () => void;
let getSkillCacheSize: () => number;

function writeSkill(cwd: string, name: string, content: string): void {
	const directory = join(cwd, ".pi", "skills", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "SKILL.md"), content);
}

describe("skill-loader TTL cache", () => {
	let cwd: string;

	beforeAll(async () => {
		const skillLoader = await import("../src/skill-loader.js");
		preloadSkills = skillLoader.preloadSkills;
		clearSkillCache = skillLoader._clearSkillCache;
		getSkillCacheSize = skillLoader._getSkillCacheSize;
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T00:00:00Z"));
		cwd = mkdtempSync(join(tmpdir(), "skill-loader-cache-"));
		clearSkillCache();
		profileInc.mockClear();
		readdirSyncSpy.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("T-SKL-01: reuses a same-cwd, same-name load within the TTL", () => {
		writeSkill(cwd, "search", "search instructions");
		const readdirSpy = readdirSyncSpy;

		expect(preloadSkills(["search"], cwd)[0]?.content).toBe(
			"search instructions",
		);
		expect(readdirSpy).toHaveBeenCalled();
		readdirSpy.mockClear();

		expect(preloadSkills(["search"], cwd)[0]?.content).toBe(
			"search instructions",
		);
		expect(readdirSpy).not.toHaveBeenCalled();
		expect(profileInc).toHaveBeenCalledWith("skill_preload_miss");
		expect(profileInc).toHaveBeenCalledWith("skill_preload_hit");
	});

	it("T-SKL-02: reloads after the five-minute TTL expires", () => {
		writeSkill(cwd, "search", "version one");
		expect(preloadSkills(["search"], cwd)[0]?.content).toBe("version one");
		writeSkill(cwd, "search", "version two");

		vi.advanceTimersByTime(5 * 60 * 1000 + 1);

		expect(preloadSkills(["search"], cwd)[0]?.content).toBe("version two");
		expect(profileInc).toHaveBeenCalledWith("skill_preload_miss");
		expect(profileInc).not.toHaveBeenCalledWith("skill_preload_hit");
	});

	it("T-SKL-03: isolates entries by cwd and skill name", () => {
		const cwd2 = mkdtempSync(join(tmpdir(), "skill-loader-cache-other-"));
		try {
			writeSkill(cwd, "alpha", "cwd one alpha");
			writeSkill(cwd, "beta", "cwd one beta");
			writeSkill(cwd2, "alpha", "cwd two alpha");

			expect(
				preloadSkills(["alpha", "beta"], cwd).map((skill) => skill.content),
			).toEqual(["cwd one alpha", "cwd one beta"]);
			expect(preloadSkills(["alpha"], cwd2)[0]?.content).toBe("cwd two alpha");
			expect(getSkillCacheSize()).toBe(3);
		} finally {
			rmSync(cwd2, { recursive: true, force: true });
		}
	});

	it("T-SKL-04: rejects unsafe names without caching them", () => {
		const result = preloadSkills(["../secret"], cwd)[0]?.content;

		expect(result).toContain("path traversal characters");
		expect(getSkillCacheSize()).toBe(0);
		expect(profileInc).not.toHaveBeenCalled();
	});

	it("T-SKL-05: caches the not-found sentinel", () => {
		mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
		const readdirSpy = readdirSyncSpy;

		const first = preloadSkills(["missing"], cwd)[0]?.content;
		expect(first).toContain('Skill "missing" not found');
		expect(readdirSpy).toHaveBeenCalled();
		readdirSpy.mockClear();

		expect(preloadSkills(["missing"], cwd)[0]?.content).toBe(first);
		expect(readdirSpy).not.toHaveBeenCalled();
		expect(getSkillCacheSize()).toBe(1);
	});

	it("T-SKL-06: exposes helpers that clear and report cache size", () => {
		writeSkill(cwd, "search", "search instructions");
		preloadSkills(["search"], cwd);
		expect(getSkillCacheSize()).toBe(1);

		clearSkillCache();

		expect(getSkillCacheSize()).toBe(0);
	});
});
