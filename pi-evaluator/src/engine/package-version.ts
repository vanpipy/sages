/**
 * pi-evaluator/src/engine/package-version.ts
 *
 * Canonical version string for the coefficients format.
 *
 * The reward formula's schema version is the pi-evaluator package version
 * itself. There is no separate `schema_version` integer — every pi-evaluator
 * release IS a schema release. A user's `~/.pi/agent/evaluator-log/coefficients.json`
 * file declares the same `version` as pi-evaluator/package.json#version, and
 * the loader warns on mismatch.
 *
 * Rationale: a single source of truth. The package version is already
 * maintained (semver bumps on every release); duplicating it as a separate
 * integer risks drift.
 *
 * Why `createRequire` instead of `import pkg from "../package.json"`: ESM
 * does not allow importing JSON without an assertion or a loader hook, and
 * the project uses `moduleResolution: "bundler"` (TS) / bun (runtime) where
 * neither is guaranteed. `createRequire(import.meta.url)` is portable across
 * both.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The version of pi-evaluator currently running. Mirrors
 * `./package.json#version` at module-load time — TS reads the same file via
 * its own resolution, so they cannot drift as long as the relative path is
 * stable.
 *
 * Test contract: must equal `require("../../package.json").version` exactly,
 * character for character (so the loader's strict string-equality check on
 * the coefficients file works).
 */
export const PI_EVALUATOR_VERSION: string = (
	require("../../package.json") as { version: string }
).version;
