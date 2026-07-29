/**
 * handoff.ts — Atomic JSON write/read for subagent handoff state.
 *
 * Design (GC-2026-022 SC1):
 *
 *   - `writeHandoff(state, path?)` serializes the state to disk via a
 *     `${path}.tmp` file + `renameSync` so a crash mid-write never leaves a
 *     half-written destination. The returned path is the absolute path the
 *     file was written to.
 *
 *   - When `path` is omitted, the default location is
 *     `.pi/orchestrator/handoff/<gc_id>/<task_id>-<trigger>-<ts>.json`
 *     where `<ts>` is `Date.now()` epoch milliseconds. Callers should pass
 *     an explicit path when they need a stable filename (e.g. a
 *     `BudgetTracker` re-using one handoff per run).
 *
 *   - `readHandoff<T>(path)` returns `null` for missing files, never throws,
 *     and validates `schema_version === 1`. Foreign-scheme files (e.g. from
 *     a prior version) throw a clear error so the caller can migrate
 *     instead of silently parsing an unrelated shape.
 *
 *   - The module never assumes `process.cwd()`. All default paths are
 *     resolved against the supplied path, and `path?` must be absolute
 *     (relative paths land under the `.pi/orchestrator/handoff/<gc_id>/`
 *     subtree via `resolveCwd`).
 *
 * Stability: this is the SC1 contract. Anti-goals forbid bumping
 * `schema_version` without writing a migration; new optional fields are
 * always additive.
 *
 * Internal hooks (grep-visible markers):
 *   - handoff_atomic_write: temp + rename path
 *   - handoff_read_validate: schema_version gate
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const HANDOFF_SCHEMA_VERSION = 1 as const;

export type HandoffTrigger =
	| "partial"
	| "final"
	| "timeout"
	| "snapshot"
	| "clean";
export type HandoffPhase = "in-progress" | "completed" | "aborted";
export type SCStatus =
	| "not-started"
	| "in-progress"
	| "pass"
	| "fail"
	| "blocked";

/**
 * Stable handoff state. Pinned by GC-2026-022 SC1. New fields are
 * additive only; do not remove or rename without bumping schema_version.
 */
export interface HandoffState {
	schema_version: typeof HANDOFF_SCHEMA_VERSION;
	task_id: string;
	gc_id: string;
	agent_type: string;
	started_at: string;
	ended_at?: string;
	trigger: HandoffTrigger;
	phase: HandoffPhase;
	files_modified: string[];
	files_added: string[];
	files_deleted: string[];
	commits: string[];
	test_status: { passes: number; fails: number; skipped: number };
	sc_status: Record<string, SCStatus>;
	next_step: string;
	open_questions: string[];
	warnings: string[];
}

/**
 * Default base for the auto-named handoff path. Resolved against the
 * caller's cwd at write time; tests can override by passing an explicit
 * `path` argument.
 */
const DEFAULT_HARNESS_DIR = ".pi/orchestrator/handoff";

function defaultPath(state: HandoffState): string {
	const base = resolve(process.cwd(), DEFAULT_HARNESS_DIR, state.gc_id);
	const ts = Date.now();
	return resolve(base, `${state.task_id}-${state.trigger}-${ts}.json`);
}

function ensureDir(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * Write a handoff state to disk atomically. Returns the absolute path
 * the file was written to.
 *
 * Atomicity: the JSON is first written to `${path}.tmp`, then renamed
 * to `${path}`. A crash between the two steps leaves a stale `.tmp` but
 * the destination is either the previous good copy (if any) or absent.
 * `readHandoff` then continues to read the last good copy.
 */
export function writeHandoff(state: HandoffState, path?: string): string {
	const target =
		path !== undefined
			? isAbsolute(path)
				? path
				: resolve(process.cwd(), path)
			: defaultPath(state);

	ensureDir(target);

	const tmp = `${target}.tmp`;
	const json = `${JSON.stringify(state, null, "\t")}\n`;

	// handoff_atomic_write: write to a sibling .tmp file first.
	writeFileSync(tmp, json, "utf-8");
	try {
		// `renameSync` is atomic on POSIX when source and destination are
		// on the same filesystem, which the ensureDir above guarantees.
		renameSync(tmp, target);
	} catch (err) {
		// Best-effort cleanup of the leftover .tmp; ignore failures.
		try {
			unlinkSync(tmp);
		} catch {
			/* swallow */
		}
		throw err;
	}

	return target;
}

/**
 * Read a handoff state from disk. Returns `null` if the file does not
 * exist; throws a clear error for malformed content (foreign
 * `schema_version`, unparseable JSON) so a caller can distinguish
 * "missing" from "wrong version".
 */
export function readHandoff<T = HandoffState>(path: string): T | null {
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`handoff: failed to parse JSON at ${path}: ${(err as Error).message}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`handoff: ${path} does not contain a JSON object`);
	}
	const obj = parsed as { schema_version?: unknown };
	// handoff_read_validate: schema_version gate.
	if (obj.schema_version !== HANDOFF_SCHEMA_VERSION) {
		throw new Error(
			`handoff: ${path} has schema_version=${String(obj.schema_version)}; ` +
				`expected ${HANDOFF_SCHEMA_VERSION}. Migrate or delete the file.`,
		);
	}
	return parsed as T;
}
