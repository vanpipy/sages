/**
 * Profile types — 4-segment schema for the Sages conductor.
 *
 * Each segment maps to a concrete conductor behavior:
 *   - extensions → installed npm packages (declared, not loaded by conductor)
 *   - tools      → capability/tool whitelist applied by `installCapabilityFilter`
 *   - prompts    → preset file picked by `installPromptComposer`
 *   - policies   → runtime parameters (e.g., soft-mode reminder text)
 *
 * Replaces the historical 7-field schema (`subagents` / `isolation_default` /
 * `dag_threshold` / `gate_suite` / `id` / `description` / `soft_mode_reminder`)
 * where 6 of 7 fields were decorative — validated but never read by runtime.
 *
 * See `pi/templates/SYSTEM.md` for the agent-facing description; the new
 * schema is what the conductor translates into pi standard hooks.
 */

import { Type, type Static } from "typebox";

export const ProfileSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 64 }),
	description: Type.Optional(Type.String()),

	/** Which sibling / 3rd-party extensions are expected to be loaded. Conductor uses this for tool filtering and template selection. */
	extensions: Type.Object({
		installed: Type.Array(Type.String(), { minItems: 0 }),
	}),

	/**
	 * Tool capabilities the LLM may call. Tools not listed here are blocked
	 * at the tool_call hook (with baseline tools — bash/read/edit/write/grep/find/ls — always allowed).
	 */
	tools: Type.Record(
		Type.String(),
		Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		{ description: "tool_name → { enabled?, config? }" },
	),

	/** System-prompt composition config. */
	prompts: Type.Object({
		/** Preset template name. "auto" lets the conductor pick based on `extensions.installed`. */
		template: Type.Union([
			Type.Literal("auto"),
			Type.Literal("minimal"),
			Type.Literal("standard"),
			Type.Literal("with-aft"),
			Type.Literal("with-magic-context"),
			Type.Literal("with-both"),
		]),
		/** Optional user-supplied overlays appended after the preset. */
		custom_overlays: Type.Optional(Type.Array(Type.String())),
	}),

	/** Runtime policies injected by the conductor. */
	policies: Type.Object({
		/** Fired once via `pi.appendEntry("system", ...)` on the first bash tool_call. Empty string disables. */
		soft_mode_reminder: Type.Optional(Type.String()),
	}),
});

export type Profile = Static<typeof ProfileSchema>;
export type ToolCapability = Profile["tools"][string];

/**
 * Standard profile — used when no user override and no built-in YAML exists.
 * Mirrors `pi/profiles/standard.yaml` byte-for-byte (verified by `test/profiles.test.ts`).
 */
export const STANDARD_PROFILE: Profile = {
	id: "standard",
	description: "Sages default — full stack with auto-templated system prompt",

	extensions: {
		installed: [
			"@sages/pi-orchestrator",
			"@sages/pi-subagents",
			"@sages/pi-codebase-memory",
			"@sages/pi-evaluator",
			"@cortexkit/aft-pi",
			"@cortexkit/pi-magic-context",
		],
	},

	tools: {
		// orchestrator
		goal_contract_create:   { enabled: true },
		dag_synthesize:         { enabled: true },
		task_dispatch:          { enabled: true },
		orchestrator_audit:     { enabled: true },
		sages_reminder:         { enabled: true },

		// subagents
		agent:                  { enabled: true },
		get_subagent_result:    { enabled: true },
		steer_subagent:         { enabled: true },

		// codebase-memory
		codebase_memory_list_projects:   { enabled: true },
		codebase_memory_search_graph:     { enabled: true },
		codebase_memory_get_architecture: { enabled: true },

		// evaluator
		eval_score: { enabled: true },
		eval_trend: { enabled: true },

		// 3rd party
		aft_search:  { enabled: true },
		aft_outline: { enabled: true },
		aft_zoom:    { enabled: true },
		ctx_search:  { enabled: true },
		ctx_note:    { enabled: true },
	},

	prompts: { template: "auto" },

	policies: {
		soft_mode_reminder: `> ⚙️ **SOFT MODE — subagent dispatch recommended**
>
> If this is part of a larger workflow (>2 items in your active todowrite),
> consider dispatching via the 4-stage DAG workflow: goal → DAG → dispatch → audit.
> The developer / auditor / merger / git-expert pipeline is the recommended
> approach for complex multi-step work. For ≤2 tasks, direct handling is
> acceptable. This is a recommendation — the agent decides. No commands are
> blocked.
`,
	},
};