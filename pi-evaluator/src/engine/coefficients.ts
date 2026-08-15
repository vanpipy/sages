/**
 * pi-evaluator/src/engine/coefficients.ts
 *
 * Loader for `~/.pi/agent/evaluator-log/coefficients.json`.
 *
 * Resolution chain (first hit wins):
 *   1. Read the file from `<agentDir>/evaluator-log/coefficients.json`.
 *      `<agentDir>` is `$PI_DIR/agent` if `PI_DIR` is set, else
 *      `$HOME/.pi/agent`.
 *   2. If the file is missing → return `DEFAULT_COEFFICIENTS` (with
 *      `version` already pinned to `PI_EVALUATOR_VERSION`).
 *   3. If the file is present → JSON.parse, schema-validate, cross-field
 *      validate, then return.
 *
 * Error policy:
 *   - File missing → silent default (reward mode is opt-in; missing
 *     coefficients at first run is the expected state).
 *   - JSON malformed → throw (the user wrote something unparseable; they
 *     need to know).
 *   - Schema mismatch (TypeBox check) → throw with the first error path
 *     so the user can find the bad field.
 *   - Cross-field invariant broken (Σ weights ≠ 1.0, thresholds out of
 *     range, etc.) → throw with the offending dimension / threshold.
 *   - Version mismatch → WARN (returned as `warning` in the result), do
 *     NOT throw. The loader still returns the file's config so the
 *     scoring engine can run; the warning surfaces in `eval_score`
 *     output so the user knows their config may be stale.
 *
 * Two exports:
 *   - `loadCoefficientsAt(path)`: pure helper, takes an explicit path.
 *     Easier to test (no env manipulation) and used by debug tooling.
 *   - `loadCoefficients()`: env-driven wrapper used by extension.ts.
 *     Resolves the path via `resolveAgentDir()`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { PI_EVALUATOR_VERSION } from "./package-version.ts";
import {
	CoefficientsConfigSchema,
	DIMENSIONS,
	type CoefficientsConfig,
} from "./coefficients-schema.ts";
import { DEFAULT_COEFFICIENTS } from "./coefficients-defaults.ts";

/** Relative path under `<agentDir>` for the coefficients file. */
export const COEFFICIENTS_RELATIVE_PATH = join("evaluator-log", "coefficients.json");

/** Surfaced in `eval_score` output when the file's version doesn't match package.json. */
export interface VersionMismatchWarning {
	file_version: string | undefined;
	package_version: string;
	note: string;
}

/** Result of a successful load — always contains a `config`; warning is optional. */
export interface LoadCoefficientsResult {
	config: CoefficientsConfig;
	warning?: VersionMismatchWarning;
}

/**
 * Resolve the agent dir (parent of `evaluator-log/`) the way `readSagesRewardMode`
 * already does in `src/settings.ts`. `$PI_DIR` env wins so tests + sandboxed
 * installs can override without touching `$HOME`.
 */
function resolveAgentDir(): string {
	const fromPiEnv = process.env.PI_DIR;
	if (fromPiEnv && fromPiEnv.length > 0) return join(fromPiEnv, "agent");
	return join(homedir(), ".pi", "agent");
}

/**
 * Check cross-field invariants that TypeBox cannot express.
 *
 * Returns an array of human-readable error messages. Empty array = OK.
 * Each error references the field path so the user can find it in their
 * JSON.
 */
function validateInvariants(cfg: CoefficientsConfig): string[] {
	const errors: string[] = [];

	// Global: Σ dimension_weights = 1.0 (within float epsilon).
	const dwSum = DIMENSIONS.reduce((s, d) => s + cfg.global.dimension_weights[d], 0);
	if (Math.abs(dwSum - 1.0) > 1e-6) {
		errors.push(
			`global.dimension_weights must sum to 1.0 (got ${dwSum.toFixed(6)}); ` +
				`check that all 5 dimensions total 1.0`,
		);
	}

	// Per-dimension: Σ signal weights = 1.0.
	for (const dim of DIMENSIONS) {
		const dimCfg = cfg.dimensions[dim];
		if (!dimCfg) {
			// TypeBox should have caught this, but defend in depth — also surfaces
			// a friendlier message than "key required".
			errors.push(`dimensions.${dim} is missing entirely`);
			continue;
		}
		const signals = dimCfg.signals;
		const signalNames = Object.keys(signals);
		if (signalNames.length === 0) {
			errors.push(`dimensions.${dim}.signals is empty; at least one signal required`);
			continue;
		}
		const wSum = signalNames.reduce((s, name) => s + signals[name]!.weight, 0);
		if (Math.abs(wSum - 1.0) > 1e-6) {
			errors.push(
				`dimensions.${dim}.signals weights must sum to 1.0 (got ${wSum.toFixed(6)}); ` +
					`signals: ${signalNames.join(", ")}`,
			);
		}
	}

	// Thresholds: pass_with_gaps < pass (otherwise no dimension can ever be "pass").
	if (cfg.global.thresholds.pass_with_gaps >= cfg.global.thresholds.pass) {
		errors.push(
			`global.thresholds.pass_with_gaps (${cfg.global.thresholds.pass_with_gaps}) ` +
				`must be < pass (${cfg.global.thresholds.pass})`,
		);
	}

	return errors;
}

/**
 * Load coefficients from `path`. Pure function over the file system —
 * testable in isolation with a temp dir.
 *
 * @param path Absolute path to a coefficients.json file.
 * @returns `{ config, warning? }`. Throws on malformed JSON, schema
 *   mismatch, or invariant violation. Missing file → defaults, no throw.
 */
export function loadCoefficientsAt(path: string): LoadCoefficientsResult {
	if (!isAbsolute(path)) {
		throw new Error(`coefficients path must be absolute: got ${path}`);
	}

	// File missing → silent defaults.
	if (!existsSync(path)) {
		return { config: DEFAULT_COEFFICIENTS };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`coefficients.json is not valid JSON: ${message}`, { cause: err });
	}

	// Friendlier message than "Expected object" for the common JSON-shape
	// mistakes (array, null, string, number at top level). TypeBox would also
	// reject these, but its error path is `(root)` which doesn't help the user.
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("coefficients.json must be a JSON object");
	}

	// Missing version field → warn + coerce to current. This keeps old files
	// working without manual editing; the loader surfaces the warning either
	// way.
	let warning: VersionMismatchWarning | undefined;
	const rawObj = raw as { version?: unknown };
	if (rawObj.version === undefined) {
		warning = {
			file_version: undefined,
			package_version: PI_EVALUATOR_VERSION,
			note: `file has no "version" field; assumed ${PI_EVALUATOR_VERSION}. Re-run the init command to pin the version explicitly.`,
		};
		(rawObj as { version: string }).version = PI_EVALUATOR_VERSION;
	} else if (rawObj.version !== PI_EVALUATOR_VERSION) {
		warning = {
			file_version: String(rawObj.version),
			package_version: PI_EVALUATOR_VERSION,
			note:
				`file version "${String(rawObj.version)}" differs from pi-evaluator "${PI_EVALUATOR_VERSION}". ` +
				`Format may have drifted; review CHANGELOG.md and re-init if needed.`,
		};
	}

	// Shape check via TypeBox.
	if (!Value.Check(CoefficientsConfigSchema, raw)) {
		const errors = [...Value.Errors(CoefficientsConfigSchema, raw)];
		const first = errors[0];
		const where = first ? `${first.path || "(root)"}: ${first.message}` : "unknown";
		throw new Error(`coefficients.json shape invalid: ${where}`);
	}

	const cfg = raw as CoefficientsConfig;

	// Cross-field invariants.
	const invariantErrors = validateInvariants(cfg);
	if (invariantErrors.length > 0) {
		throw new Error(
			`coefficients.json invariants violated:\n  - ${invariantErrors.join("\n  - ")}`,
		);
	}

	return warning ? { config: cfg, warning } : { config: cfg };
}

/**
 * Load coefficients from `<agentDir>/evaluator-log/coefficients.json`. Wraps
 * `loadCoefficientsAt` with the standard agent-dir resolution (mirrors
 * `readSagesRewardMode` in `src/settings.ts`).
 */
export function loadCoefficients(): LoadCoefficientsResult {
	return loadCoefficientsAt(join(resolveAgentDir(), COEFFICIENTS_RELATIVE_PATH));
}
