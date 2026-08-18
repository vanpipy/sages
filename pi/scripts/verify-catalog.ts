#!/usr/bin/env bun
/**
 * verify-catalog.ts — GC-2026-047 T1.1 / GC-2026-048 T2.2
 *
 * Verifies that every catalog file under `pi/catalogs/` is in sync with
 * its source files. For each catalog:
 *   1. Read the catalog JSON.
 *   2. Recompute the per-file SHA-256 hash chain from the source files
 *      listed in the catalog's `_source_files` array.
 *   3. Compare `sha256(chain)` against the catalog's stored `_source_hash`.
 *
 * After the per-file hash checks pass, GC-2026-048 T2.2 adds a
 * cross-consistency check: the `subagent.json` catalog and
 * `subagents/registry.yaml` MUST agree on the set of subagent ids and on
 * the `run_in_background_default` value for each id. The catalog is a
 * snapshot of the registry; if either side drifts, the snapshot is
 * either stale (re-run `gen:catalog`) or hand-edited (revert the
 * catalog). Both directions are reported as failures.
 *
 * On any mismatch: print the diff and exit 1. On all match: print
 * `OK: N catalogues current` and exit 0.
 *
 * No external dependencies beyond `js-yaml` (already a runtime dep of pi).
 *
 * Self-test (TDD red/green): running this script on freshly-generated
 * catalogs (just produced by `gen-catalog.ts`) MUST exit 0. Running
 * after any change to a listed source file MUST exit 1.
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

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

// ─────────────────────────────────────────────────────────────────────────────
// GC-2026-048 T2.2 — cross-consistency check
// ─────────────────────────────────────────────────────────────────────────────
//
// `pi/subagents/registry.yaml` is the runtime source of truth; the
// `subagent.json` catalog is a snapshot. After per-file hash verification
// passes, this check confirms they agree on:
//   1. The set of subagent ids present in each file.
//   2. The `run_in_background_default` boolean for each shared id.
//
// If either direction is broken, the catalog is either stale (re-run
// `gen:catalog`) or hand-edited (revert the catalog). Both are reported
// as failures. The check reads both files fresh and is independent of
// the cache layer — it always reflects the on-disk truth.

interface CrossConsistencyResult {
	ok: boolean;
	error?: string;
	registryOnly?: string[];
	catalogOnly?: string[];
	mismatched?: Array<{ id: string; registry: boolean; catalog: boolean }>;
}

function verifySubagentCrossConsistency(): CrossConsistencyResult {
	const registryRelPath = "subagents/registry.yaml";
	const catalogRelPath = "catalogs/subagent.json";
	const registryAbs = join(PI_ROOT, registryRelPath);
	const catalogAbs = join(PI_ROOT, catalogRelPath);

	if (!existsSync(registryAbs)) {
		return { ok: false, error: `registry file missing: ${registryRelPath}` };
	}
	if (!existsSync(catalogAbs)) {
		return { ok: false, error: `catalog file missing: ${catalogRelPath}` };
	}

	let registryParsed: unknown;
	let catalogParsed: unknown;
	try {
		registryParsed = yaml.load(readFileSync(registryAbs, "utf-8"));
	} catch (e) {
		return { ok: false, error: `registry.yaml is not valid YAML: ${(e as Error).message}` };
	}
	try {
		catalogParsed = JSON.parse(readFileSync(catalogAbs, "utf-8"));
	} catch (e) {
		return { ok: false, error: `subagent.json is not valid JSON: ${(e as Error).message}` };
	}

	const registrySubs = (registryParsed as { subagents?: unknown } | null)?.subagents;
	const catalogEntries = (catalogParsed as { entries?: unknown } | null)?.entries;
	if (!Array.isArray(registrySubs)) {
		return { ok: false, error: "registry.yaml: 'subagents' is not an array" };
	}
	if (!Array.isArray(catalogEntries)) {
		return { ok: false, error: "subagent.json: 'entries' is not an array" };
	}

	const registryMap = new Map<string, boolean>();
	for (const [index, candidate] of registrySubs.entries()) {
		if (typeof candidate !== "object" || candidate === null) {
			return { ok: false, error: `registry.yaml entry ${index} is not an object` };
		}
		const entry = candidate as { id?: unknown; run_in_background?: unknown };
		if (typeof entry.id !== "string" || entry.id.length === 0) {
			return { ok: false, error: `registry.yaml entry ${index} has missing 'id'` };
		}
		if (typeof entry.run_in_background !== "boolean") {
			return { ok: false, error: `registry.yaml entry '${entry.id}' has missing 'run_in_background'` };
		}
		registryMap.set(entry.id, entry.run_in_background);
	}

	const catalogMap = new Map<string, boolean>();
	for (const [index, candidate] of catalogEntries.entries()) {
		if (typeof candidate !== "object" || candidate === null) {
			return { ok: false, error: `subagent.json entry ${index} is not an object` };
		}
		const entry = candidate as { id?: unknown; run_in_background_default?: unknown };
		if (typeof entry.id !== "string" || entry.id.length === 0) {
			return { ok: false, error: `subagent.json entry ${index} has missing 'id'` };
		}
		if (typeof entry.run_in_background_default !== "boolean") {
			return { ok: false, error: `subagent.json entry '${entry.id}' has missing 'run_in_background_default'` };
		}
		catalogMap.set(entry.id, entry.run_in_background_default);
	}

	const registryOnly: string[] = [];
	for (const id of registryMap.keys()) {
		if (!catalogMap.has(id)) registryOnly.push(id);
	}
	const catalogOnly: string[] = [];
	for (const id of catalogMap.keys()) {
		if (!registryMap.has(id)) catalogOnly.push(id);
	}
	const mismatched: Array<{ id: string; registry: boolean; catalog: boolean }> = [];
	for (const [id, regVal] of registryMap.entries()) {
		const catVal = catalogMap.get(id);
		if (catVal !== undefined && catVal !== regVal) {
			mismatched.push({ id, registry: regVal, catalog: catVal });
		}
	}

	if (registryOnly.length === 0 && catalogOnly.length === 0 && mismatched.length === 0) {
		return { ok: true };
	}
	return { ok: false, registryOnly, catalogOnly, mismatched };
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

	// Per-file hash checks pass — now run the cross-consistency check.
	const cross = verifySubagentCrossConsistency();
	if (!cross.ok) {
		console.error(`verify-catalog: FAIL — subagent.json ↔ registry.yaml cross-consistency broken`);
		if (cross.error) {
			console.error(`  ✗ ${cross.error}`);
		}
		if (cross.registryOnly && cross.registryOnly.length > 0) {
			console.error(`  ✗ ids in registry.yaml but missing from subagent.json: ${cross.registryOnly.join(", ")}`);
			console.error(`      fix: re-run \`bun run gen:catalog\` to regenerate the snapshot`);
		}
		if (cross.catalogOnly && cross.catalogOnly.length > 0) {
			console.error(`  ✗ ids in subagent.json but missing from registry.yaml: ${cross.catalogOnly.join(", ")}`);
			console.error(`      fix: revert the hand-edit on subagent.json or add the id to registry.yaml`);
		}
		if (cross.mismatched && cross.mismatched.length > 0) {
			for (const m of cross.mismatched) {
				console.error(`  ✗ '${m.id}' run_in_background mismatch: registry=${m.registry} catalog=${m.catalog}`);
			}
		}
		process.exit(1);
	}

	console.log(`OK: ${passing.length} catalogues current (registry.yaml ↔ subagent.json consistent)`);
	for (const p of passing) {
		console.log(`  ✓ ${p.name}.json (hash=${p.stored!.slice(0, 12)}…)`);
	}
	process.exit(0);
}

main();
