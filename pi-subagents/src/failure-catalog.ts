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
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

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
	| "auditor";

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
	"dag_id",
	"mode_id",
	"verifier_output",
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the shipped default catalog. */
export const SHIPPED_CATALOG_PATH = join(HERE, "data", "failure-modes.v1.yaml");

/** Project override path, relative to a repo root (design §2.1). */
export const PROJECT_OVERRIDE_RELPATH = join(".pi", "failure-modes.yaml");

// =============================================================================
// YAML subset parser
// =============================================================================

interface Line {
	indent: number;
	text: string;
	/** 1-based source line, for error messages that a human can act on. */
	no: number;
}

/**
 * Strip a trailing `#` comment, honouring double- and single-quoted scalars so
 * a `#` inside a regex survives.
 */
function stripComment(raw: string): string {
	let inDouble = false;
	let inSingle = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (inDouble) {
			if (c === "\\") i++;
			else if (c === '"') inDouble = false;
			continue;
		}
		if (inSingle) {
			if (c === "'") inSingle = false;
			continue;
		}
		if (c === '"') inDouble = true;
		else if (c === "'") inSingle = true;
		else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1] ?? ""))) {
			return raw.slice(0, i);
		}
	}
	return raw;
}

function parseScalar(raw: string, lineNo: number): unknown {
	const s = raw.trim();
	if (s === "") return null;
	if (s.startsWith('"')) {
		try {
			return JSON.parse(s) as string;
		} catch {
			throw new FailureCatalogInvalid(
				`line ${lineNo}: malformed double-quoted scalar ${s}`,
			);
		}
	}
	if (s.startsWith("'")) {
		if (!s.endsWith("'") || s.length < 2) {
			throw new FailureCatalogInvalid(
				`line ${lineNo}: unterminated single-quoted scalar ${s}`,
			);
		}
		return s.slice(1, -1).replace(/''/g, "'");
	}
	// Inline flow sequence: `[a, b]`.
	if (s.startsWith("[")) {
		if (!s.endsWith("]")) {
			throw new FailureCatalogInvalid(
				`line ${lineNo}: unterminated inline sequence ${s}`,
			);
		}
		const inner = s.slice(1, -1).trim();
		if (inner === "") return [];
		return splitFlow(inner, lineNo).map((part) => parseScalar(part, lineNo));
	}
	if (s === "true") return true;
	if (s === "false") return false;
	if (s === "null" || s === "~") return null;
	if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
	if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s);
	return s;
}

/** Split `a, "b, c", d` on top-level commas only. */
function splitFlow(inner: string, lineNo: number): string[] {
	const out: string[] = [];
	let depth = 0;
	let inDouble = false;
	let inSingle = false;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (inDouble) {
			if (c === "\\") i++;
			else if (c === '"') inDouble = false;
			continue;
		}
		if (inSingle) {
			if (c === "'") inSingle = false;
			continue;
		}
		if (c === '"') inDouble = true;
		else if (c === "'") inSingle = true;
		else if (c === "[") depth++;
		else if (c === "]") depth--;
		else if (c === "," && depth === 0) {
			out.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	if (inDouble || inSingle) {
		throw new FailureCatalogInvalid(`line ${lineNo}: unterminated quote`);
	}
	out.push(inner.slice(start));
	return out.map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * Parse the YAML subset the catalog uses: nested mappings, `- ` sequences,
 * inline `[...]` sequences, quoted / plain scalars, `#` comments, and `|` /
 * `|-` block scalars. Anything outside the subset throws rather than being
 * silently reinterpreted.
 */
export function parseCatalogYaml(input: string): unknown {
	const lines: Line[] = [];
	const rawLines = input.replace(/\r\n?/g, "\n").split("\n");

	for (let i = 0; i < rawLines.length; i++) {
		const raw = rawLines[i] ?? "";
		if (/^\s*\t/.test(raw)) {
			throw new FailureCatalogInvalid(
				`line ${i + 1}: tab indentation is not supported; use spaces`,
			);
		}
		const withoutComment = stripComment(raw);
		if (withoutComment.trim() === "") continue;
		lines.push({
			indent: withoutComment.length - withoutComment.trimStart().length,
			text: withoutComment.trim(),
			no: i + 1,
		});
	}

	if (lines.length === 0) return {};

	// Block scalars need the ORIGINAL lines (comments and blanks inside a block
	// are literal content), so they are resolved against `rawLines` by index.
	const ctx = { lines, pos: 0, rawLines };
	const value = parseBlock(ctx, lines[0]?.indent ?? 0);
	if (ctx.pos < ctx.lines.length) {
		const stray = ctx.lines[ctx.pos];
		throw new FailureCatalogInvalid(
			`line ${stray?.no}: unexpected indentation at "${stray?.text}"`,
		);
	}
	return value;
}

interface Ctx {
	lines: Line[];
	pos: number;
	rawLines: string[];
}

function parseBlock(ctx: Ctx, indent: number): unknown {
	const first = ctx.lines[ctx.pos];
	if (!first) return null;
	return first.text.startsWith("- ") || first.text === "-"
		? parseSequence(ctx, indent)
		: parseMapping(ctx, indent);
}

function parseMapping(ctx: Ctx, indent: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	while (ctx.pos < ctx.lines.length) {
		const line = ctx.lines[ctx.pos];
		if (!line || line.indent < indent) break;
		if (line.indent > indent) {
			throw new FailureCatalogInvalid(
				`line ${line.no}: unexpected indentation at "${line.text}"`,
			);
		}
		const m = line.text.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
		if (!m || m[1] === undefined) {
			throw new FailureCatalogInvalid(
				`line ${line.no}: expected "key: value", got "${line.text}"`,
			);
		}
		const key = m[1];
		const rest = (m[2] ?? "").trim();
		ctx.pos++;
		out[key] = parseValueAfterKey(ctx, indent, rest, line);
	}
	return out;
}

function parseValueAfterKey(
	ctx: Ctx,
	indent: number,
	rest: string,
	line: Line,
): unknown {
	if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
		return parseBlockScalar(ctx, indent, rest, line);
	}
	if (rest !== "") return parseScalar(rest, line.no);

	const next = ctx.lines[ctx.pos];
	if (!next || next.indent <= indent) return null;
	return parseBlock(ctx, next.indent);
}

/**
 * Block scalars are read from the raw source, not the comment-stripped line
 * list: inside a `|` block a `#` is content and a blank line is a blank line.
 */
function parseBlockScalar(
	ctx: Ctx,
	indent: number,
	marker: string,
	header: Line,
): string {
	const folded = marker.startsWith(">");
	const strip = marker.endsWith("-");

	// Content indentation is set by the first non-blank line after the header.
	let cursor = header.no; // 0-based index of the line AFTER the header
	let contentIndent = -1;
	const body: string[] = [];

	while (cursor < ctx.rawLines.length) {
		const raw = ctx.rawLines[cursor] ?? "";
		const isBlank = raw.trim() === "";
		const thisIndent = raw.length - raw.trimStart().length;

		if (!isBlank) {
			if (contentIndent === -1) {
				if (thisIndent <= indent) break;
				contentIndent = thisIndent;
			} else if (thisIndent < contentIndent) {
				break;
			}
		}
		body.push(isBlank ? "" : raw.slice(contentIndent));
		cursor++;
	}

	// Drop trailing blanks, then advance the token cursor past the block.
	while (body.length > 0 && body[body.length - 1] === "") body.pop();
	while (
		ctx.pos < ctx.lines.length &&
		(ctx.lines[ctx.pos]?.no ?? 0) <= cursor
	) {
		ctx.pos++;
	}

	const joined = folded
		? body.join(" ").replace(/\s+/g, " ").trim()
		: body.join("\n");
	return strip ? joined : `${joined}\n`;
}

function parseSequence(ctx: Ctx, indent: number): unknown[] {
	const out: unknown[] = [];
	while (ctx.pos < ctx.lines.length) {
		const line = ctx.lines[ctx.pos];
		if (!line || line.indent < indent) break;
		if (line.indent > indent) {
			throw new FailureCatalogInvalid(
				`line ${line.no}: unexpected indentation at "${line.text}"`,
			);
		}
		if (!line.text.startsWith("- ") && line.text !== "-") break;

		const after = line.text === "-" ? "" : line.text.slice(2).trim();
		ctx.pos++;

		if (after === "") {
			const next = ctx.lines[ctx.pos];
			if (!next || next.indent <= indent) {
				out.push(null);
				continue;
			}
			out.push(parseBlock(ctx, next.indent));
			continue;
		}

		// `- key: value` opens a mapping whose keys align at the item's column.
		const kv = after.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
		if (!kv || kv[1] === undefined) {
			out.push(parseScalar(after, line.no));
			continue;
		}
		const itemIndent = indent + 2;
		const obj: Record<string, unknown> = {};
		obj[kv[1]] = parseValueAfterKey(
			ctx,
			itemIndent,
			(kv[2] ?? "").trim(),
			line,
		);
		// Remaining keys of this item sit at `itemIndent`.
		while (ctx.pos < ctx.lines.length) {
			const cont = ctx.lines[ctx.pos];
			if (!cont || cont.indent !== itemIndent) break;
			if (cont.text.startsWith("- ")) break;
			const cm = cont.text.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
			if (!cm || cm[1] === undefined) {
				throw new FailureCatalogInvalid(
					`line ${cont.no}: expected "key: value", got "${cont.text}"`,
				);
			}
			ctx.pos++;
			obj[cm[1]] = parseValueAfterKey(
				ctx,
				itemIndent,
				(cm[2] ?? "").trim(),
				cont,
			);
		}
		out.push(obj);
	}
	return out;
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
	Type.Literal("auditor"),
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
	schema: Parameters<typeof Value.Errors>[0],
	value: unknown,
): string {
	return [...Value.Errors(schema, value)]
		.slice(0, 5)
		.map((e) => `${e.path || "/"} ${e.message}`)
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
