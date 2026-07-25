/**
 * developer-runtime.test.ts — Phase A P2 runtime enforcement.
 *
 * Phase A P1 wired the *policy* (`enforceDeveloperManagedIsolationPolicy`)
 * for the canonical `developer` agent. Phase A P2 enforces that policy
 * at the Agent-tool runtime boundary — both for the canonical name and
 * for the Phase A alias `software-developer`. This file pins down:
 *
 *   1. The alias name `software-developer` resolves to the same policy
 *      as the canonical `developer` (same accept set, same reject set).
 *   2. `getAvailableTypes()` does NOT advertise the alias name; the
 *      canonical `developer` is the only public roster entry.
 *   3. `normalizeWorktreeIsolation` rejects the legacy `"worktree"`
 *      literal for any caller (defense-in-depth — the dispatcher
 *      surfaces a precise error rather than a silent /tmp fallback).
 *   4. `enforceDeveloperManagedIsolationPolicy` accepts a valid
 *      managed-worktree object verbatim for both names and rejects
 *      every legacy / malformed shape uniformly.
 *   5. The alias metadata (`alias: true, deprecated: true`) round-trips
 *      through `resolveAgentType` exactly as required by P2.6.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import {
	getAvailableTypes,
	registerAgents,
	resolveAgentType,
	setDefaultsDisabled,
} from "../src/agent-types.js";
import { enforceDeveloperManagedIsolationPolicy } from "../src/invocation-config.js";
import {
	normalizeWorktreeIsolation,
	parseLegacyIsolationField,
} from "../src/worktree-contract.js";

const CANONICAL = "developer";
const LEGACY_ALIAS = "software-developer";

describe("developer-runtime: alias name also triggers managed-isolation policy", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("accepts a valid managed-worktree object under the alias name", () => {
		const ok = enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, {
			dag_id: "DAG-2026-011",
			task_id: "P2",
			mode: "create",
		});
		expect(ok).toBeUndefined();
	});

	it("rejects the legacy literal under the alias name (same message family)", () => {
		const err = enforceDeveloperManagedIsolationPolicy(
			LEGACY_ALIAS,
			"worktree",
		);
		expect(err).toBeDefined();
		expect(err).toMatch(/developer/i);
		expect(err).toMatch(/worktree/i);
		expect(err).toMatch(/explicit/i);
	});

	it("rejects undefined / null / unrelated strings under the alias name", () => {
		expect(
			enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, undefined),
		).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, null),
		).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, ""),
		).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, "branch"),
		).toBeDefined();
	});

	it("rejects malformed managed-worktree objects under the alias name", () => {
		expect(
			enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, {} as any),
		).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, {
				dag_id: "DAG-1",
			} as any),
		).toBeDefined();
		expect(
			enforceDeveloperManagedIsolationPolicy(LEGACY_ALIAS, {
				dag_id: "DAG-1",
				task_id: "P1",
				mode: "explode",
			} as any),
		).toBeDefined();
	});

	it("is case-insensitive on the alias name (Software-Developer, etc.)", () => {
		const err = enforceDeveloperManagedIsolationPolicy(
			"Software-Developer",
			"worktree",
		);
		expect(err).toBeDefined();
		expect(err).toMatch(/developer/i);
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

	it("does NOT list the Phase A alias in available types", () => {
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
			dag_id: "DAG-2026-011",
			task_id: "P2",
			mode: "create",
		});
		expect(req).toBeDefined();
		expect(req?.dag_id).toBe("DAG-2026-011");
		expect(req?.task_id).toBe("P2");
		expect(req?.mode).toBe("create");
	});

	it("parseLegacyIsolationField recognizes only the canonical `worktree` literal", () => {
		expect(parseLegacyIsolationField("worktree")).toBe("worktree");
		expect(parseLegacyIsolationField(undefined)).toBeUndefined();
		expect(() => parseLegacyIsolationField("branch")).toThrow();
	});
});

describe("developer-runtime: alias metadata round-trips", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("resolveAgentType returns alias:true, deprecated:true for the legacy spelling", () => {
		const r = resolveAgentType(LEGACY_ALIAS);
		expect(r).toBeDefined();
		expect(r!.requested).toBe(LEGACY_ALIAS);
		expect(r!.canonical).toBe(CANONICAL);
		expect(r!.alias).toBe(true);
		expect(r!.deprecated).toBe(true);
	});

	it("resolveAgentType returns alias:false, deprecated:false for the canonical spelling", () => {
		const r = resolveAgentType(CANONICAL);
		expect(r).toBeDefined();
		expect(r!.requested).toBe(CANONICAL);
		expect(r!.canonical).toBe(CANONICAL);
		expect(r!.alias).toBe(false);
		expect(r!.deprecated).toBe(false);
	});

	it("resolveAgentType preserves case on the requested field", () => {
		const r = resolveAgentType("Software-Developer");
		expect(r!.requested).toBe("Software-Developer");
		expect(r!.canonical).toBe(CANONICAL);
		expect(r!.alias).toBe(true);
	});
});
