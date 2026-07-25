/**
 * Vendor symmetry test for pi-subagents (SC1 + SC2 + SC3 — GC-2026-007).
 *
 * Asserts the vendored pi-subagents/ tree (under sages) is byte-identical
 * to the upstream ~/Project/pi-subagents tree, with package.json metadata
 * rewritten to the @sages/pi-subagents fork and peer-deps pinned to the
 * exact 0.81.1 version the user-side runtime is on.
 *
 * Path resolution uses __dirname-relative anchors so the test runs both
 * inside the agent worktree (e.g. /tmp/pi-agent-.../pi/test) AND in the
 * main worktree at /home/leroy/Project/sages/pi/test after merge. The
 * upstream path is hardcoded because the source-of-truth location is
 * fixed on disk.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// pi/test/  →  sages/  →  sages/pi-subagents/
const SAGES_ROOT = path.resolve(__dirname, "..", "..");
const VENDORED = path.join(SAGES_ROOT, "pi-subagents");

// Upstream source-of-truth (fixed on disk per task brief).
const UPSTREAM = "/home/leroy/Project/pi-subagents";

describe("vendor: pi-subagents symmetry (SC1+SC2+SC3)", () => {
	// ── SC1: src/ byte-identical + 29 .ts files ──────────────────────────
	describe("SC1 — src/ byte-identical to upstream", () => {
		it("vendored src/ directory exists", () => {
			expect(fs.existsSync(path.join(VENDORED, "src"))).toBe(true);
		});

		it("vendored src/ contains exactly 29 .ts files (matches upstream git ls-tree)", () => {
			const count = execSync(
				`find ${path.join(VENDORED, "src")} -name '*.ts' | wc -l`,
				{ encoding: "utf-8" },
			).trim();
			expect(count).toBe("29");
		});

		it("diff -rq upstream/src vendored/src is empty (byte-identical)", () => {
			// -r recursive, -q brief; non-empty output → files differ.
			const out = execSync(
				`diff -rq ${path.join(UPSTREAM, "src")} ${path.join(VENDORED, "src")}`,
				{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
			);
			expect(out).toBe("");
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
			"test",
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
			"node_modules",
			"bun.lock",
			"package-lock.json",
		];

		for (const name of excluded) {
			it(`excluded: ${name} does NOT exist under pi-subagents/`, () => {
				expect(fs.existsSync(path.join(VENDORED, name))).toBe(false);
			});
		}
	});
});
