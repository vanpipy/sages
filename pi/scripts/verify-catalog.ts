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

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	KNOWN_SUBAGENT_IDS,
	defaultRunInBackground,
} from "@sages/pi-subagents";
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
// pi-subagents (`@sages/pi-subagents#KNOWN_SUBAGENT_IDS`) is the runtime
// source of truth; the `subagent.json` catalog is a snapshot. After
// per-file hash verification passes, this check confirms they agree on:
//   1. The set of subagent ids present in each.
//   2. The `run_in_background_default` boolean for each shared id.
//
// If either direction is broken, the catalog is either stale (re-run
// `gen:catalog`) or hand-edited (revert the catalog). Both are reported
// as failures. The check reads pi-subagents' current `KNOWN_SUBAGENT_IDS`
// fresh and is independent of the cache layer — it always reflects the
// in-memory truth.

interface CrossConsistencyResult {
	ok: boolean;
	error?: string;
	registryOnly?: string[];
	catalogOnly?: string[];
	mismatched?: Array<{ id: string; registry: boolean; catalog: boolean }>;
}

function verifySubagentCrossConsistency(): CrossConsistencyResult {
	const catalogRelPath = "catalogs/subagent.json";
	const catalogAbs = join(PI_ROOT, catalogRelPath);

	if (!existsSync(catalogAbs)) {
		return { ok: false, error: `catalog file missing: ${catalogRelPath}` };
	}

	let catalogParsed: unknown;
	try {
		catalogParsed = JSON.parse(readFileSync(catalogAbs, "utf-8"));
	} catch (e) {
		return { ok: false, error: `subagent.json is not valid JSON: ${(e as Error).message}` };
	}

	const catalogEntries = (catalogParsed as { entries?: unknown } | null)?.entries;
	if (!Array.isArray(catalogEntries)) {
		return { ok: false, error: "subagent.json: 'entries' is not an array" };
	}

	const registryMap = new Map<string, boolean>();
	for (const id of KNOWN_SUBAGENT_IDS) {
		registryMap.set(id, defaultRunInBackground(id));
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

// ─────────────────────────────────────────────────────────────────────────────
// GC-2026-051 T5.2 — cookbook / postmortem consistency check
// ─────────────────────────────────────────────────────────────────────────────
//
// `pi/docs/gc-index.md` is the entry point for institutional knowledge
// — it lists every Goal Contract ever merged, and (by discipline)
// every postmortem file at `pi/docs/postmortem/<id>.md` should be
// reachable from the index.
//
// The strict gate "every GC id in the index has a postmortem or
// carve-out" lives in the dedicated `verify:gcdb` command, which
// walks the *goal directory*. This check in `verify-catalog` is the
// inverse direction and covers two structural invariants:
//
//   1. Postmortem ↔ index alignment: every `docs/postmortem/<id>.md`
//      file is mentioned in the gc-index. A postmortem that fell
//      out of the index would be unreachable from the entry point —
//      fail with the offending id.
//
//   2. Cookbook link resolvability: any link in the index that points
//      into `docs/cookbook/` must resolve on disk. Goal-yaml links
//      in the table are aspirational (the goal files do not exist on
//      disk for most historical GCs) and are NOT checked here — the
//      discipline is enforced upstream by the goal-creation flow.
//
// The carve-out section (`## Open / no postmortem`) is read so
// postmortem-coverage drift can be diagnosed even when the strict
// `verify:gcdb` gate is scoped to existing goal files.

export interface CookbookPostmortemResult {
	ok: boolean;
	error?: string;
	orphanPostmortems?: string[];
	missingCookbookLinks?: string[];
}

export function verifyCookbookPostmortemConsistency(
	gcIndexPath: string = join(PI_ROOT, "docs", "gc-index.md"),
	postmortemDir: string = join(PI_ROOT, "docs", "postmortem"),
): CookbookPostmortemResult {
	if (!existsSync(gcIndexPath)) {
		return { ok: false, error: `gc-index.md missing: ${relative(PI_ROOT, gcIndexPath)}` };
	}
	if (!existsSync(postmortemDir)) {
		// No postmortems yet — invariant trivially satisfied.
		return { ok: true };
	}

	const raw = readFileSync(gcIndexPath, "utf-8");
	const indexIds = new Set<string>();
	for (const m of raw.matchAll(/GC-\d{4}-\d{3,}/g)) indexIds.add(m[0]);

	// 1. Postmortem ↔ index alignment.
	const orphanPostmortems: string[] = [];
	for (const file of readdirSync(postmortemDir)) {
		const m = file.match(/^(GC-\d{4}-\d{3,})\.md$/);
		if (!m || !m[1]) continue;
		if (!indexIds.has(m[1])) orphanPostmortems.push(m[1]);
	}

	// 2. Cookbook link resolvability. The index only links goal
	// yamls today (no cookbook entries in the table), so this branch
	// is a no-op on the current tree — but it future-proofs against
	// a contributor adding a cookbook link that points at a typo.
	const missingCookbookLinks: string[] = [];
	const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
	for (const m of raw.matchAll(linkRe)) {
		const target = m[1];
		if (!target) continue;
		if (!target.startsWith("../cookbook/") && !target.startsWith("cookbook/")) continue;
		const tail = target.replace(/^\.\.\//, "").replace(/^cookbook\//, "cookbook/");
		const abs = join(PI_ROOT, "docs", tail);
		if (!existsSync(abs)) missingCookbookLinks.push(target);
	}

	if (orphanPostmortems.length === 0 && missingCookbookLinks.length === 0) {
		return { ok: true };
	}
	return { ok: false, orphanPostmortems, missingCookbookLinks };
}

// ─────────────────────────────────────────────────────────────────────────────
// GC-2026-049 T3.2 — profile ↔ registry cross-consistency check
// ─────────────────────────────────────────────────────────────────────────────
//
// A profile is a named bundle (see `pi/src/profile.ts`) that whitelists
// subagents. The profile's `subagents` list MUST be a subset of the
// registry id set — otherwise the profile would dispatch a role the
// runtime has never heard of, and `validateDAG` would emit "not a known
// role" warnings on every task.
//
// The check reads every `pi/profiles/*.yaml`, parses it, and confirms
// each `profile.subagents` id appears in `pi/subagents/registry.yaml`.
// Profiles with no `subagents` array (or any other schema failure) are
// reported as a failure with a precise file path and reason.
//
// Direction: this check is one-directional (profile → registry). A
// registered subagent that no profile references is *not* an error
// (profiles intentionally whittle down the full roster). Orphan
// detection is a separate, informational concern — see the test in
// `pi/test/subagent-registry.test.ts` for the inverse perspective.

export interface ProfileCrossConsistencyResult {
	ok: boolean;
	error?: string;
	unknown?: Array<{ profile: string; subagent: string }>;
}

export function verifyProfileCrossConsistency(
	profilesDir = join(PI_ROOT, "profiles"),
): ProfileCrossConsistencyResult {
	if (!existsSync(profilesDir)) {
		return { ok: false, error: `profiles directory missing: ${relative(PI_ROOT, profilesDir)}` };
	}

	// pi-subagents owns the canonical subagent id list. Profiles are
	// whitelists that must be subsets of that set.
	const registryIds = new Set(KNOWN_SUBAGENT_IDS);

	const yamlFiles = readdirSync(profilesDir)
		.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
		.sort();

	if (yamlFiles.length === 0) {
		return { ok: false, error: `no profile YAMLs found in ${relative(PI_ROOT, profilesDir)}` };
	}

	const unknown: Array<{ profile: string; subagent: string }> = [];
	for (const file of yamlFiles) {
		const absPath = resolve(profilesDir, file);
		const relPath = relative(PI_ROOT, absPath);
		let profile: unknown;
		try {
			profile = yaml.load(readFileSync(absPath, "utf-8"));
		} catch (e) {
			return { ok: false, error: `${relPath}: not valid YAML (${(e as Error).message})` };
		}
		if (typeof profile !== "object" || profile === null) {
			return { ok: false, error: `${relPath}: top-level value is not a mapping` };
		}
		const subagents = (profile as { subagents?: unknown }).subagents;
		if (!Array.isArray(subagents)) {
			return { ok: false, error: `${relPath}: 'subagents' is not an array` };
		}
		const profileId = (profile as { id?: unknown }).id;
		const profileName = typeof profileId === "string" && profileId.length > 0 ? profileId : file;
		for (const candidate of subagents) {
			if (typeof candidate !== "string" || candidate.length === 0) {
				return {
					ok: false,
					error: `${relPath}: subagent id must be a non-empty string (got ${JSON.stringify(candidate)})`,
				};
			}
			if (!registryIds.has(candidate)) {
				unknown.push({ profile: profileName, subagent: candidate });
			}
		}
	}

	if (unknown.length === 0) {
		return { ok: true };
	}
	return { ok: false, unknown };
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

	// Per-file + subagent cross-consistency pass — now run the
	// profile ↔ registry cross-consistency check (GC-2026-049 T3.2).
	const profileCross = verifyProfileCrossConsistency();
	if (!profileCross.ok) {
		console.error(`verify-catalog: FAIL — profile YAMLs reference unknown subagent(s)`);
		if (profileCross.error) {
			console.error(`  ✗ ${profileCross.error}`);
		}
		if (profileCross.unknown && profileCross.unknown.length > 0) {
			for (const u of profileCross.unknown) {
				console.error(
					`  ✗ profile '${u.profile}' references unknown subagent '${u.subagent}'; add to pi/subagents/registry.yaml or remove from profile`,
				);
			}
		}
		process.exit(1);
	}

	// Profile cross-consistency passes — now run the cookbook /
	// postmortem consistency check (GC-2026-051 T5.2). This is the
	// postmortem ↔ index alignment check (orphan detection) plus
	// cookbook link resolvability. The strict "every GC has a
	// postmortem" gate is `verify:gcdb`.
	const cookbookCross = verifyCookbookPostmortemConsistency();
	if (!cookbookCross.ok) {
		console.error(`verify-catalog: FAIL — gc-index.md institutional coverage broken`);
		if (cookbookCross.error) {
			console.error(`  ✗ ${cookbookCross.error}`);
		}
		if (cookbookCross.orphanPostmortems && cookbookCross.orphanPostmortems.length > 0) {
			console.error(
				`  ✗ ${cookbookCross.orphanPostmortems.length} postmortem(s) NOT referenced in gc-index.md:`,
			);
			for (const id of cookbookCross.orphanPostmortems) {
				console.error(
					`      ${id}: postmortem file exists at docs/postmortem/${id}.md but the GC id is missing from gc-index.md`,
				);
			}
		}
		if (cookbookCross.missingCookbookLinks && cookbookCross.missingCookbookLinks.length > 0) {
			console.error(`  ✗ ${cookbookCross.missingCookbookLinks.length} broken cookbook link(s):`);
			for (const target of cookbookCross.missingCookbookLinks) {
				console.error(`      ${target}`);
			}
		}
		process.exit(1);
	}

	console.log(`OK: ${passing.length} catalogues current (registry.yaml ↔ subagent.json consistent; profiles ↔ registry consistent; gc-index.md institutional coverage OK)`);
	for (const p of passing) {
		console.log(`  ✓ ${p.name}.json (hash=${p.stored!.slice(0, 12)}…)`);
	}
	process.exit(0);
}

// Only run main() when this file is the script entrypoint. This
// allows the cross-consistency check to be imported by tests
// (`verifyProfileCrossConsistency`) without spawning a subprocess
// and without `process.exit(0)` terminating the test runner.
const ENTRY = process.argv[1] ?? "";
if (ENTRY.endsWith("verify-catalog.ts") || ENTRY.endsWith("verify-catalog.js")) {
	main();
}
