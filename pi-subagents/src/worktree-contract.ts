/**
 * worktree-contract.ts — GC-2026-008 P2 / GC-2026-017 / GC-2026-path-B-field-renames.
 *
 * The Agent-boundary contract for the managed-worktree domain. Three jobs:
 *
 *   1. Parse the explicit worktree request that the Agent tool now accepts.
 *      `{ goal_id (preferred) | dag_id (deprecated), task_id, worktree_id?, mode: "create" | "reuse" }`.
 *      Pass `goal_id`; `dag_id` is accepted for one release as a backward-
 *      compat shim. Pass exactly one of them — both-or-neither is rejected.
 *      The legacy `"worktree"` string literal is refused at the type boundary
 *      — without an explicit object, dispatch MUST reject before child execution.
 *
 *   2. Re-export the runtime schema (`MANAGED_WORKTREE_REQUEST_TYPE`) so the
 *      Agent tool's JSON schema and the parser agree on field names. Single
 *      source of truth — drift between schema and parser would let bad input
 *      through.
 *
 *   3. Validate the request against the same identity rules `validateIdentity`
 *      enforces inside the worktree helper. Path-traversal / whitespace /
 *      separators are caught BEFORE the manager tries to provision.
 *
 * GC-2026-017 extends the surface: callers can now opt out of a managed
 * worktree entirely by passing the literal `"current-workspace"`. This is
 * recognized ONLY by `normalizeWorktreeIsolation` (which returns
 * `undefined` to signal "no managed worktree") — the object-form parser
 * `parseManagedWorktreeRequest` is unchanged and still refuses strings,
 * and the legacy `"worktree"` literal is still rejected at both surfaces.
 *
 * GC-2026-path-B-field-renames: `dag_id` is renamed to `goal_id` for path-B
 * semantic clarity (the orchestrator has no DAG concept). Both names are
 * accepted by the parser; the canonical output uses `goal_id`. After one
 * release the compat shim is removed (follow-up GC).
 */

import type { TSchema } from "typebox";
import { Type } from "typebox";
import { validateIdentity } from "./worktree.js";

/** Mode of provisioning the Agent manager performs on the worktree. */
export type ManagedWorktreeMode = "create" | "reuse";

/**
 * Explicit worktree request accepted by the Agent tool's `isolation` field.
 *
 * Pass `goal_id` (preferred). `dag_id` is accepted as a deprecated alias
 * for one release — see the parser for the both-or-neither rejection rule.
 *
 * `worktree_id` is optional — defaults to the task_id at the worktree helper.
 * `mode: "create"` errors when the slot is occupied (no silent reuse);
 * `mode: "reuse"` errors when the slot is unoccupied or the existing
 * worktree's identity / branch state does not match what this call expects.
 *
 * `base_ref` is optional — when provided, the worktree is provisioned from
 * this ref (validated as a safe git ref name: `[A-Za-z0-9._/-]+`). When
 * omitted, the helper resolves the current working directory's branch:
 * prefer the upstream tracking ref (e.g. `origin/main`) when set, fall back
 * to the local branch name, and finally to `origin/main` for detached HEAD.
 * Local refs (e.g. `feature/x`) do not trigger a fetch; remote-tracking refs
 * (e.g. `origin/feature/x`) trigger `git fetch origin <branch>` first.
 */
export interface ManagedWorktreeRequest {
	goal_id: string;
	/** @deprecated Prefer `goal_id`. Accepted as a compat shim for one release. */
	dag_id?: string;
	task_id: string;
	worktree_id?: string;
	mode: ManagedWorktreeMode;
	base_ref?: string;
}

/**
 * Runtime JSON schema describing the explicit worktree request. Mirrors
 * `ManagedWorktreeRequest` exactly — Type.Object's reflection captures all
 * required fields plus the optional `worktree_id`. Used by the `Agent`
 * tool's `parameters` (Type.Object) registration in `index.ts`.
 *
 * GC-2026-path-B-field-renames: `goal_id` is the primary field;
 * `dag_id` is marked deprecated. LLMs that read the schema see both
 * names; LLMs that emit one field see no error (the parser accepts
 * either). LLMs that emit both are rejected at parse time.
 */
export const MANAGED_WORKTREE_REQUEST_TYPE: TSchema = Type.Object(
	{
		goal_id: Type.Optional(
			Type.String({
				description:
					'Goal id (e.g. "GC-2026-008"). Combined with task_id into a managed ' +
					"worktree at <repoRoot>/.pi/worktree/<goal_id>/<task_id>.",
				pattern: "^[A-Za-z0-9_-]+$",
			}),
		),
		dag_id: Type.Optional(
			Type.String({
				description:
					'[DEPRECATED — prefer goal_id] DAG / goal id (e.g. "GC-2026-008"). ' +
					"Accepted as a backward-compat alias for goal_id; removed in the next release.",
				pattern: "^[A-Za-z0-9_-]+$",
			}),
		),
		task_id: Type.String({
			description:
				'Task / worktree id within the goal (e.g. "P1"). Must satisfy [A-Za-z0-9_-]+.',
			pattern: "^[A-Za-z0-9_-]+$",
		}),
		worktree_id: Type.Optional(
			Type.String({
				description:
					"Optional sub-id within a task — used when multiple worktrees belong " +
					"to the same task. Defaults to task_id when omitted.",
				pattern: "^[A-Za-z0-9_-]+$",
			}),
		),
		mode: Type.Union([Type.Literal("create"), Type.Literal("reuse")], {
			description:
				'"create" provisions a fresh managed worktree (errors on collision); ' +
				'"reuse" re-enters the existing managed worktree at the same slot ' +
				"(errors on identity mismatch).",
		}),
		base_ref: Type.Optional(
			Type.String({
				description:
					'Optional base ref. Accepts local branches ("main", "feature/x"), ' +
					'remote-tracking refs ("origin/main", "origin/feature/x"), or any safe git ref. ' +
					"Omit to default to the current working directory's branch " +
					'(upstream tracking ref if set, else local branch, else "origin/main" fallback). ' +
					"Refused at provision time if the ref does not resolve.",
				pattern: "^[A-Za-z0-9._/-]+$",
			}),
		),
	},
	{
		description:
			"Managed worktree request. Pass exactly one of goal_id (preferred) " +
			"or dag_id (deprecated alias). Pass neither → parse error. Pass both → " +
			"parse error (ambiguous).",
	},
);

/**
 * Parsed and validated worktree request, ready to be handed to the
 * `AgentManager`. Same shape as `ManagedWorktreeRequest` but with
 * `goal_id` always populated (canonical) and `dag_id` stripped (the
 * compat alias is dropped after parsing).
 */
export type ParsedManagedWorktreeRequest = ManagedWorktreeRequest;

/**
 * Parse + validate the explicit worktree request, or throw an Error with a
 * precise message that names the missing / invalid field. The legacy
 * `"worktree"` string literal is rejected up-front (Sages callers must use
 * the explicit object form).
 */
export function parseManagedWorktreeRequest(
	input: unknown,
): ParsedManagedWorktreeRequest {
	if (input === "worktree") {
		throw new Error(
			'Agent isolation: the legacy "worktree" string literal is no longer accepted. ' +
				"Pass an explicit worktree object instead: " +
				'{ goal_id: string, task_id: string, worktree_id?: string, mode: "create" | "reuse" }. ' +
				"See pi-subagents/src/worktree-contract.ts for the schema.",
		);
	}
	if (input == null || typeof input !== "object") {
		throw new Error(
			`Agent isolation: expected an explicit worktree object ` +
				`({ goal_id, task_id, worktree_id?, mode: "create" | "reuse" }), got ${JSON.stringify(input)}.`,
		);
	}
	const obj = input as Record<string, unknown>;
	const goal_id_raw = obj.goal_id;
	const dag_id_raw = obj.dag_id;
	const task_id = obj.task_id;
	const worktree_id = obj.worktree_id;
	const mode = obj.mode;

	// GC-2026-path-B-field-renames: accept goal_id OR dag_id, but not both.
	// Both-or-neither is a hard error.
	const has_goal_id = typeof goal_id_raw === "string" && goal_id_raw.length > 0;
	const has_dag_id = typeof dag_id_raw === "string" && dag_id_raw.length > 0;
	let goal_id: string | undefined;
	if (has_goal_id && has_dag_id) {
		throw new Error(
			"Agent isolation: pass exactly one of goal_id (preferred) or dag_id " +
				"(deprecated alias). Both were provided — ambiguous.",
		);
	} else if (has_goal_id) {
		goal_id = goal_id_raw;
	} else if (has_dag_id) {
		goal_id = dag_id_raw;
	} else {
		throw new Error(
			"Agent isolation: pass exactly one of goal_id (preferred) or dag_id " +
				'(deprecated alias). Neither was provided.',
		);
	}

	for (const [name, value] of [
		["goal_id", goal_id],
		["task_id", task_id],
	] as const) {
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`Agent isolation: '${name}' must be a non-empty string.`);
		}
	}
	if (
		worktree_id !== undefined &&
		(typeof worktree_id !== "string" || worktree_id.length === 0)
	) {
		throw new Error(
			`Agent isolation: 'worktree_id' must be a non-empty string when provided.`,
		);
	}
	if (mode !== "create" && mode !== "reuse") {
		throw new Error(
			`Agent isolation: 'mode' must be "create" or "reuse" (got ${JSON.stringify(mode)}).`,
		);
	}
	const base_ref = obj.base_ref;
	if (base_ref !== undefined) {
		if (typeof base_ref !== "string" || base_ref.length === 0) {
			throw new Error(
				`Agent isolation: 'base_ref' must be a non-empty string when provided (got ${JSON.stringify(base_ref)}).`,
			);
		}
	}
	const parsed: ParsedManagedWorktreeRequest = {
		goal_id: goal_id as string,
		task_id: task_id as string,
		worktree_id: worktree_id as string | undefined,
		mode,
		base_ref: base_ref as string | undefined,
	};
	// Delegate identity validation to the worktree helper so both surfaces
	// speak the same constraint language. Throws on path-traversal / whitespace.
	validateIdentity(parsed.goal_id, parsed.worktree_id ?? parsed.task_id);
	return parsed;
}

/**
 * Run identity validation only — useful when the caller has already parsed
 * the request and just wants to throw on bad identity before continuing.
 */
export function validateManagedWorktreeRequest(
	req: ParsedManagedWorktreeRequest,
): void {
	validateIdentity(req.goal_id, req.worktree_id ?? req.task_id);
}

/**
 * Normalize the Agent tool's `isolation` field into either an explicit
 * managed-worktree request, `undefined` (no isolation requested), or
 * throws if the input is not a recognized form. The legacy string literal
 * is rejected here — same outcome as parsing it directly, exposed for
 * tools / RPC callers that prefer "normalize or throw" semantics.
 *
 * GC-2026-017: the literal `"current-workspace"` is recognized as an
 * explicit opt-in for non-worktree dispatch and returns `undefined` here
 * (the caller interprets `undefined` as "no managed worktree, run in the
 * current workspace"). The parser `parseManagedWorktreeRequest` is
 * unchanged — it still refuses string inputs because it is the
 * object-form surface only.
 */
export function normalizeWorktreeIsolation(
	raw: unknown,
): ParsedManagedWorktreeRequest | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "string") {
		if (raw === "worktree") {
			throw new Error(parseLegacyIsolationField(raw)); // throws always
		}
		// GC-2026-017: explicit opt-in for current-workspace dispatch.
		// Pass-through — no managed worktree is provisioned.
		if (raw === "current-workspace") return undefined;
		throw new Error(
			`Agent isolation: '${raw}' is not a recognized isolation value. ` +
				`Pass an explicit worktree object, ` +
				`the literal "current-workspace", or omit isolation.`,
		);
	}
	return parseManagedWorktreeRequest(raw);
}

/**
 * Accept and reject rules for the legacy `"worktree"` literal at the
 * schema boundary. The JSON schema still allows the literal so callers
 * that pass the OLD contract receive a clean diagnostic rather than a
 * silent /tmp fallback. The dispatcher rejects the literal through
 * `normalizeWorktreeIsolation` / `parseManagedWorktreeRequest`.
 */
export function parseLegacyIsolationField(
	value: unknown,
): "worktree" | undefined {
	if (value === undefined) return undefined;
	if (value === "worktree") return "worktree";
	throw new Error(
		`Agent isolation: only the literal "worktree" or an explicit worktree object is ` +
			`accepted. Got ${JSON.stringify(value)}.`,
	);
}
