/**
 * pi-evaluator/test/engine/package-version.test.ts
 *
 * RED-first: ensure PI_EVALUATOR_VERSION tracks package.json#version
 * exactly (character-for-character). The loader's mismatch check uses
 * `===` on this string; any drift (extra whitespace, different casing)
 * would silently trigger spurious warnings.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

import { PI_EVALUATOR_VERSION } from "../../src/engine/package-version.ts";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

describe("PI_EVALUATOR_VERSION (coefficients format version)", () => {
	test("equals pi-evaluator/package.json#version exactly", () => {
		expect(PI_EVALUATOR_VERSION).toBe(pkg.version);
	});

	test("is a non-empty semver-shaped string", () => {
		// Loose pattern: <digits>.<digits>.<digits> with optional pre-release.
		// Tighter than regex spec but loose enough to accept "0.2.0" and
		// future "0.2.0-alpha.1" without breaking on edge cases.
		expect(PI_EVALUATOR_VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/);
		expect(PI_EVALUATOR_VERSION.length).toBeGreaterThan(0);
	});
});
