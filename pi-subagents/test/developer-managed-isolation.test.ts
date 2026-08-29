/**
 * developer-managed-isolation.test.ts — Required managed-isolation policy.
 *
 * Phase A P1 (DAG-2026-011): `developer` is a write-in-worktree agent. The
 * legacy `isolation: "worktree"` literal is no longer accepted by the Agent
 * tool — the package policy for `developer` is therefore encoded at the
 * dispatcher, requiring the **explicit managed-worktree object form**:
 *
 *     {
 *       dag_id: string,
 *       task_id: string,
 *       worktree_id?: string,
 *       mode: "create" | "reuse",
 *     }
 *
 * The legacy string literal is rejected before child execution. This test
 * file pins the policy down so a future refactor can't quietly fall back to
 * the /tmp-backed ephemeral worktree.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { enforceDeveloperManagedIsolationPolicy } from "../src/invocation-config.js";

const DEV = "Developer";

describe("developer-managed-isolation: policy", () => {
	it("Developer is the canonical agent the policy targets (sanity)", () => {
		expect(DEFAULT_AGENTS.has(DEV)).toBe(true);
	});

	it("passes when caller supplies an explicit managed-worktree object", () => {
		const ok = enforceDeveloperManagedIsolationPolicy(DEV, {
			dag_id: "DAG-2026-011",
			task_id: "P1",
			mode: "create",
		});
		expect(ok).toBeUndefined();
	});

	it("accepts `reuse` mode too", () => {
		const ok = enforceDeveloperManagedIsolationPolicy(DEV, {
			dag_id: "DAG-2026-011",
			task_id: "P1",
			mode: "reuse",
		});
		expect(ok).toBeUndefined();
	});

	it("rejects the legacy `isolation: 'worktree'` literal", () => {
		const err = enforceDeveloperManagedIsolationPolicy(DEV, "worktree");
		expect(err).toBeDefined();
		expect(err).toMatch(/developer/i);
		expect(err).toMatch(/worktree/i);
		expect(err).toMatch(/explicit/i);
	});

	it("rejects undefined (no isolation supplied) — developer must always run in a managed worktree", () => {
		const err = enforceDeveloperManagedIsolationPolicy(DEV, undefined);
		expect(err).toBeDefined();
		expect(err).toMatch(/developer/i);
	});

	it("rejects null and unrelated strings", () => {
		expect(enforceDeveloperManagedIsolationPolicy(DEV, null)).toBeDefined();
		expect(enforceDeveloperManagedIsolationPolicy(DEV, "branch")).toBeDefined();
		expect(enforceDeveloperManagedIsolationPolicy(DEV, "")).toBeDefined();
	});

	it("rejects malformed managed-worktree objects (missing required fields)", () => {
		expect(
			enforceDeveloperManagedIsolationPolicy(DEV, {} as any),
		).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(DEV, { dag_id: "DAG-1" } as any),
		).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(DEV, {
				dag_id: "DAG-1",
				task_id: "P1",
			} as any),
		).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(DEV, {
				dag_id: "DAG-1",
				task_id: "P1",
				mode: "explode",
			} as any),
		).toBeDefined();
	});

	it("does NOT apply the policy to other built-in agents (Explore/Plan)", () => {
		// The policy is `developer`-specific; Explore/Plan are read-only
		// and run without isolation by default. `general-purpose` was
		// removed in DAG-2026-011 Phase C — passing that name is now
		// treated as an unknown subagent type (no policy applied, but the
		// Agent tool surfaces an "unknown agent type" error earlier in
		// the dispatch chain).
		expect(
			enforceDeveloperManagedIsolationPolicy("Explore", undefined),
		).toBeUndefined();
		expect(
			enforceDeveloperManagedIsolationPolicy("Plan", undefined),
		).toBeUndefined();
		expect(
			enforceDeveloperManagedIsolationPolicy("general-purpose", undefined),
		).toBeUndefined();
	});

	it("does NOT apply the policy to unknown / undefined subagent types", () => {
		// If a caller passes a typo or a custom user-defined agent that
		// isn't `developer`, the policy must be a no-op (the underlying
		// generic dispatcher handles the literal rejection separately).
		expect(
			enforceDeveloperManagedIsolationPolicy("does-not-exist", undefined),
		).toBeUndefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(undefined as any, undefined),
		).toBeUndefined();
	});
});

describe("developer-managed-isolation: current-workspace mode (GC-2026-017)", () => {
	// GC-2026-017 adds `isolation: "current-workspace"` as an explicit
	// opt-in for callers that want `developer` to run in the caller's
	// own cwd instead of a managed worktree (e.g. meta-file edits,
	// single-line AGENTS.md patches). The mode is **NOT** the default —
	// the worktree object form remains the canonical surface — but it
	// must pass the policy so callers can opt-in explicitly.

	it("accepts `isolation: 'current-workspace'` and returns undefined (pass-through)", () => {
		const ok = enforceDeveloperManagedIsolationPolicy(DEV, "current-workspace");
		expect(ok).toBeUndefined();
	});

	it("still rejects `isolation: 'branch'` (no implicit provision of an unrelated mode)", () => {
		// The new mode is a literal — it does not imply that every
		// string literal now passes. Other unrelated literals must
		// remain rejected so a typo does not silently disable the
		// policy.
		expect(enforceDeveloperManagedIsolationPolicy(DEV, "branch")).toBeDefined();
	});

	it("still rejects `isolation: 'no-isolation'` (must be explicit)", () => {
		// Explicit-only policy is preserved: callers must pass either
		// the explicit worktree object OR the new `current-workspace`
		// literal. Any other string is rejected.
		expect(
			enforceDeveloperManagedIsolationPolicy(DEV, "no-isolation"),
		).toBeDefined();
	});
});
