/**
 * failure-catalog.ts — GC-2026-044 mechanism 1.3 (design §5).
 *
 * Adapted from ai-sdlc RFC-0015 §5.1 + §Q9. The point of the mechanism is that
 * failure classes stop being free text ("NEEDS WORK: something broke") and
 * become a versioned, enumerable vocabulary that both the sub-agent and the orchestrator
 * audit roll-up can reason about. `DiagnosticJsonV1.cause` (mechanism 1.4)
 * draws from exactly these ids — that shared vocabulary is what makes
 * `gatherFailureModeStats()` possible.
 *
 * Two things here are load-bearing and deserve their rationale in-file:
 *
 * 1. The YAML parser is homegrown. `js-yaml` lives in `pi/`'s dependency tree,
 *    not this package's, and GC-2026-044 forbids new dependencies. Rather than
 *    take an undeclared (phantom) dependency that would break the published
 *    package, this module parses the small YAML subset the catalog is written
 *    in. The catalog is written to stay inside that subset — see the header of
 *    `data/failure-modes.v1.yaml`.
 *
 * 2. Validation is fail-closed. A malformed catalog throws at load rather than
 *    degrading to "no modes matched", because a silently-empty catalog would
 *    make every downstream failure look like `infra-unhandled`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

// =============================================================================
// Types (design §5.2)
// =============================================================================

/** §2.4 discriminator: `spec` is an LLM-side miss, `error` is infrastructure. */
export type FailureModeKind = "spec" | "error";

export type FailureModeStage =
	| "pre-dispatch"
	| "worktree-provision"
	| "implement"
	| "verify"
	| "commit"
	| "merge"
	| "reviewer";

export type FailureDetection =
	| {
			kind: "regex";
			pattern: string;
			flags?: string;
			against: "stderr" | "verifier-output" | "free-text";
			/**
			 * When true the mode fires if the pattern is ABSENT. Design §5.3
			 * specifies `commit-message-non-conformant` as "Conventional Commits
			 * prefix absent", which a positive regex cannot express.
			 */
			negate?: boolean;
	  }
	| { kind: "structured"; matches: string[] };

export type FailureHandler =
	| { kind: "noop"; note: string }
	| { kind: "retry-subagent"; retryBudget: number; feedbackTemplate: string }
	| { kind: "escalate-to-l3"; note: string }
	| { kind: "mark-stalled"; note: string };

export interface FailureModeV1Entry {
	id: string;
	name: string;
	description: string;
	kind: FailureModeKind;
	appliesTo: FailureModeStage[];
	detection: FailureDetection;
	handler: FailureHandler;
	retryBudget: number;
	supersedes?: string[];
	enabled?: boolean;
}

export interface FailureModeV1 {
	schemaVersion: "v1";
	modes: FailureModeV1Entry[];
}

/** The signal a caller has about a failure; every field is optional. */
export interface FailureSignal {
	stderr?: string;
	structuredClass?: string;
	verifierOutput?: string;
	freeText?: string;
}

/** Thrown when a catalog cannot be trusted. Load fails closed. */
export class FailureCatalogInvalid extends Error {
	constructor(message: string) {
		super(`failure-catalog: ${message}`);
		this.name = "FailureCatalogInvalid";
	}
}

/**
 * Variables a `feedbackTemplate` may reference (Q-E chose concrete names over
 * a generic `{evidence.value}` shape — a template that names `{stderr_digest}`
 * is debuggable at a glance). Boot validation rejects anything outside this set
 * so a typo surfaces at load, not at the moment a sub-agent needs the feedback.
 */
export const KNOWN_TEMPLATE_VARS = [
	"stderr_digest",
	"sha",
	"task_id",
	"goal_id",
	"mode_id",
	"verifier_output",
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the shipped default catalog. */
export const SHIPPED_CATALOG_PATH = join(HERE, "data", "failure-modes.v1.yaml");

/** Project override path, relative to a repo root (design §2.1). */
export const PROJECT_OVERRIDE_RELPATH = join(".pi", "failure-modes.yaml");

// =============================================================================
// YAML parser
// =============================================================================

/**
 * Parse the failure-catalog YAML. Delegates to js-yaml's load()
 * (js-yaml is already a runtime dep of this package — see
 * package.json). The previous homegrown subset parser was deleted
 * in GC-2026-098 L9; the only reason it existed was an outdated
 * claim that js-yaml wasn't available here. js-yaml supports the
 * full YAML 1.2 spec including the block scalars (|, |-) and
 * inline sequences ([...]) the catalog uses.
 *
 * Throws FailureCatalogInvalid (wrapped from a YAMLException) on
 * malformed input.
 */
export function parseCatalogYaml(input: string): unknown {
	try {
		return yaml.load(input);
	} catch (e) {
		throw new FailureCatalogInvalid(
			e instanceof Error ? e.message : String(e),
		);
	}
}

// =============================================================================
// Schema validation
// =============================================================================

const StageSchema = Type.Union([
	Type.Literal("pre-dispatch"),
	Type.Literal("worktree-provision"),
	Type.Literal("implement"),
	Type.Literal("verify"),
	Type.Literal("commit"),
	Type.Literal("merge"),
	Type.Literal("reviewer"),
]);

const DetectionSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("regex"),
			pattern: Type.String({ minLength: 1 }),
			flags: Type.Optional(Type.String()),
			against: Type.Union([
				Type.Literal("stderr"),
				Type.Literal("verifier-output"),
				Type.Literal("free-text"),
			]),
			negate: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("structured"),
			matches: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
]);

const HandlerSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("noop"), note: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("retry-subagent"),
			retryBudget: Type.Integer({ minimum: 0 }),
			feedbackTemplate: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("escalate-to-l3"),
			note: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("mark-stalled"), note: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
]);

/** The merged, complete entry — every field required except the optionals. */
const CompleteModeSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }),
		name: Type.String({ minLength: 1 }),
		description: Type.String({ minLength: 1 }),
		kind: Type.Union([Type.Literal("spec"), Type.Literal("error")]),
		appliesTo: Type.Array(StageSchema, { minItems: 1 }),
		detection: DetectionSchema,
		handler: HandlerSchema,
		retryBudget: Type.Integer({ minimum: 0 }),
		supersedes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		enabled: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

/** A raw document may carry partial entries — only `id` is guaranteed. */
const DocumentSchema = Type.Object(
	{
		schemaVersion: Type.Literal("v1"),
		modes: Type.Array(
			Type.Object(
				{ id: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" }) },
				{ additionalProperties: true },
			),
		),
	},
	{ additionalProperties: false },
);

function describeErrors(
	schema: TSchema,
	value: unknown,
): string {
	return [...Value.Errors(schema, value)]
		.slice(0, 5)
		.map((e) => `${e.instancePath || "/"} ${e.message}`)
		.join("; ");
}

// =============================================================================
// Loader
// =============================================================================

export interface LoadCatalogArgs {
	/** Defaults to the shipped catalog next to this module. */
	shippedPath?: string;
	/** Optional project override, deep-merged on top (design §2.6). */
	overridePath?: string;
}

function readDocument(path: string, label: string): FailureModeV1 {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (err) {
		throw new FailureCatalogInvalid(
			`cannot read ${label} catalog at ${path}: ${(err as Error).message}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = parseCatalogYaml(text);
	} catch (err) {
		if (err instanceof FailureCatalogInvalid) {
			throw new FailureCatalogInvalid(
				`${label} catalog (${path}): ${err.message}`,
			);
		}
		throw err;
	}

	if (!Value.Check(DocumentSchema, parsed)) {
		throw new FailureCatalogInvalid(
			`${label} catalog (${path}) is not a valid v1 document: ${describeErrors(DocumentSchema, parsed)}`,
		);
	}

	const doc = parsed as unknown as FailureModeV1;
	const seen = new Set<string>();
	for (const mode of doc.modes) {
		if (seen.has(mode.id)) {
			throw new FailureCatalogInvalid(
				`${label} catalog (${path}) has a duplicate mode id "${mode.id}"`,
			);
		}
		seen.add(mode.id);
	}
	return doc;
}

/** Shallow-merge per key, with nested objects replaced wholesale (design §2.6). */
function mergeEntry(
	base: FailureModeV1Entry,
	patch: Partial<FailureModeV1Entry>,
): FailureModeV1Entry {
	return { ...base, ...patch, id: base.id };
}

export class FailureCatalog {
	private readonly byId: Map<string, FailureModeV1Entry>;
	/** Insertion order is match-precedence order. */
	private readonly ordered: FailureModeV1Entry[];

	private constructor(modes: FailureModeV1Entry[]) {
		this.ordered = modes;
		this.byId = new Map(modes.map((m) => [m.id, m]));
	}

	static load(args: LoadCatalogArgs = {}): FailureCatalog {
		const shippedPath = args.shippedPath ?? SHIPPED_CATALOG_PATH;
		const shipped = readDocument(shippedPath, "shipped");

		const merged = new Map<string, FailureModeV1Entry>();
		const order: string[] = [];
		for (const mode of shipped.modes) {
			merged.set(mode.id, mode);
			order.push(mode.id);
		}

		if (args.overridePath !== undefined && existsSync(args.overridePath)) {
			const overrideDoc = readDocument(args.overridePath, "override");
			for (const patch of overrideDoc.modes) {
				const existing = merged.get(patch.id);
				if (existing) {
					merged.set(patch.id, mergeEntry(existing, patch));
				} else {
					merged.set(patch.id, patch);
					order.push(patch.id);
				}
			}
		}

		// Validate the MERGED shape: an override may be partial, the result may not.
		for (const id of order) {
			const mode = merged.get(id);
			if (!Value.Check(CompleteModeSchema, mode)) {
				throw new FailureCatalogInvalid(
					`mode "${id}" is incomplete or malformed after merge: ${describeErrors(CompleteModeSchema, mode)}`,
				);
			}
		}

		const complete = order
			.map((id) => merged.get(id) as FailureModeV1Entry)
			.filter((m) => m.enabled !== false);

		validateCrossReferences(complete);
		return new FailureCatalog(complete);
	}

	lookup(id: string): FailureModeV1Entry | undefined {
		return this.byId.get(id);
	}

	matchesByClass(structuredClass: string): FailureModeV1Entry | undefined {
		return this.ordered.find(
			(m) =>
				m.detection.kind === "structured" &&
				m.detection.matches.includes(structuredClass),
		);
	}

	/**
	 * Resolve a failure signal to at most one mode. Structured evidence is
	 * checked first across all modes — a named error class is stronger evidence
	 * than a regex hit on prose.
	 */
	matches(failure: FailureSignal): FailureModeV1Entry | undefined {
		if (failure.structuredClass !== undefined) {
			const hit = this.matchesByClass(failure.structuredClass);
			if (hit) return hit;
		}

		for (const mode of this.ordered) {
			if (mode.detection.kind !== "regex") continue;
			const { pattern, flags, against, negate } = mode.detection;

			const primary = fieldFor(failure, against);
			// A negated rule asks "is the required shape absent?", which is only
			// answerable when the field it names was actually supplied. Falling
			// back to a sibling field would make it fire on every unrelated
			// signal that happens to omit the pattern.
			const haystack = negate ? primary : (primary ?? anyText(failure));
			if (haystack === undefined) continue;

			let re: RegExp;
			try {
				re = new RegExp(pattern, flags);
			} catch (err) {
				throw new FailureCatalogInvalid(
					`mode "${mode.id}" has an invalid regex: ${(err as Error).message}`,
				);
			}
			if (re.test(haystack) !== (negate === true)) return mode;
		}
		return undefined;
	}

	allIds(): string[] {
		return this.ordered.map((m) => m.id);
	}

	/** All entries in match-precedence order. */
	all(): FailureModeV1Entry[] {
		return [...this.ordered];
	}
}

function fieldFor(
	failure: FailureSignal,
	against: "stderr" | "verifier-output" | "free-text",
): string | undefined {
	const value =
		against === "stderr"
			? failure.stderr
			: against === "verifier-output"
				? failure.verifierOutput
				: failure.freeText;
	return value !== undefined && value !== "" ? value : undefined;
}

/** Any supplied text, for positive rules whose named field was not provided. */
function anyText(failure: FailureSignal): string | undefined {
	for (const v of [failure.stderr, failure.verifierOutput, failure.freeText]) {
		if (v !== undefined && v !== "") return v;
	}
	return undefined;
}

function validateCrossReferences(modes: FailureModeV1Entry[]): void {
	const ids = new Set(modes.map((m) => m.id));
	for (const mode of modes) {
		for (const sup of mode.supersedes ?? []) {
			if (!ids.has(sup)) {
				throw new FailureCatalogInvalid(
					`mode "${mode.id}" supersedes unknown mode "${sup}"`,
				);
			}
		}
		if (mode.handler.kind === "retry-subagent") {
			for (const name of templateVariables(mode.handler.feedbackTemplate)) {
				if (!(KNOWN_TEMPLATE_VARS as readonly string[]).includes(name)) {
					throw new FailureCatalogInvalid(
						`mode "${mode.id}" feedbackTemplate references unknown variable "${name}" (known: ${KNOWN_TEMPLATE_VARS.join(", ")})`,
					);
				}
			}
		}
		if (mode.detection.kind === "regex") {
			try {
				new RegExp(mode.detection.pattern, mode.detection.flags);
			} catch (err) {
				throw new FailureCatalogInvalid(
					`mode "${mode.id}" has an invalid regex: ${(err as Error).message}`,
				);
			}
		}
	}
}

// =============================================================================
// Feedback templates
// =============================================================================

const TEMPLATE_VAR_RE = /\{([a-z0-9_]+)\}/g;

/** Placeholder names referenced by a template, in first-appearance order. */
export function templateVariables(template: string): string[] {
	const out: string[] = [];
	for (const m of template.matchAll(TEMPLATE_VAR_RE)) {
		const name = m[1];
		if (name !== undefined && !out.includes(name)) out.push(name);
	}
	return out;
}

/**
 * Render a `feedbackTemplate`. Throws on a missing variable rather than
 * emitting a literal `{stderr_digest}` into a sub-agent's prompt — a visible
 * failure beats feeding the agent a placeholder it will try to interpret.
 */
export function renderFeedbackTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	const missing = templateVariables(template).filter((n) => !(n in vars));
	if (missing.length > 0) {
		throw new FailureCatalogInvalid(
			`feedbackTemplate is missing variable(s): ${missing.join(", ")}`,
		);
	}
	return template.replace(
		TEMPLATE_VAR_RE,
		(_m, name: string) => vars[name] ?? "",
	);
}

// =============================================================================
// Process-wide cache
// =============================================================================

let cached: FailureCatalog | undefined;

/**
 * The shipped catalog, loaded once per process. `writeDiagnostic` validates
 * every `cause` against this, so it sits on a hot-ish path.
 */
export function getFailureCatalog(cwd?: string): FailureCatalog {
	if (cached) return cached;
	const overridePath =
		cwd !== undefined ? resolve(cwd, PROJECT_OVERRIDE_RELPATH) : undefined;
	cached = FailureCatalog.load({ overridePath });
	return cached;
}

/** Test seam: drop the cached catalog. */
export function resetFailureCatalogCache(): void {
	cached = undefined;
}

/**
 * GC-2026-097 M5: synchronous boot-time validation. Throws
 * `FailureCatalogInvalid` at session_start (when the extension is
 * loaded) if the shipped catalog is missing or schema-invalid, so the
 * user sees "catalog broken" immediately instead of 4 tool calls
 * later when the first failure lookup happens deep in a workflow.
 *
 * Side effect: warms the singleton cache. Subsequent
 * `getFailureCatalog()` calls are no-ops.
 */
export function validateFailureCatalogOnBoot(): void {
	getFailureCatalog();
}
