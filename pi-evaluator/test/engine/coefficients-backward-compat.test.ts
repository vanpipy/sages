/**
 * test/engine/coefficients-backward-compat.test.ts
 *
 * 0.2.0 → 0.3.0 schema migration: existing 0.2.0 coefficients files (no `with`
 * field on any signal) must still load and pass validation. The `with?`
 * field on SignalConfigSchema is Type.Optional — TypeBox must accept files
 * without it.
 *
 * We don't touch the user's actual ~/.pi/agent/evaluator-log/coefficients.json.
 * We use `loadCoefficientsAt(<tmp>)` with hand-written fixtures in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCoefficientsAt } from "../../src/engine/coefficients.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-eval-bwc-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a 5-dim 0.2.0 fixture — no `with` field anywhere. */
function v020Fixture(version: string): string {
	return JSON.stringify({
		version,
		global: {
			dimension_weights: {
				goal: 0.2,
				dag: 0.2,
				implement: 0.3,
				audit: 0.2,
				coordination: 0.1,
			},
			thresholds: { pass: 80, pass_with_gaps: 50 },
		},
		dimensions: {
			goal: {
				signals: {
					sc_verifiable_pct: { weight: 1, norm: "ratio_0_1", direction: "higher_better" },
				},
			},
			dag: {
				signals: {
					sc_to_task_coverage_pct: { weight: 1, norm: "ratio_0_1", direction: "higher_better" },
				},
			},
			implement: {
				signals: {
					verification_first_try_rate: { weight: 1, norm: "ratio_0_1", direction: "higher_better" },
				},
			},
			audit: {
				signals: {
					audit_pass_rate: { weight: 1, norm: "ratio_0_1", direction: "higher_better" },
				},
			},
			coordination: {
				signals: {
					dispatch_success_first_try_rate: { weight: 1, norm: "ratio_0_1", direction: "higher_better" },
				},
			},
		},
	});
}

function v030Fixture(): string {
	return JSON.stringify({
		version: "0.3.0",
		global: {
			dimension_weights: {
				goal: 0.2,
				dag: 0.2,
				implement: 0.3,
				audit: 0.2,
				coordination: 0.1,
			},
			thresholds: { pass: 80, pass_with_gaps: 50 },
		},
		dimensions: {
			goal: {
				signals: {
					sc_verifiable_pct: {
						weight: 1,
						norm: "ratio_0_1",
						direction: "higher_better",
						with: { criteria: "SC criterion verifiable?" },
					},
				},
			},
			dag: {
				signals: {
					sc_to_task_coverage_pct: { weight: 1, norm: "ratio_0_1", direction: "higher_better" },
				},
			},
			implement: {
				signals: {
					verification_first_try_rate: { weight: 1, norm: "ratio_0_1", direction: "higher_better" },
				},
			},
			audit: {
				signals: {
					audit_pass_rate: { weight: 1, norm: "ratio_0_1", direction: "higher_better" },
				},
			},
			coordination: {
				signals: {
					dispatch_success_first_try_rate: { weight: 1, norm: "ratio_0_1", direction: "higher_better" },
				},
			},
		},
	});
}

describe("0.2.0 → 0.3.0 backward compatibility", () => {
	test("0.2.0 fixture (no `with` field) loads and parses — version mismatch warning produced", () => {
		const path = join(tmpDir, "coefficients.json");
		writeFileSync(path, v020Fixture("0.2.0"));
		const { config, warning } = loadCoefficientsAt(path);
		expect(config.version).toBe("0.2.0");
		// After chunk 5 bumped the package to 0.3.0, a 0.2.0 file produces a
		// version-mismatch warning. The warning is non-fatal — the file still loads.
		expect(warning).toBeDefined();
		expect(warning?.file_version).toBe("0.2.0");
	});

	test("0.3.0 fixture (with `with` field) loads and parses", () => {
		const path = join(tmpDir, "coefficients.json");
		writeFileSync(path, v030Fixture());
		const { config } = loadCoefficientsAt(path);
		expect(config.version).toBe("0.3.0");
		// The file has sc_verifiable_pct with with: { criteria: "..." } — the parser
		// accepts it (proves the additive `with?` field works). We can't easily
		// get back the `with` because the inferred type strips it (TypeBox
		// Static + intersection drops Record<string, unknown>). The fact that
		// the file PARSES is the test signal.
	});
});
