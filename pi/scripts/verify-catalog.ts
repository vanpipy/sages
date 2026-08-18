#!/usr/bin/env bun
/**
 * verify-catalog.ts — GC-2026-047 T1.1
 *
 * Verifies that every catalog file under `pi/catalogs/` is in sync with
 * its source files. For each catalog:
 *   1. Read the catalog JSON.
 *   2. Recompute the per-file SHA-256 hash chain from the source files
 *      listed in the catalog's `_source_files` array.
 *   3. Compare `sha256(chain)` against the catalog's stored `_source_hash`.
 *
 * On any mismatch: print the diff and exit 1. On all match: print
 * `OK: N catalogues current` and exit 0.
 *
 * No external dependencies. bun builtins + `node:crypto` only.
 *
 * Self-test (TDD red/green): running this script on freshly-generated
 * catalogs (just produced by `gen-catalog.ts`) MUST exit 0. Running
 * after any change to a listed source file MUST exit 1.
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PI_ROOT = join(__dirname, "..");
const CATALOGS_DIR = join(PI_ROOT, "catalogs");

// The five canonical catalog names (mirrors `gen-catalog.ts`).
const CATALOG_NAMES = [
	"subagent",
	"isolation",
	"gate",
	"event",
	"namespace",
] as const;

type CatalogName = (typeof CATALOG_NAMES)[number];

interface CatalogFile {
	_source_hash: string;
	_generated_at: string;
	_source_files: string[];
	[k: string]: unknown;
}

function fileHash(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

function sha256Hex(s: string): string {
	return createHash("sha256").update(s, "utf-8").digest("hex");
}

function sourceHashChain(relPaths: string[]): string {
	return relPaths
		.map((relPath) => {
			const abs = join(PI_ROOT, relPath);
			if (!existsSync(abs)) {
				throw new Error(`source file missing: ${relPath}`);
			}
			const content = readFileSync(abs, "utf-8");
			return `${relPath}:${fileHash(content)}`;
		})
		.join(";");
}

function recomputeSourceHash(relPaths: string[]): string {
	return sha256Hex(sourceHashChain(relPaths));
}

interface VerifyResult {
	name: CatalogName;
	ok: boolean;
	stored?: string;
	computed?: string;
	error?: string;
}

function verifyCatalog(name: CatalogName): VerifyResult {
	const catalogPath = join(CATALOGS_DIR, `${name}.json`);
	if (!existsSync(catalogPath)) {
		return { name, ok: false, error: `catalog file missing: ${relative(PI_ROOT, catalogPath)}` };
	}
	let catalog: CatalogFile;
	try {
		catalog = JSON.parse(readFileSync(catalogPath, "utf-8")) as CatalogFile;
	} catch (e) {
		return {
			name,
			ok: false,
			error: `catalog file is not valid JSON: ${(e as Error).message}`,
		};
	}
	if (typeof catalog._source_hash !== "string" || catalog._source_hash.length === 0) {
		return { name, ok: false, error: "_source_hash missing or empty" };
	}
	if (!Array.isArray(catalog._source_files) || catalog._source_files.length === 0) {
		return { name, ok: false, error: "_source_files array missing or empty" };
	}
	try {
		const computed = recomputeSourceHash(catalog._source_files);
		if (computed === catalog._source_hash) {
			return { name, ok: true, stored: catalog._source_hash, computed };
		}
		return {
			name,
			ok: false,
			stored: catalog._source_hash,
			computed,
			error: "hash mismatch",
		};
	} catch (e) {
		return { name, ok: false, error: (e as Error).message };
	}
}

function main(): void {
	const results = CATALOG_NAMES.map(verifyCatalog);
	const passing = results.filter((r) => r.ok);
	const failing = results.filter((r) => !r.ok);

	if (failing.length > 0) {
		console.error(`verify-catalog: FAIL — ${failing.length}/${results.length} catalogue(s) stale`);
		for (const f of failing) {
			console.error(`  ✗ ${f.name}.json: ${f.error ?? "hash mismatch"}`);
			if (f.stored && f.computed) {
				console.error(`      stored  = ${f.stored}`);
				console.error(`      computed= ${f.computed}`);
			}
		}
		process.exit(1);
	}

	console.log(`OK: ${passing.length} catalogues current`);
	for (const p of passing) {
		console.log(`  ✓ ${p.name}.json (hash=${p.stored!.slice(0, 12)}…)`);
	}
	process.exit(0);
}

main();
