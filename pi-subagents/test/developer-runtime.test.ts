/**
 * developer-runtime.test.ts — Runtime invariants of `developer` after
 * GC-2026-014.
 *
 * GC-2026-014 removed the entire alias infrastructure (DAG-2026-011
 * Phase A + B): the `software-developer` legacy spelling no longer
 * resolves, and `AgentConfig.aliases` is gone from the type. This file
 * pins the post-removal invariants:
 *
 *   1. The canonical `developer` name resolves; the legacy spelling
 *      resolves as undefined.
 *   2. `getAvailableTypes()` does NOT advertise the legacy alias name.
 *   3. `DEFAULT_AGENTS` does not carry a duplicate legacy roster entry.
 *   4. `normalizeWorktreeIsolation` still rejects the legacy
 *      `"worktree"` literal for any caller (defense-in-depth — the
 *      dispatcher surfaces a precise error rather than a silent
 *      /tmp fallback).
 *   5. `enforceDeveloperManagedIsolationPolicy` accepts a valid
 *      managed-worktree object verbatim and rejects every legacy /
 *      malformed shape uniformly.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import {
	getAgentConfig,
	getAvailableTypes,
	registerAgents,
	resolveType,
	setDefaultsDisabled,
} from "../src/agent-types.js";
import { enforceDeveloperManagedIsolationPolicy } from "../src/invocation-config.js";
import {
	normalizeWorktreeIsolation,
	parseLegacyIsolationField,
} from "../src/worktree-contract.js";

const CANONICAL = "developer";
const LEGACY_ALIAS = "software-developer";

describe("developer-runtime: canonical developer resolves, legacy alias does not (GC-2026-014)", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("resolveType returns the canonical name for the canonical spelling", () => {
		expect(resolveType(CANONICAL)).toBe(CANONICAL);
	});

	it("resolveType returns undefined for the legacy alias spelling", () => {
		expect(resolveType(LEGACY_ALIAS)).toBeUndefined();
	});

	it("getAgentConfig returns undefined for the legacy alias spelling", () => {
		expect(getAgentConfig(LEGACY_ALIAS)).toBeUndefined();
	});

	it("enforceDeveloperManagedIsolationPolicy is a no-op for the legacy alias (it is no longer a developer)", () => {
		// The policy is `developer`-specific. Legacy callers that survive
		// past resolveType's unknown-name rejection (e.g. cross-extension
		// RPC bypassing the dispatcher) will not be policy-checked here;
		// they fall through with undefined isolation, and the spawn fails
		// upstream on the unknown-type rejection. Pin the policy shape
		// anyway so future contributors don't widen it back to the
		// legacy spelling.
		expect(
			enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, "worktree"),
		).toBeUndefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, undefined),
		).toBeUndefined();
	});
});

describe("developer-runtime: getAvailableTypes does NOT advertise the alias", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("lists the canonical `developer` in available types", () => {
		const types = getAvailableTypes();
		expect(types).toContain(CANONICAL);
	});

	it("does NOT list the removed legacy alias in available types", () => {
		const types = getAvailableTypes();
		expect(types).not.toContain(LEGACY_ALIAS);
	});

	it("DEFAULT_AGENTS does not carry a duplicate alias roster entry", () => {
		expect(DEFAULT_AGENTS.has(LEGACY_ALIAS)).toBe(false);
	});
});

describe("developer-runtime: normalizeWorktreeIsolation rejects the legacy literal", () => {
	it("returns undefined for undefined / null", () => {
		expect(normalizeWorktreeIsolation(undefined)).toBeUndefined();
		expect(normalizeWorktreeIsolation(null)).toBeUndefined();
	});

	it("throws on the legacy `worktree` literal", () => {
		expect(() => normalizeWorktreeIsolation("worktree")).toThrow(/worktree/i);
	});

	it("throws on an unrelated string literal", () => {
		expect(() => normalizeWorktreeIsolation("branch")).toThrow(
			/not a recognized isolation/i,
		);
	});

	it("parses a valid explicit object verbatim", () => {
		const req = normalizeWorktreeIsolation({
			dag_id: "DAG-2026-014",
			task_id: "P1",
			mode: "create",
		});
		expect(req).toBeDefined();
		expect(req?.dag_id).toBe("DAG-2026-014");
		expect(req?.task_id).toBe("P1");
		expect(req?.mode).toBe("create");
	});

	it("parseLegacyIsolationField recognizes only the canonical `worktree` literal", () => {
		expect(parseLegacyIsolationField("worktree")).toBe("worktree");
		expect(parseLegacyIsolationField(undefined)).toBeUndefined();
		expect(() => parseLegacyIsolationField("branch")).toThrow();
	});
});

describe("developer-runtime: enforceDeveloperManagedIsolationPolicy unit checks", () => {
	it("accepts a valid managed-worktree object under the canonical name", () => {
		const ok = enforceDeveloperManagedIsolationPolicy(CANONICAL, {
			dag_id: "DAG-2026-014",
			task_id: "P1",
			mode: "create",
		});
		expect(ok).toBeUndefined();
	});

	it("rejects the legacy literal under the canonical name", () => {
		const err = enforceDeveloperManagedIsolationPolicy(CANONICAL, "worktree");
		expect(err).toBeDefined();
		expect(err).toMatch(/developer/i);
		expect(err).toMatch(/worktree/i);
		expect(err).toMatch(/explicit/i);
	});

	it("rejects undefined / null / unrelated strings under the canonical name", () => {
		expect(enforceDeveloperManagedIsolationPolicy(CANONICAL, undefined)).toBeDefined();
		expect(enforceDeveloperManagedIsolationPolicy(CANONICAL, null)).toBeDefined();
		expect(enforceDeveloperManagedIsolationPolicy(CANONICAL, "")).toBeDefined();
		expect(enforceDeveloperManagedIsolationPolicy(CANONICAL, "branch")).toBeDefined();
	});

	it("rejects malformed managed-worktree objects under the canonical name", () => {
		expect(enforceDeveloperManagedIsolationPolicy(CANONICAL, {} as any)).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(CANONICAL, {
				dag_id: "DAG-1",
			} as any),
		).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(CANONICAL, {
				dag_id: "DAG-1",
				task_id: "P1",
				mode: "explode",
			} as any),
		).toBeDefined();
	});

	it("is case-insensitive on the canonical name (Developer, DEVELOPER)", () => {
		const err = enforceDeveloperManagedIsolationPolicy("Developer", "worktree");
		expect(err).toBeDefined();
		expect(err).toMatch(/developer/i);
	});
});
