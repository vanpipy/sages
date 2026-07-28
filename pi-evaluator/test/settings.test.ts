/**
 * pi-evaluator/test/settings.test.ts
 *
 * RED-first: tests fail before src/settings.ts exists, pass after.
 *
 * Strategy: substitute `process.env.HOME` with a per-test tempdir containing
 * a synthesized settings.json (or absent). Function under test reads
 * `$HOME/.pi/agent/settings.json`. We also test the inner helper
 * `readSagesRewardModeAt(path)` which takes an explicit path — useful for
 * debugging without env juggling and keeping one pure-function entry point.
 *
 * Coverage:
 *   - file absent            → false (no throw)
 *   - malformed JSON         → false (no throw)
 *   - file present, no `sages`           → false
 *   - file present, `sages: {}`         → false
 *   - `sages.rewardMode = "true"` (str)  → false (strict === true check)
 *   - `sages.rewardMode = 1`             → false
 *   - `sages.rewardMode = true`          → true
 *   - `sages.rewardMode = false`         → false
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	readSagesRewardMode,
	readSagesRewardModeAt,
} from "../src/settings.ts";

let homeDir: string;
let originalHome: string | undefined;
let settingsPath: string;

beforeEach(() => {
	originalHome = process.env.HOME;
	homeDir = join(tmpdir(), `pi-evaluator-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(homeDir, { recursive: true });
	process.env.HOME = homeDir;
	settingsPath = join(homeDir, ".pi", "agent", "settings.json");
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(homeDir, { recursive: true, force: true });
});

describe("readSagesRewardModeAt (pure helper)", () => {
	test("returns false when file does not exist", () => {
		expect(readSagesRewardModeAt(settingsPath)).toBe(false);
	});

	test("returns false when file is malformed JSON", () => {
		mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
		writeFileSync(settingsPath, "{ not valid json", "utf8");
		expect(readSagesRewardModeAt(settingsPath)).toBe(false);
	});

	test("returns false when sages key absent", () => {
		mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ packages: [] }), "utf8");
		expect(readSagesRewardModeAt(settingsPath)).toBe(false);
	});

	test("returns false when sages.rewardMode missing", () => {
		mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ sages: {} }), "utf8");
		expect(readSagesRewardModeAt(settingsPath)).toBe(false);
	});

	test('returns false when sages.rewardMode === "true" (string, not boolean)', () => {
		mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ sages: { rewardMode: "true" } }), "utf8");
		expect(readSagesRewardModeAt(settingsPath)).toBe(false);
	});

	test("returns false when sages.rewardMode === 1 (number)", () => {
		mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ sages: { rewardMode: 1 } }), "utf8");
		expect(readSagesRewardModeAt(settingsPath)).toBe(false);
	});

	test("returns true when sages.rewardMode === true", () => {
		mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ sages: { rewardMode: true } }), "utf8");
		expect(readSagesRewardModeAt(settingsPath)).toBe(true);
	});

	test("returns false when sages.rewardMode === false", () => {
		mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ sages: { rewardMode: false } }), "utf8");
		expect(readSagesRewardModeAt(settingsPath)).toBe(false);
	});
});

describe("readSagesRewardMode (env-driven wrapper)", () => {
	test("reads from $HOME/.pi/agent/settings.json", () => {
		// Sanity: the wrapper is wired to process.env.HOME
		mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ sages: { rewardMode: true } }), "utf8");
		expect(readSagesRewardMode()).toBe(true);
	});

	test("returns false when $HOME/.pi/agent/settings.json missing", () => {
		expect(readSagesRewardMode()).toBe(false);
	});
});
