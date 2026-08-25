/**
 * retry-helper.ts — GC-2026-070 mechanism: orchestrator-side re-dispatch helper.
 *
 * Bridges the failure-mode catalog (declared in `pi-subagents/src/data/failure-modes.v1.yaml`)
 * to a structured suggestion the orchestrator LLM can act on. The catalog's
 * `handler.kind` discriminates three re-dispatch shapes:
 *
 *   - `retry-subagent` → render `feedbackTemplate` with prior stderr digest
 *     attached, return `{promptPrefix, retryBudgetLeft, suggestedIsolation: "reuse"}`.
 *   - `escalate-to-l3` → return the escalation note verbatim; budget = 0.
 *   - `mark-stalled`   → return the stall note; no prompt prefix.
 *   - anything else    → return `{noop: true}`.
 *
 * Why this file lives in `pi-orchestrator/` and not `pi-subagents/`: the helper
 * serves the orchestrator's decision loop, not the sub-agent's runtime. The
 * sub-agent's `AgentManager` owns `mode: "reuse"` worktree reuse (already
 * implemented); the orchestrator picks the call shape via `buildReDispatchSuggestion`.
 *
 * Cross-package import note: the failure-catalog lives in pi-subagents. The
 * `@ts-ignore` below mirrors the precedent in `orchestrator-audit.ts:53-56` —
 * runtime resolution is correct (Node ESM, monorepo) but tsc's rootDir check
 * rejects the relative path under package boundaries.
 */
// @ts-ignore -- tsc rejects cross-package imports under rootDir.
import { getFailureCatalog, renderFeedbackTemplate } from "../../pi-subagents/src/failure-catalog.js";

/**
 * Minimal shape we need from a DiagnosticJsonV1. We don't import the full
 * type because that would create a circular import (diagnostic.ts also imports
 * from failure-catalog.ts) and the helper is intentionally decoupled — it
 * accepts whatever diagnostic-like object the caller has.
 */
export interface PriorDiagnosticLike {
	cause: string;
	outcome: string;
	detail: string;
	evidence?: { stderrDigest?: string };
	retryBudgetLeft?: number;
}

/**
 * A single re-dispatch suggestion, shaped for direct consumption by the
 * orchestrator LLM. Only one of the `*` fields is populated per call.
 */
export type ReDispatchSuggestion =
	| {
			kind: "retry-subagent";
			cause: string;
			causeName: string;
			/** Rendered feedback template, ready to prepend to the new Agent prompt. */
			promptPrefix: string;
			/** Remaining attempts after this dispatch; 0 means stop. */
			retryBudgetLeft: number;
			/** Always "reuse" — the catalog only retries into the prior worktree. */
			suggestedIsolation: "reuse";
	  }
	| {
			kind: "escalate-to-l3";
			cause: string;
			causeName: string;
			/** Verbatim from catalog handler.note; surface to the orchestrator. */
			escalationNote: string;
			retryBudgetLeft: 0;
	  }
	| {
			kind: "mark-stalled";
			cause: string;
			causeName: string;
			stallNote: string;
	  }
	| {
			kind: "noop";
			cause: string;
			reason: "unknown-cause" | "handler-not-actionable";
	  };

/**
 * Build a re-dispatch suggestion from a prior diagnostic.
 *
 * Pure function — no I/O, no side effects. Caller is responsible for reading
 * the diagnostic from disk (typically via `readDiagnostic` from pi-subagents)
 * and for actually invoking the `Agent` tool with the returned `promptPrefix`
 * + `suggestedIsolation`. The orchestrator LLM remains the decision-maker.
 *
 * Failure modes with `handler.kind === "retry-subagent"` decrement the
 * remaining budget: if `priorDiagnostic.retryBudgetLeft === 0`, the helper
 * refuses to render (returns `kind: "noop", reason: "handler-not-actionable"`)
 * so the orchestrator gets a clean signal to escalate instead.
 */
export function buildReDispatchSuggestion(
	prior: PriorDiagnosticLike,
	cwd?: string,
): ReDispatchSuggestion {
	const catalog = getFailureCatalog(cwd);
	const mode = catalog.lookup(prior.cause);
	if (!mode) {
		return { kind: "noop", cause: prior.cause, reason: "unknown-cause" };
	}

	if (mode.handler.kind === "retry-subagent") {
		// Budget check: if the prior diagnostic already shows 0 left, the
		// catalog's handler shouldn't fire again. Surface as noop so the
		// orchestrator escalates rather than retrying into a closed loop.
		if (prior.retryBudgetLeft !== undefined && prior.retryBudgetLeft <= 0) {
			return {
				kind: "noop",
				cause: prior.cause,
				reason: "handler-not-actionable",
			};
		}

		const stderrDigest = prior.evidence?.stderrDigest ?? prior.detail;
		const promptPrefix = renderFeedbackTemplate(mode.handler.feedbackTemplate, {
			stderr_digest: stderrDigest,
		});

		// Compute remaining budget: prior may report what's left, or we infer
		// from the catalog's full budget (this would be attempt 1 of N).
		const fullBudget = mode.handler.retryBudget;
		const retryBudgetLeft =
			prior.retryBudgetLeft !== undefined
				? Math.max(0, prior.retryBudgetLeft - 1)
				: Math.max(0, fullBudget - 1);

		return {
			kind: "retry-subagent",
			cause: prior.cause,
			causeName: mode.name,
			promptPrefix,
			retryBudgetLeft,
			suggestedIsolation: "reuse",
		};
	}

	if (mode.handler.kind === "escalate-to-l3") {
		return {
			kind: "escalate-to-l3",
			cause: prior.cause,
			causeName: mode.name,
			escalationNote: mode.handler.note,
			retryBudgetLeft: 0,
		};
	}

	if (mode.handler.kind === "mark-stalled") {
		return {
			kind: "mark-stalled",
			cause: prior.cause,
			causeName: mode.name,
			stallNote: mode.handler.note,
		};
	}

	// `noop` and any future handler kinds land here — surfaced as noop so the
	// orchestrator gets a clean "do nothing automatic" signal rather than
	// silently falling back to the retry-subagent path.
	return {
		kind: "noop",
		cause: prior.cause,
		reason: "handler-not-actionable",
	};
}