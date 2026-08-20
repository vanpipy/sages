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
import { mkdirSync, writeFileSync } from "node:fs";
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

/**
 * Cross-consistency + override-path tests — GC-2026-049 T3.2.
 *
 * These tests pin:
 *   1. Every built-in profile's `subagents` list is a subset of
 *      `pi/subagents/registry.yaml`'s id set (the same invariant the
 *      `verify:catalog` script enforces at the repo level).
 *   2. `loadProfile(overridePath)` reads the override path directly
 *      (and re-reads on every call — the cache is bypassed).
 *   3. `clearProfileCache()` actually clears the cache (a profile
 *      change between two `loadProfile()` calls is observable).
 *   4. `verifyProfileCrossConsistency()` (defined in
 *      `pi/scripts/verify-catalog.ts`) rejects a profile that
 *      references an unregistered subagent.
 *
 * Temp profile files live under `$JCODE_SCRATCH_DIR` when set,
 * `/tmp` otherwise; the test runner resolves `overridePath` from
 * `process.cwd()` (which is `pi/` when tests are invoked via
 * `bun test ./test`).
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as pathResolve } from "node:path";
import { verifyProfileCrossConsistency } from "../scripts/verify-catalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ROOT = pathResolve(__dirname, "..");
const SCRATCH_BASE = process.env.JCODE_SCRATCH_DIR ?? join(tmpdir(), "sages-profiles-test");
const PROFILES_DIR = join(PI_ROOT, "profiles");
const REGISTRY_PATH = join(PI_ROOT, "subagents", "registry.yaml");

function tmpProfilePath(name: string): string {
	// Ensure the scratch dir exists before writing into it (idempotent).
	mkdirSync(SCRATCH_BASE, { recursive: true });
	return join(SCRATCH_BASE, `profile-${name}-${Math.random().toString(36).slice(2)}.yaml`);
}

const minimalValidProfile = (subagents: string[]) =>
	`id: tmp\ndescription: temp profile for cross-consistency test\nsubagents: [${subagents.join(", ")}]\nisolation_default: none\ndag_threshold: 1\ngate_suite: []\nsoft_mode_reminder: ""\nsoft_mode_system_prompt_suffix: ""\n`;

describe("profile ↔ registry cross-consistency (GC-2026-049 T3.2)", () => {
	it("every built-in profile's subagents list is a subset of registry.yaml ids", () => {
		const result = verifyProfileCrossConsistency(PROFILES_DIR, REGISTRY_PATH);
		expect(result.ok).toBe(true);
		expect(result.unknown ?? []).toEqual([]);
	});

	it("rejects a profile that references an unregistered subagent", () => {
		const path = tmpProfilePath("unknown-subagent");
		try {
			// 'definitely-not-registered' is not in registry.yaml
			writeFileSync(path, minimalValidProfile(["Explore", "definitely-not-registered"]), "utf-8");
			// loadProfile validates the schema but does NOT check
			// against the registry — that is verifyProfileCrossConsistency's
			// job. We mirror the check by writing a temp profile to a
			// scratch directory and pointing the verifier at it.
			const scratchDir = pathResolve(path, "..");
			const result = verifyProfileCrossConsistency(scratchDir, REGISTRY_PATH);
			expect(result.ok).toBe(false);
			expect(result.error).toBeUndefined();
			expect(result.unknown).toEqual([
				{ profile: "tmp", subagent: "definitely-not-registered" },
			]);
		} finally {
			try {
				rmSync(path, { force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	it("rejects a profile whose subagents is not an array", () => {
		const path = tmpProfilePath("bad-shape");
		try {
			writeFileSync(
				path,
				'id: tmp\ndescription: bad shape\nsubagents: "Explore"\nisolation_default: none\ndag_threshold: 1\ngate_suite: []\nsoft_mode_reminder: ""\nsoft_mode_system_prompt_suffix: ""\n',
				"utf-8",
			);
			const scratchDir = pathResolve(path, "..");
			const result = verifyProfileCrossConsistency(scratchDir, REGISTRY_PATH);
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/subagents.*not an array/);
		} finally {
			try {
				rmSync(path, { force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});
});

describe("loadProfile — override path (GC-2026-049 T3.2)", () => {
	beforeEach(() => clearProfileCache());
	afterEach(() => clearProfileCache());

	it("loadProfile(overridePath) reads the override path directly", () => {
		const path = tmpProfilePath("override-read");
		try {
			writeFileSync(path, minimalValidProfile(["Explore"]), "utf-8");
			const p = loadProfile(path);
			expect(p.id).toBe("tmp");
			expect(p.subagents).toEqual(["Explore"]);
		} finally {
			try {
				rmSync(path, { force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	it("clearProfileCache forces a fresh read on the next loadProfile() call", () => {
		const path = tmpProfilePath("cache-invalidation");
		try {
			writeFileSync(path, minimalValidProfile(["Explore"]), "utf-8");
			// Prime the cache via the default lookup (no overridePath).
			const primed = loadProfile();
			expect(primed.id).toBe("standard");
			// Mutate the on-disk temp profile, then clear the cache and
			// re-load via overridePath. The mutated version should land
			// because overridePath bypasses the cache regardless.
			writeFileSync(path, minimalValidProfile(["Plan", "developer"]), "utf-8");
			const reloaded = loadProfile(path);
			expect(reloaded.subagents).toEqual(["Plan", "developer"]);
			// And clearProfileCache() also forces the default path to
			// re-read: loadProfile() with no args after clearProfileCache
			// should produce a fresh Profile object (same id, fresh ref).
			clearProfileCache();
			const a = loadProfile();
			clearProfileCache();
			const b = loadProfile();
			expect(a.id).toBe(b.id);
			// Two distinct objects — proof the cache was actually cleared.
			expect(a).not.toBe(b);
		} finally {
			try {
				rmSync(path, { force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});
});