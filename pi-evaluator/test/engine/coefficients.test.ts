/**
 * pi-evaluator/test/engine/coefficients.test.ts
 *
 * Loader coverage:
 *
 *   - missing file → silent defaults (no throw), no warning
 *   - file present, no `version` field → warning + load succeeds (coerced)
 *   - file present, version matches → no warning
 *   - file present, version differs → warning + load still succeeds
 *   - file present, malformed JSON → throw
 *   - file present, shape invalid (TypeBox) → throw with field path
 *   - file present, Σ signal weights ≠ 1.0 → throw with offending dimension
 *   - file present, Σ dimension_weights ≠ 1.0 → throw
 *   - file present, pass_with_gaps ≥ pass → throw
 *   - file present, missing dimension entirely → throw
 *   - file present, empty signals map → throw
 *   - relative path passed → throw (security: avoid accidental cwd-relative)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PI_EVALUATOR_VERSION } from "../../src/engine/package-version.ts";
import { loadCoefficientsAt } from "../../src/engine/coefficients.ts";
import { DEFAULT_COEFFICIENTS } from "../../src/engine/coefficients-defaults.ts";

let dir: string;
let path: string;

beforeEach(() => {
	dir = join(
		tmpdir(),
		`pi-evaluator-coefficients-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	path = join(dir, "coefficients.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("loadCoefficientsAt — file missing", () => {
	test("returns defaults silently, no warning", () => {
		const result = loadCoefficientsAt(path);
		expect(result.config).toEqual(DEFAULT_COEFFICIENTS);
		expect(result.warning).toBeUndefined();
	});
});

describe("loadCoefficientsAt — file present, version field", () => {
	test("matching version: no warning", () => {
		writeFileSync(path, JSON.stringify(DEFAULT_COEFFICIENTS, null, 2));
		const result = loadCoefficientsAt(path);
		expect(result.warning).toBeUndefined();
		expect(result.config.version).toBe(PI_EVALUATOR_VERSION);
	});

	test("missing version field: warning surfaces, config coerced to current version", () => {
		const raw = { ...DEFAULT_COEFFICIENTS } as Record<string, unknown>;
		delete raw.version;
		writeFileSync(path, JSON.stringify(raw));
		const result = loadCoefficientsAt(path);
		expect(result.warning).toBeDefined();
		expect(result.warning?.file_version).toBeUndefined();
		expect(result.warning?.package_version).toBe(PI_EVALUATOR_VERSION);
		expect(result.config.version).toBe(PI_EVALUATOR_VERSION);
	});

	test("version differs: warning surfaces, config still loaded", () => {
		const raw = { ...DEFAULT_COEFFICIENTS, version: "0.0.1-fake" };
		writeFileSync(path, JSON.stringify(raw));
		const result = loadCoefficientsAt(path);
		expect(result.warning).toBeDefined();
		expect(result.warning?.file_version).toBe("0.0.1-fake");
		expect(result.warning?.package_version).toBe(PI_EVALUATOR_VERSION);
		expect(result.config.version).toBe("0.0.1-fake");
	});

	test("version ahead of package: warning surfaces, config still loaded (no rejection)", () => {
		const raw = { ...DEFAULT_COEFFICIENTS, version: "99.0.0" };
		writeFileSync(path, JSON.stringify(raw));
		const result = loadCoefficientsAt(path);
		expect(result.warning).toBeDefined();
		expect(result.warning?.file_version).toBe("99.0.0");
		expect(result.warning?.note).toContain("may have drifted");
	});
});

describe("loadCoefficientsAt — JSON parse errors", () => {
	test("malformed JSON throws", () => {
		writeFileSync(path, "{ this is not json");
		expect(() => loadCoefficientsAt(path)).toThrow(/not valid JSON/);
	});

	test("top-level non-object throws", () => {
		writeFileSync(path, JSON.stringify([1, 2, 3]));
		expect(() => loadCoefficientsAt(path)).toThrow(/must be a JSON object/);
	});

	test("null at top level throws", () => {
		writeFileSync(path, "null");
		expect(() => loadCoefficientsAt(path)).toThrow(/must be a JSON object/);
	});
});

describe("loadCoefficientsAt — schema (TypeBox) errors", () => {
	test("missing dimension_weights dimension throws", () => {
		const raw = structuredClone(DEFAULT_COEFFICIENTS) as Record<string, unknown>;
		const global = raw.global as Record<string, unknown>;
		const dw = global.dimension_weights as Record<string, unknown>;
		delete dw.coordination;
		writeFileSync(path, JSON.stringify(raw));
		expect(() => loadCoefficientsAt(path)).toThrow(/shape invalid/);
	});

	test("signal weight out of [0,1] throws", () => {
		const raw = structuredClone(DEFAULT_COEFFICIENTS) as Record<string, unknown>;
		const dims = raw.dimensions as Record<string, { signals: Record<string, { weight: number }> }>;
		dims.goal!.signals.sc_verifiable_pct!.weight = 1.5;
		writeFileSync(path, JSON.stringify(raw));
		expect(() => loadCoefficientsAt(path)).toThrow(/shape invalid/);
	});

	test("unknown norm type throws", () => {
		const raw = structuredClone(DEFAULT_COEFFICIENTS) as Record<string, unknown>;
		const dims = raw.dimensions as Record<string, { signals: Record<string, { norm: string }> }>;
		dims.goal!.signals.sc_verifiable_pct!.norm = "ratio_0_99";
		writeFileSync(path, JSON.stringify(raw));
		expect(() => loadCoefficientsAt(path)).toThrow(/shape invalid/);
	});

	test("version field missing the digit pattern fails (after coerce it would pass)", () => {
		// The loader coerces missing → current; but an explicit NON-semver string
		// should fail TypeBox's pattern check.
		const raw = { ...DEFAULT_COEFFICIENTS, version: "not-semver" };
		writeFileSync(path, JSON.stringify(raw));
		expect(() => loadCoefficientsAt(path)).toThrow(/shape invalid/);
	});
});

describe("loadCoefficientsAt — cross-field invariants", () => {
	test("Σ signal weights per dimension must equal 1.0 — throws on deviation", () => {
		const raw = structuredClone(DEFAULT_COEFFICIENTS) as Record<string, unknown>;
		const dims = raw.dimensions as Record<string, { signals: Record<string, { weight: number }> }>;
		dims.goal!.signals.sc_verifiable_pct!.weight = 0.50; // was 0.40
		writeFileSync(path, JSON.stringify(raw));
		expect(() => loadCoefficientsAt(path)).toThrow(/invariants violated/);
		expect(() => loadCoefficientsAt(path)).toThrow(/dimensions\.goal/);
	});

	test("Σ dimension_weights must equal 1.0 — throws on deviation", () => {
		const raw = structuredClone(DEFAULT_COEFFICIENTS) as Record<string, unknown>;
		const global = raw.global as Record<string, unknown>;
		const dw = global.dimension_weights as Record<string, number>;
		dw.implement = 0.40; // was 0.30
		writeFileSync(path, JSON.stringify(raw));
		expect(() => loadCoefficientsAt(path)).toThrow(/dimension_weights must sum to 1/);
	});

	test("thresholds.pass_with_gaps must be < thresholds.pass — throws on inversion", () => {
		const raw = structuredClone(DEFAULT_COEFFICIENTS) as Record<string, unknown>;
		const global = raw.global as Record<string, unknown>;
		const t = global.thresholds as Record<string, number>;
		t.pass_with_gaps = 90; // > pass (80)
		writeFileSync(path, JSON.stringify(raw));
		expect(() => loadCoefficientsAt(path)).toThrow(/pass_with_gaps.*must be < pass/);
	});

	test("missing dimension entirely throws (after TypeBox would catch it, but defensive)", () => {
		const raw = structuredClone(DEFAULT_COEFFICIENTS) as Record<string, unknown>;
		const dims = raw.dimensions as Record<string, unknown>;
		delete dims.audit;
		writeFileSync(path, JSON.stringify(raw));
		expect(() => loadCoefficientsAt(path)).toThrow();
	});

	test("empty signals map throws with friendly message", () => {
		const raw = structuredClone(DEFAULT_COEFFICIENTS) as Record<string, unknown>;
		const dims = raw.dimensions as Record<string, { signals: Record<string, unknown> }>;
		dims.goal!.signals = {};
		writeFileSync(path, JSON.stringify(raw));
		expect(() => loadCoefficientsAt(path)).toThrow(/signals is empty/);
	});
});

describe("loadCoefficientsAt — path validation", () => {
	test("relative path throws (security: avoid cwd-relative loads)", () => {
		expect(() => loadCoefficientsAt("coefficients.json")).toThrow(/must be absolute/);
	});
});
