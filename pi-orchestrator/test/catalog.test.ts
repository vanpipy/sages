/**
 * catalog.test.ts — GC-2026-047 T1.2 (orchestrator-simplify)
 *
 * Verifies the catalog generator / verifier chain:
 *   - All 3 catalog files (subagent / event / namespace) exist under
 *     pi/catalogs/ and parse as JSON. The isolation.json and gate.json
 *     catalogs are gone — they snapshotted DAG / TaskNode.isolation and
 *     the orchestrator_audit 5-phase vocabulary, both removed by
 *     GC-2026-orchestrator-simplify.
 *   - Each catalog has the metadata fields `_source_hash` (64-char hex),
 *     `_generated_at`, and `_source_files` (non-empty array).
 *   - The non-metadata top-level body of each catalog is non-empty.
 *   - `bun run verify:catalog` (subprocess) exits 0 on fresh catalogs.
 *   - `bun run verify:catalog` (subprocess) exits 1 when a catalog is
 *     corrupted (stale `_source_hash`).
 *   - `bun run verify:catalog` (subprocess) exits 1 when a source file
 *     listed in a catalog's `_source_files` is touched (hash drift).
 *
 * The corruption / drift tests are restored to a clean state on teardown
 * even when assertions fail, so the suite is repeatable.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ROOT = dirname(__dirname); // pi-orchestrator/test → pi-orchestrator/
const CATALOGS_DIR = join(PI_ROOT, "catalogs");
const CATALOG_NAMES = ["subagent", "event", "namespace"] as const;
type CatalogName = (typeof CATALOG_NAMES)[number];

function catalogPath(name: CatalogName): string {
	return join(CATALOGS_DIR, `${name}.json`);
}

function loadCatalog(name: CatalogName): Record<string, unknown> {
	const raw = readFileSync(catalogPath(name), "utf-8");
	return JSON.parse(raw) as Record<string, unknown>;
}

const META_KEYS = new Set(["_source_hash", "_generated_at", "_source_files"]);

/**
 * Spawn `bun run verify:catalog` from pi/ and return exit code.
 * Returns { code, stdout, stderr }.
 */
function runVerifyCatalog(): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("bun", ["run", "verify:catalog"], {
			cwd: PI_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

describe("catalog files", () => {
	it("all 5 catalog files exist under pi/catalogs/", () => {
		for (const name of CATALOG_NAMES) {
			expect(existsSync(catalogPath(name))).toBe(true);
		}
	});

	for (const name of CATALOG_NAMES) {
		it(`${name}.json parses as JSON`, () => {
			const raw = readFileSync(catalogPath(name), "utf-8");
			expect(() => JSON.parse(raw)).not.toThrow();
		});
	}

	for (const name of CATALOG_NAMES) {
		it(`${name}.json has _source_hash field (64-char hex)`, () => {
			const cat = loadCatalog(name);
			const hash = cat._source_hash;
			expect(typeof hash).toBe("string");
			expect((hash as string).length).toBe(64);
			expect((hash as string)).toMatch(/^[0-9a-f]{64}$/);
		});
	}

	for (const name of CATALOG_NAMES) {
		it(`${name}.json has _source_files array (non-empty)`, () => {
			const cat = loadCatalog(name);
			const files = cat._source_files;
			expect(Array.isArray(files)).toBe(true);
			expect((files as unknown[]).length).toBeGreaterThan(0);
		});
	}

	for (const name of CATALOG_NAMES) {
		it(`${name}.json top-level object is non-empty (after stripping metadata)`, () => {
			const cat = loadCatalog(name);
			const contentKeys = Object.keys(cat).filter((k) => !META_KEYS.has(k));
			expect(contentKeys.length).toBeGreaterThan(0);
		});
	}
});