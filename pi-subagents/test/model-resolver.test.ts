/**
 * model-resolver.test.ts — Pin the Agent dispatcher fallback policy.
 *
 * GC-2026-014 follow-up: when `resolveModel` returns an error string and the
 * model came from caller-supplied params (most commonly Anthropic-fuzzy
 * names like "haiku" / "sonnet" on a non-Anthropic registry), the dispatcher
 * used to hard-error and abort the spawn. The new policy is to warn + fall
 * back:
 *
 *   1. `resolveDispatcherModelFallback()` is the single source of truth for
 *      the policy. The dispatcher is thin wiring around it; these tests pin
 *      the policy behavior.
 *   2. Resolver success path → use the returned Model directly, no warning.
 *   3. Resolver error + caller-supplied (`modelFromParams: true`) →
 *      prefer the settings.json default (when `registry.find` returns a
 *      usable Model), else fall through to the parent session's model.
 *      Either fallback emits a warning.
 *   4. Resolver error + frontmatter-pinned (`modelFromParams: false`) →
 *      silent fallback to the parent (the user's authored/installed config
 *      is trusted; the existing GC-2026-011/012/014 dispatcher invariant).
 *   5. No fallback target anywhere → return `model: undefined` and no
 *      warning; the agent runner will fall through to its standard
 *      inheritance.
 *
 * The resolver itself stays a pure function over the registry
 * (see `src/model-resolver.ts`). The fallback policy lives next to it in
 * `src/model-fallback.ts` so it can be unit-tested without spinning up
 * the Agent tool.
 */

import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveDispatcherModelFallback } from "../src/model-fallback.js";

/** Bare-bones Model object — only the fields the policy touches. */
function mkModel(provider: string, id: string): Model<any> {
	return {
		provider,
		id,
		name: id,
		api: "anthropic-messages" as any,
		baseUrl: "https://example.test/",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

const FALLBACK_MODEL = mkModel("fallback", "fallback-model");
const SETTINGS_MODEL = mkModel("settings-provider", "settings-model");

function mkRegistry(findMap: Record<string, Model<any>> = {}): {
	find(p: string, id: string): Model<any> | undefined;
} {
	return {
		find(provider, id) {
			return findMap[`${provider}/${id}`];
		},
	};
}

describe("model-fallback: resolver success path", () => {
	it("uses the resolved Model directly and emits no warning", () => {
		const resolved = mkModel("direct", "direct-model");
		const decision = resolveDispatcherModelFallback({
			resolved,
			registry: mkRegistry(),
			parentModel: FALLBACK_MODEL,
			settingsDefault: undefined,
			modelFromParams: true,
		});
		expect(decision.model).toBe(resolved);
		expect(decision.shouldWarn).toBe(false);
		expect(decision.fallbackKind).toBe("none");
	});
});

describe("model-fallback: caller-supplied unresolvable (modelFromParams=true)", () => {
	it("falls back to settings.json default when the registry hydrates it (warns)", () => {
		const registry = mkRegistry({
			[`${SETTINGS_MODEL.provider}/${SETTINGS_MODEL.id}`]: SETTINGS_MODEL,
		});
		const decision = resolveDispatcherModelFallback({
			resolved: 'Model not found: "haiku".\n\nAvailable models:\n  ...',
			registry,
			parentModel: FALLBACK_MODEL,
			settingsDefault: {
				provider: SETTINGS_MODEL.provider,
				model: SETTINGS_MODEL.id,
			},
			modelFromParams: true,
		});
		expect(decision.model).toBe(SETTINGS_MODEL);
		expect(decision.shouldWarn).toBe(true);
		expect(decision.fallbackKind).toBe("settings");
	});

	it("falls back to parent session model when settings default is unavailable (warns)", () => {
		// Registry has the settings default provider/id but they don't resolve — the
		// helper should fall through to the parent model rather than silently fail.
		const decision = resolveDispatcherModelFallback({
			resolved: 'Model not found: "haiku".\n\nAvailable models:\n  ...',
			registry: mkRegistry({}),
			parentModel: FALLBACK_MODEL,
			settingsDefault: { provider: "ghost", model: "ghost-model" },
			modelFromParams: true,
		});
		expect(decision.model).toBe(FALLBACK_MODEL);
		expect(decision.shouldWarn).toBe(true);
		expect(decision.fallbackKind).toBe("parent");
	});

	it("falls back to parent session model when settings default is absent", () => {
		const decision = resolveDispatcherModelFallback({
			resolved: 'Model not found: "haiku".\n\nAvailable models:\n  ...',
			registry: mkRegistry(),
			parentModel: FALLBACK_MODEL,
			settingsDefault: undefined,
			modelFromParams: true,
		});
		expect(decision.model).toBe(FALLBACK_MODEL);
		expect(decision.shouldWarn).toBe(true);
		expect(decision.fallbackKind).toBe("parent");
	});

	it("prefers the settings default over the parent model when both resolve", () => {
		const registry = mkRegistry({
			[`${SETTINGS_MODEL.provider}/${SETTINGS_MODEL.id}`]: SETTINGS_MODEL,
		});
		const decision = resolveDispatcherModelFallback({
			resolved: 'Model not found: "haiku".',
			registry,
			parentModel: FALLBACK_MODEL,
			settingsDefault: {
				provider: SETTINGS_MODEL.provider,
				model: SETTINGS_MODEL.id,
			},
			modelFromParams: true,
		});
		// Settings default explicitly wins — the user's settings.json is the
		// operator-chosen default, intentionally overriding the live session model.
		expect(decision.model).toBe(SETTINGS_MODEL);
		expect(decision.shouldWarn).toBe(true);
		expect(decision.fallbackKind).toBe("settings");
	});

	it("returns model=undefined (no warning) when no fallback target exists", () => {
		// Both settings default and parent model missing: the dispatcher cannot
		// pick anything, but surfacing "Model not found" mid-session is noisier
		// than letting the agent runner fall through. Empty warning matches the
		// existing invariant that no warning = no extra notification toast.
		const decision = resolveDispatcherModelFallback({
			resolved: 'Model not found: "haiku".',
			registry: mkRegistry(),
			parentModel: undefined,
			settingsDefault: undefined,
			modelFromParams: true,
		});
		expect(decision.model).toBeUndefined();
		expect(decision.shouldWarn).toBe(false);
		expect(decision.fallbackKind).toBe("none");
	});
});

describe("model-fallback: frontmatter-pinned unresolvable (modelFromParams=false)", () => {
	it("silently falls back to parent — settings default is NOT consulted for frontmatter pins", () => {
		// Two invariants ride together here:
		//   (1) Frontmatter is the user-installed config (agent author /
		//       installer chose this); we never warn for an out-of-scope
		//       frontmatter pin — the existing GC-2026-011 scope-pinned
		//       fallback invariant must survive.
		//   (2) The settings.json default override only applies when the
		//       CALLER (LLM-supplied params) chooses an unresolvable model.
		//       Frontmatter is authoritative for the agent's own identity —
		//       the user-installed agent wins, not the session default.
		// The test sets settingsDefault to something the registry COULD hydrate
		// so a future contributor who naively lifts the settings check out of
		// the modelFromParams branch would see the helper prefer the settings
		// model here, and this test would catch it.
		const registry = mkRegistry({
			[`${SETTINGS_MODEL.provider}/${SETTINGS_MODEL.id}`]: SETTINGS_MODEL,
		});
		const decision = resolveDispatcherModelFallback({
			resolved: 'Model not found: "x-test-only".',
			registry,
			parentModel: FALLBACK_MODEL,
			settingsDefault: {
				provider: SETTINGS_MODEL.provider,
				model: SETTINGS_MODEL.id,
			},
			modelFromParams: false,
		});
		expect(decision.model).toBe(FALLBACK_MODEL);
		expect(decision.shouldWarn).toBe(false);
		expect(decision.fallbackKind).toBe("parent");
	});

	it("returns model=undefined without warning when parent is also unavailable", () => {
		// Symmetric with the caller-supplied path: no target = no warning, let
		// the agent runner's standard inheritance kick in.
		const decision = resolveDispatcherModelFallback({
			resolved: 'Model not found: "x".',
			registry: mkRegistry(),
			parentModel: undefined,
			settingsDefault: undefined,
			modelFromParams: false,
		});
		expect(decision.model).toBeUndefined();
		expect(decision.shouldWarn).toBe(false);
		expect(decision.fallbackKind).toBe("none");
	});
});
