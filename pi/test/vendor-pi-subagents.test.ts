/**
 * Intentional-fork invariants for the vendored pi-subagents package.
 *
 * The fork is expected to diverge from upstream: Sages adds its managed
 * worktree contract and Agent-boundary integration. These tests therefore
 * protect the fork's required source surface and package metadata rather than
 * asserting obsolete byte-for-byte upstream symmetry.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// pi/test/  →  sages/  →  sages/pi-subagents/
const SAGES_ROOT = path.resolve(__dirname, "..", "..");
const VENDORED = path.join(SAGES_ROOT, "pi-subagents");

describe("vendor: pi-subagents intentional fork", () => {
	// ── SC1: intentional source fork invariants ──────────────────────────
	describe("SC1 — managed-worktree fork source", () => {
		it("vendored src/ directory exists", () => {
			expect(fs.existsSync(path.join(VENDORED, "src"))).toBe(true);
		});

		it("contains the managed-worktree fork modules", () => {
			for (const file of ["worktree.ts", "worktree-contract.ts", "agent-manager.ts"]) {
				expect(fs.existsSync(path.join(VENDORED, "src", file))).toBe(true);
			}
		});

		it("records the fork boundary in package metadata", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			expect(pkg.name).toBe("@sages/pi-subagents");
			expect(pkg.description.startsWith("Sages fork — ")).toBe(true);
		});
	});

	// ── SC2: package.json metadata + peer-deps ───────────────────────────
	describe("SC2 — package.json metadata + 0.81.1 peer-dep pin", () => {
		it("vendored package.json exists and parses", () => {
			const p = path.join(VENDORED, "package.json");
			expect(fs.existsSync(p)).toBe(true);
			const raw = fs.readFileSync(p, "utf-8");
			expect(() => JSON.parse(raw)).not.toThrow();
		});

		it("name is @sages/pi-subagents (fork rename)", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			expect(pkg.name).toBe("@sages/pi-subagents");
		});

		it("author is vanpipy", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			expect(pkg.author).toBe("vanpipy");
		});

		it("repository.url points to vanpipy/sages.git", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			expect(pkg.repository).toBeDefined();
			expect(pkg.repository.url).toBe("https://github.com/vanpipy/sages.git");
		});

		it("homepage points to vanpipy/sages", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			expect(pkg.homepage).toBe("https://github.com/vanpipy/sages#readme");
		});

		it("bugs.url points to vanpipy/sages issues", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			expect(pkg.bugs).toBeDefined();
			expect(pkg.bugs.url).toBe("https://github.com/vanpipy/sages/issues");
		});

		it("description is prefixed with 'Sages fork — '", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			expect(pkg.description.startsWith("Sages fork — ")).toBe(true);
		});

		it("peerDependencies keys are all @earendil-works/*", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			expect(pkg.peerDependencies).toBeDefined();
			const keys = Object.keys(pkg.peerDependencies);
			expect(keys.length).toBeGreaterThan(0);
			for (const k of keys) {
				expect(k.startsWith("@earendil-works/")).toBe(true);
			}
		});

		it("peerDependencies values are all exactly '0.81.1' (matches upstream uncommitted pin + user runtime)", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			const expected = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
			for (const dep of expected) {
				expect(pkg.peerDependencies[dep]).toBe("0.81.1");
			}
		});

		it("dependencies (@sinclair/typebox, croner, nanoid) preserved as-is", () => {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(VENDORED, "package.json"), "utf-8"),
			);
			expect(pkg.dependencies["@sinclair/typebox"]).toBeDefined();
			expect(pkg.dependencies.croner).toBeDefined();
			expect(pkg.dependencies.nanoid).toBeDefined();
		});
	});

	// ── SC3: required files present, excluded files absent ────────────────
	describe("SC3 — required + excluded files at vendored root", () => {
		it("tsconfig.json present", () => {
			expect(fs.existsSync(path.join(VENDORED, "tsconfig.json"))).toBe(true);
		});

		it("LICENSE present", () => {
			expect(fs.existsSync(path.join(VENDORED, "LICENSE"))).toBe(true);
		});

		it(".gitignore present", () => {
			expect(fs.existsSync(path.join(VENDORED, ".gitignore"))).toBe(true);
		});

		// Exclusion list per task brief (15 items, case-sensitive on Linux).
		const excluded = [
			"examples",
			"README.md",
			"CHANGELOG.md",
			"CONTRIBUTING.md",
			"SECURITY.md",
			"media",
			"vitest.config.ts",
			"biome.json",
			".github",
			".pi",
			"package-lock.json",
		];

		for (const name of excluded) {
			it(`excluded: ${name} does NOT exist under pi-subagents/`, () => {
				expect(fs.existsSync(path.join(VENDORED, name))).toBe(false);
			});
		}
	});
});
