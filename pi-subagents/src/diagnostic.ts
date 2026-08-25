/**
 * diagnostic.ts — GC-2026-044 mechanism 1.4 (design §6).
 *
 * Adapted from ai-sdlc RFC-0041 §4.4 + §5.2. When a sub-agent exits
 * non-cleanly today, the only record is a string in a tool result — which is
 * gone the moment the orchestrator's context is compacted. This module
 * makes that record a typed artefact on disk: self-contained, versioned, and
 * readable hours later by an orchestrator that has forgotten everything.
 *
 * `cause` draws from the mechanism-1.3 catalog, so the two mechanisms share
 * one vocabulary and `orchestrator_audit` can bucket diagnostics by mode.
 *
 * Failure policy (Q-G): the write is synchronous — losing the record of a
 * failure to a fire-and-forget race is worse than a few milliseconds of exit
 * latency — but it is bounded by a 1s wall-clock budget and NEVER throws for
 * an I/O reason. A sub-agent must not die because its post-mortem could not be
 * filed. Schema violations DO throw, because those are programmer errors that
 * should surface in tests, not at 3am.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getFailureCatalog } from "./failure-catalog.js";

/** Sub-agent-owned; deliberately outside `.pi/orchestrator/` (memory rule #23). */
export const DIAGNOSTICS_RELDIR = join(".pi", "diagnostics");

/** Design §6.2: enough forensic detail to avoid re-running the failing thing. */
const MAX_STDERR_DIGEST_BYTES = 4096;

/** Q-G: bound the synchronous write so a stuck filesystem cannot hang exit. */
const WRITE_BUDGET_MS = 1000;

export type DiagnosticOutcome =
	| "success"
	| "needs-work"
	| "stalled"
	| "aborted"
	| "error"
	| "crashed";

export interface DiagnosticEvidence {
	stderrDigest?: string;
	commitShas?: string[];
	prUrl?: string;
	verifierOutputs?: Array<{
		step: string;
		exitCode: number | null;
		outputDigest?: string;
	}>;
	worktreeLease?: { gitdir: string };
}

export interface DiagnosticJsonV1 {
	schemaVersion: "v1";
	emittedAt: string;
	dispatchId: string;
	context: { dagId?: string; taskId?: string; worktreeId?: string };
	subagentType: string;
	outcome: DiagnosticOutcome;
	cause: string;
	detail: string;
	evidence?: DiagnosticEvidence;
	retryBudgetLeft?: number;
	priorDispatchId?: string;
}

/** Thrown when a diagnostic's SHAPE is wrong. I/O failures do not throw. */
export class DiagnosticInvalid extends Error {
	constructor(message: string) {
		super(`diagnostic: ${message}`);
		this.name = "DiagnosticInvalid";
	}
}

const EvidenceSchema = Type.Object(
	{
		stderrDigest: Type.Optional(Type.String()),
		commitShas: Type.Optional(Type.Array(Type.String())),
		prUrl: Type.Optional(Type.String()),
		verifierOutputs: Type.Optional(
			Type.Array(
				Type.Object(
					{
						step: Type.String(),
						exitCode: Type.Union([Type.Integer(), Type.Null()]),
						outputDigest: Type.Optional(Type.String()),
					},
					{ additionalProperties: false },
				),
			),
		),
		worktreeLease: Type.Optional(
			Type.Object({ gitdir: Type.String() }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);

export const DiagnosticJsonV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal("v1"),
		emittedAt: Type.String({ minLength: 1 }),
		dispatchId: Type.String({ minLength: 1 }),
		context: Type.Object(
			{
				dagId: Type.Optional(Type.String()),
				taskId: Type.Optional(Type.String()),
				worktreeId: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		subagentType: Type.String({ minLength: 1 }),
		outcome: Type.Union([
			Type.Literal("success"),
			Type.Literal("needs-work"),
			Type.Literal("stalled"),
			Type.Literal("aborted"),
			Type.Literal("error"),
			Type.Literal("crashed"),
		]),
		cause: Type.String({ minLength: 1 }),
		detail: Type.String(),
		evidence: Type.Optional(EvidenceSchema),
		retryBudgetLeft: Type.Optional(Type.Integer({ minimum: 0 })),
		priorDispatchId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export interface WriteDiagnosticArgs {
	dispatchId: string;
	context?: { dagId?: string; taskId?: string; worktreeId?: string };
	subagentType: string;
	outcome: DiagnosticOutcome;
	cause: string;
	detail: string;
	evidence?: DiagnosticEvidence;
	retryBudgetLeft?: number;
	priorDispatchId?: string;
	emittedAt?: string;
	/** Target directory. Defaults to `<cwd>/.pi/diagnostics`. */
	dir?: string;
	/** Base for the default directory. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Validate `cause` against the catalog loaded for this root. */
	catalogCwd?: string;
}

/** Absolute path of the diagnostics directory for a repo root. */
export function diagnosticsDir(cwd: string = process.cwd()): string {
	return resolve(cwd, DIAGNOSTICS_RELDIR);
}

/** `<dispatchId>.json`, with separators neutralised so the id cannot escape the dir. */
function fileNameFor(dispatchId: string): string {
	return `${dispatchId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

function truncate(text: string): string {
	return text.length <= MAX_STDERR_DIGEST_BYTES
		? text
		: `${text.slice(0, MAX_STDERR_DIGEST_BYTES - 3)}...`;
}

/**
 * Write a diagnostic. Returns the path written, or `null` when the write was
 * dropped for an I/O reason or the 1s budget (a warning goes to stderr either
 * way). Throws `DiagnosticInvalid` only for a malformed payload.
 */
export function writeDiagnostic(
	args: WriteDiagnosticArgs,
): { path: string } | null {
	if (typeof args.dispatchId !== "string" || args.dispatchId.trim() === "") {
		throw new DiagnosticInvalid("dispatchId is required and must be non-empty");
	}

	const evidence = args.evidence
		? {
				...args.evidence,
				...(args.evidence.stderrDigest !== undefined
					? { stderrDigest: truncate(args.evidence.stderrDigest) }
					: {}),
			}
		: undefined;

	const record: DiagnosticJsonV1 = {
		schemaVersion: "v1",
		emittedAt: args.emittedAt ?? new Date().toISOString(),
		dispatchId: args.dispatchId,
		context: args.context ?? {},
		subagentType: args.subagentType,
		outcome: args.outcome,
		cause: args.cause,
		detail: args.detail,
		...(evidence ? { evidence } : {}),
		...(args.retryBudgetLeft !== undefined
			? { retryBudgetLeft: args.retryBudgetLeft }
			: {}),
		...(args.priorDispatchId !== undefined
			? { priorDispatchId: args.priorDispatchId }
			: {}),
	};

	if (!Value.Check(DiagnosticJsonV1Schema, record)) {
		const detail = [...Value.Errors(DiagnosticJsonV1Schema, record)]
			.slice(0, 5)
			.map((e) => `${e.path || "/"} ${e.message}`)
			.join("; ");
		throw new DiagnosticInvalid(`payload does not match v1 schema: ${detail}`);
	}

	// `cause` shares the mechanism-1.3 vocabulary. An unknown cause means the
	// catalog and the caller disagree, and a diagnostic nobody can bucket is
	// worse than a loud failure here.
	const known = getFailureCatalog(args.catalogCwd).allIds();
	if (!known.includes(record.cause)) {
		throw new DiagnosticInvalid(
			`cause "${record.cause}" is not in the failure-mode catalog (known: ${known.join(", ")})`,
		);
	}

	const targetDir = args.dir
		? isAbsolute(args.dir)
			? args.dir
			: resolve(args.cwd ?? process.cwd(), args.dir)
		: diagnosticsDir(args.cwd);
	const target = join(targetDir, fileNameFor(record.dispatchId));
	const tmp = `${target}.tmp`;
	const startedAt = Date.now();

	try {
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(record, null, "\t")}\n`, "utf-8");

		if (Date.now() - startedAt > WRITE_BUDGET_MS) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				/* best-effort */
			}
			console.error(
				`diagnostic: dropped ${target} — write exceeded ${WRITE_BUDGET_MS}ms budget`,
			);
			return null;
		}

		// Atomic on POSIX: tmp and target share a directory, so the reader sees
		// either the previous good copy or the new one, never a partial file.
		renameSync(tmp, target);
		return { path: target };
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* best-effort */
		}
		console.error(
			`diagnostic: failed to write ${target}: ${(err as Error).message}`,
		);
		return null;
	}
}

/**
 * Read a diagnostic. Returns `null` for a missing, unreadable, malformed, or
 * schema-invalid file — a corrupt post-mortem must not break the reader that
 * came to investigate.
 */
export function readDiagnostic(filePath: string): DiagnosticJsonV1 | null {
	if (filePath === "") return null;
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return Value.Check(DiagnosticJsonV1Schema, parsed)
		? (parsed as DiagnosticJsonV1)
		: null;
}

/** Every readable diagnostic in a directory, newest first. */
export function readAllDiagnostics(dirPath: string): DiagnosticJsonV1[] {
	let names: string[];
	try {
		names = readdirSync(dirPath);
	} catch {
		return [];
	}
	const out: DiagnosticJsonV1[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const parsed = readDiagnostic(join(dirPath, name));
		if (parsed) out.push(parsed);
	}
	return out.sort((a, b) => b.emittedAt.localeCompare(a.emittedAt));
}

/**
 * Drop diagnostics older than `retentionMs` (design §6.3). Called on sub-agent
 * startup so the directory cannot grow without bound. Never throws.
 */
export function pruneOldDiagnostics(
	dirPath: string,
	retentionMs: number,
): { removed: number } {
	if (!existsSync(dirPath)) return { removed: 0 };
	let names: string[];
	try {
		names = readdirSync(dirPath);
	} catch {
		return { removed: 0 };
	}

	const cutoff = Date.now() - Math.max(0, retentionMs);
	let removed = 0;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const p = join(dirPath, name);
		try {
			if (statSync(p).mtimeMs <= cutoff) {
				rmSync(p, { force: true });
				removed++;
			}
		} catch {
			/* skip unreadable entries */
		}
	}
	return { removed };
}

/** The subset of `RunResult` that decides whether a diagnostic is warranted. */
export interface RunResultSignal {
	aborted: boolean;
	steered: boolean;
	failure?: string;
}

export interface RunResultClassification {
	outcome: DiagnosticOutcome;
	cause: string;
	detail: string;
}

/**
 * Classify a finished run (design §6.4). Returns `null` for a clean run — the
 * caller writes a diagnostic only when there is something to explain.
 *
 * Kept as a pure function so the agent-runner wiring is testable without a live
 * pi session: the runner supplies the RunResult, this decides the verdict.
 */
export function diagnosticForRunResult(
	result: RunResultSignal,
	catalogCwd?: string,
): RunResultClassification | null {
	if (result.aborted) {
		return {
			outcome: "aborted",
			cause: "subagent-timeout",
			detail:
				result.failure ??
				"Sub-agent was hard-aborted after exceeding its turn or wall budget.",
		};
	}

	if (result.failure !== undefined && result.failure !== "") {
		// Let the catalog name the failure when it recognises one; the stderr
		// channel is the honest home for a runner-side error string.
		const matched = getFailureCatalog(catalogCwd).matches({
			stderr: result.failure,
		});
		return {
			outcome: matched?.kind === "spec" ? "needs-work" : "error",
			cause: matched?.id ?? "infra-unhandled",
			detail: result.failure,
		};
	}

	if (result.steered) {
		return {
			outcome: "needs-work",
			cause: "subagent-timeout",
			detail:
				"Sub-agent hit its soft turn limit and was steered to wrap up; the result may be incomplete.",
		};
	}

	return null;
}

/**
 * GC-2026-070 mechanism: push-notify the orchestrator session that a
 * diagnostic was written. Without this, the orchestrator only learns of a
 * sub-agent failure on the next `orchestrator_audit` poll — potentially
 * many turns later, and after the failure context has rolled out of
 * the LLM's context window.
 *
 * Pushes a single line via `pi.appendEntry("system", ...)` so the
 * orchestrator's next decision can see the cause + budget without
 * needing to re-read `.pi/diagnostics/`.
 *
 * Silent on success outcomes (a clean run doesn't need to bother the
 * orchestrator). Silent on read errors — this is best-effort notification,
 * not a primary signal.
 */
export function notifyOrchestrator(
	pi: { appendEntry: (channel: string, data: unknown) => void },
	diagnostic: DiagnosticJsonV1,
): void {
	// Only notify on actionable outcomes. Success → silent.
	if (diagnostic.outcome === "success") return;
	try {
		const budget =
			diagnostic.retryBudgetLeft !== undefined
				? `${diagnostic.retryBudgetLeft} retry(s) left`
				: "no retry budget";
		const line = `[subagent-failure] ${diagnostic.subagentType} ${diagnostic.dispatchId}: cause=${diagnostic.cause}, outcome=${diagnostic.outcome}, ${budget}. Detail: ${diagnostic.detail.slice(0, 200)}`;
		pi.appendEntry("system", line);
	} catch {
		/* never let notification failure mask the diagnostic write */
	}
}

/**
 * GC-2026-070 mechanism: compute `retryBudgetLeft` for a diagnostic write.
 *
 * The catalog declares `handler.retryBudget: N` for `retry-subagent` handlers —
 * the maximum number of retries the orchestrator should attempt for the same
 * cause on the same task. We persist the budget REMAINING (not the budget
 * itself) so the orchestrator's retry helper can read it back without needing
 * to re-load the catalog.
 *
 * `priorAttemptCount` lets the caller pass the count of attempts that
 * PRECEDED this one (the diagnostic write that calls this helper IS this
 * attempt, so it's not counted here). Defaults to 0 — the most common case
 * where `emitRunDiagnostic` runs after a fresh spawn with no prior chain.
 *
 * Returns `undefined` when the cause has no actionable retry handler
 * (escalate-to-l3 / mark-stalled / noop / unknown) — `writeDiagnostic` then
 * omits the `retryBudgetLeft` field entirely.
 */
export function retryBudgetLeftFor(
	cause: string,
	catalogCwd?: string,
	priorAttemptCount: number = 0,
): number | undefined {
	const mode = getFailureCatalog(catalogCwd).lookup(cause);
	if (!mode) return undefined;
	if (mode.handler.kind !== "retry-subagent") return undefined;
	const budget = mode.handler.retryBudget;
	if (!Number.isFinite(budget) || budget < 0) return undefined;
	// budget - (priorAttemptCount + 1)  ← this attempt + any earlier attempts in the chain
	const remaining = budget - (priorAttemptCount + 1);
	return Math.max(0, remaining);
}
