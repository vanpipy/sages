/**
 * Tests for the profile / bundle composition loader — GC-2026-049 (T3.1).
 *
 * Profile loading is the single source of truth for soft-mode reminder
 * strings, the subagent whitelist, the isolation default, the DAG
 * recommendation threshold, and the gate suite. These tests pin the
 * resolution order (override > home > built-in default) and the schema
 * every built-in must satisfy.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import {
	loadProfile,
	loadBuiltInProfile,
	clearProfileCache,
	type Profile,
} from "@/profile.js";
import { softModeReminder, softModeSystemPromptSuffix } from "@/soft-mode.js";

const BUILTIN_IDS = ["light", "standard", "audit-strict", "ci-only"] as const;

describe("loadProfile — resolution order", () => {
	beforeEach(() => clearProfileCache());
	afterEach(() => clearProfileCache());

	it("returns standard by default when ~/.pi/profile.yaml is absent", () => {
		// Resolution: built-in standard fallback when no override path
		// is supplied and no home-level profile.yaml exists.
		const p = loadProfile();
		expect(p.id).toBe("standard");
	});

	it("loads each built-in by name via overridePath", () => {
		for (const name of BUILTIN_IDS) {
			const p = loadProfile(`pi/profiles/${name}.yaml`);
			expect(p.id).toBe(name);
		}
	});

	it("loadBuiltInProfile resolves each built-in directly", () => {
		for (const name of BUILTIN_IDS) {
			const p = loadBuiltInProfile(name);
			expect(p.id).toBe(name);
		}
	});

	it("explicit overridePath bypasses the cache (re-reads from disk)", () => {
		const standardA = loadProfile(`pi/profiles/standard.yaml`);
		const lightB = loadProfile(`pi/profiles/light.yaml`);
		expect(standardA.id).toBe("standard");
		expect(lightB.id).toBe("light");
		// Two distinct objects, since overridePath never poisons the cache.
		expect(standardA).not.toBe(lightB);
	});

	it("clearProfileCache forces re-load on next call", () => {
		const a = loadProfile();
		clearProfileCache();
		const b = loadProfile();
		expect(a.id).toBe(b.id);
	});
});

describe("profile schema — built-in validation", () => {
	for (const name of BUILTIN_IDS) {
		it(`${name}: has all required fields with the right types`, () => {
			const p = loadProfile(`pi/profiles/${name}.yaml`);
			expect(typeof p.id).toBe("string");
			expect(p.id.length).toBeGreaterThan(0);
			expect(typeof p.description).toBe("string");
			expect(Array.isArray(p.subagents)).toBe(true);
			expect(p.subagents.length).toBeGreaterThan(0);
			expect(["none", "current-workspace", "worktree"]).toContain(p.isolation_default);
			expect(typeof p.dag_threshold).toBe("number");
			expect(Number.isInteger(p.dag_threshold)).toBe(true);
			expect(p.dag_threshold).toBeGreaterThanOrEqual(0);
			expect(Array.isArray(p.gate_suite)).toBe(true);
			expect(typeof p.soft_mode_reminder).toBe("string");
			expect(typeof p.soft_mode_system_prompt_suffix).toBe("string");
		});
	}
});

describe("profile semantics — built-in invariants", () => {
	it("light profile restricts dispatch to read-only", () => {
		const p = loadProfile("pi/profiles/light.yaml");
		expect(p.subagents).toEqual(["Explore"]);
		expect(p.isolation_default).toBe("none");
		expect(p.gate_suite).toEqual([]);
	});

	it("standard profile has the full subagent roster", () => {
		const p = loadProfile("pi/profiles/standard.yaml");
		expect(p.subagents).toContain("Explore");
		expect(p.subagents).toContain("Plan");
		expect(p.subagents).toContain("developer");
		expect(p.subagents).toContain("auditor");
		expect(p.subagents).toContain("merger");
		expect(p.subagents).toContain("git-expert");
		expect(p.isolation_default).toBe("current-workspace");
		expect(p.dag_threshold).toBe(2);
	});

	it("audit-strict profile requires worktree isolation and adds verify:profile", () => {
		const p = loadProfile("pi/profiles/audit-strict.yaml");
		expect(p.isolation_default).toBe("worktree");
		expect(p.gate_suite).toContain("typecheck");
		expect(p.gate_suite).toContain("test");
		expect(p.gate_suite).toContain("verify:catalog");
		expect(p.gate_suite).toContain("verify:profile");
	});

	it("ci-only profile has empty soft_mode_reminder (silent in CI)", () => {
		const p = loadProfile("pi/profiles/ci-only.yaml");
		expect(p.soft_mode_reminder).toBe("");
		expect(p.subagents).toEqual(["auditor"]);
		expect(p.dag_threshold).toBeGreaterThanOrEqual(99);
	});
});

describe("soft-mode helpers — Profile-driven", () => {
	it("softModeReminder returns the profile's reminder string", () => {
		const p = loadProfile("pi/profiles/standard.yaml");
		expect(softModeReminder(p)).toBe(p.soft_mode_reminder);
	});

	it("softModeSystemPromptSuffix returns the profile's suffix string", () => {
		const p = loadProfile("pi/profiles/light.yaml");
		expect(softModeSystemPromptSuffix(p)).toBe(p.soft_mode_system_prompt_suffix);
		expect(softModeSystemPromptSuffix(p)).toContain("light profile");
	});

	it("ci-only softModeReminder is empty (no interactive nudge in CI)", () => {
		const p = loadProfile("pi/profiles/ci-only.yaml");
		expect(softModeReminder(p)).toBe("");
	});

	it("audit-strict softModeReminder calls out worktree isolation", () => {
		const p = loadProfile("pi/profiles/audit-strict.yaml");
		expect(softModeReminder(p)).toContain("AUDIT-STRICT");
		expect(softModeReminder(p)).toContain("worktree isolation");
	});
});

describe("profile.ts — validation (malformed input)", () => {
	beforeEach(() => clearProfileCache());
	afterEach(() => clearProfileCache());

	function tmpProfile(content: string): string {
		const path = `/tmp/profile-validation-${Math.random().toString(36).slice(2)}.yaml`;
		writeFileSync(path, content);
		return path;
	}

	it("rejects a profile missing required fields", () => {
		const path = tmpProfile("id: broken\ndescription: missing fields\n");
		expect(() => loadProfile(path)).toThrow(/profile missing required field/);
	});

	it("rejects an empty subagents array", () => {
		const path = tmpProfile(
			"id: broken\ndescription: empty roster\nsubagents: []\nisolation_default: none\ndag_threshold: 1\ngate_suite: []\nsoft_mode_reminder: \"\"\nsoft_mode_system_prompt_suffix: \"\"\n",
		);
		expect(() => loadProfile(path)).toThrow(/non-empty array/);
	});

	it("rejects an invalid isolation_default value", () => {
		const path = tmpProfile(
			"id: broken\ndescription: bad isolation\nsubagents: [Explore]\nisolation_default: totes-broken\ndag_threshold: 1\ngate_suite: []\nsoft_mode_reminder: \"\"\nsoft_mode_system_prompt_suffix: \"\"\n",
		);
		expect(() => loadProfile(path)).toThrow(/isolation_default invalid/);
	});

	it("rejects a non-integer dag_threshold", () => {
		const path = tmpProfile(
			"id: broken\ndescription: float threshold\nsubagents: [Explore]\nisolation_default: none\ndag_threshold: 1.5\ngate_suite: []\nsoft_mode_reminder: \"\"\nsoft_mode_system_prompt_suffix: \"\"\n",
		);
		expect(() => loadProfile(path)).toThrow(/dag_threshold/);
	});
});