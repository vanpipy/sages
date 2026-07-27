/**
 * developer-alias.test.ts — Phase A alias resolution.
 *
 * Phase A P1 (DAG-2026-011): the canonical built-in is `developer`. The
 * legacy Sages name `software-developer` is preserved as an alias so
 * existing orchestrators and audit consumers don't break. The alias is
 * surfaced with `requested / canonical / alias / deprecated` metadata so
 * callers can warn / migrate without a separate roster entry.
 *
 * Invariants pinned here:
 *   - `developer` resolves to itself with alias=false, deprecated=false.
 *   - `software-developer` resolves to `developer` with alias=true,
 *     deprecated=true, and the request was the legacy name.
 *   - Case-insensitive lookups work for both names.
 *   - The custom-precedence rules (project > workspace > global) are
 *     preserved: a user-defined `software-developer` in .pi/agents
 *     shadows the alias. The test doesn't author one — it only verifies
 *     that resolveAgentType keeps the existing precedence hooks
 *     (registerAgents / getAgentConfig) intact.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	isDefaultsDisabled,
	registerAgents,
	resolveAgentType,
	setDefaultsDisabled,
} from "../src/agent-types.js";

describe("developer-alias: resolveAgentType", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("resolves `developer` to itself with no alias / no deprecation", () => {
		const r = resolveAgentType("developer");
		expect(r).toBeDefined();
		expect(r!.requested).toBe("developer");
		expect(r!.canonical).toBe("developer");
		expect(r!.alias).toBe(false);
		expect(r!.deprecated).toBe(false);
	});

	it("resolves `software-developer` to canonical `developer` (alias, deprecated)", () => {
		const r = resolveAgentType("software-developer");
		expect(r).toBeDefined();
		expect(r!.requested).toBe("software-developer");
		expect(r!.canonical).toBe("developer");
		expect(r!.alias).toBe(true);
		expect(r!.deprecated).toBe(true);
	});

	it("is case-insensitive on both names", () => {
		const r1 = resolveAgentType("Developer");
		expect(r1).toBeDefined();
		expect(r1!.canonical).toBe("developer");
		expect(r1!.alias).toBe(false);

		const r2 = resolveAgentType("Software-Developer");
		expect(r2).toBeDefined();
		expect(r2!.canonical).toBe("developer");
		expect(r2!.alias).toBe(true);
		expect(r2!.deprecated).toBe(true);
	});

	it("returns undefined for names that have no canonical match and no alias", () => {
		expect(resolveAgentType("does-not-exist")).toBeUndefined();
	});

	it("Phase B: `software-auditor` resolves to the canonical `auditor` via alias", () => {
		// Symmetric with the `developer` / `software-developer` alias
		// (Phase A). The legacy spelling is preserved for backwards
		// compatibility with existing orchestrators and audit consumers.
		const r = resolveAgentType("software-auditor");
		expect(r).toBeDefined();
		expect(r!.canonical).toBe("auditor");
		expect(r!.alias).toBe(true);
		expect(r!.deprecated).toBe(true);
	});

	it("preserves custom-precedence hooks: defaults toggle via setDefaultsDisabled", () => {
		// setDefaultsDisabled is the existing API; it must keep working
		// through Phase A. We don't regress that contract.
		setDefaultsDisabled(true);
		expect(isDefaultsDisabled()).toBe(true);
		setDefaultsDisabled(false);
		expect(isDefaultsDisabled()).toBe(false);
	});
});

describe("developer-alias: Explore/Plan/general-purpose precedence", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("Explore/Plan/general-purpose resolve to themselves, not via alias", () => {
		for (const name of ["Explore", "Plan", "general-purpose"]) {
			const r = resolveAgentType(name);
			expect(r, `expected ${name} to resolve`).toBeDefined();
			expect(r!.requested).toBe(name);
			expect(r!.canonical).toBe(name);
			expect(r!.alias).toBe(false);
			expect(r!.deprecated).toBe(false);
		}
	});

	it("user-defined `developer` in .pi/agents shadows the canonical default", () => {
		// registerAgents overlays user agents on top of defaults — same as
		// before. The alias must NOT bypass user precedence.
		const userDeveloper = {
			name: "developer",
			description: "custom",
			extensions: true,
			skills: true,
			systemPrompt: "user",
			promptMode: "replace" as const,
			isDefault: false,
		};
		registerAgents(new Map([["developer", userDeveloper]]));
		const r = resolveAgentType("developer");
		expect(r).toBeDefined();
		expect(r!.canonical).toBe("developer");
		expect(r!.alias).toBe(false);
	});

	it("user-defined `software-developer` shadows the alias (custom precedence preserved)", () => {
		// A user-defined `software-developer` agent (e.g. a transitional
		// .pi/agents file) wins over the alias. The alias only resolves
		// when no explicit entry exists.
		const userSoftwareDeveloper = {
			name: "software-developer",
			description: "user legacy agent",
			extensions: true,
			skills: true,
			systemPrompt: "user",
			promptMode: "replace" as const,
			isDefault: false,
		};
		registerAgents(new Map([["software-developer", userSoftwareDeveloper]]));
		const r = resolveAgentType("software-developer");
		expect(r).toBeDefined();
		expect(r!.canonical).toBe("software-developer");
		expect(r!.alias).toBe(false);
		expect(r!.deprecated).toBe(false);
	});
});
