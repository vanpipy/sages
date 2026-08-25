/**
 * Sages - pi Package (conductor)
 *
 * Post-PR-2: the orchestrator tools, brainstorming, observability, and
 * project analyzer have moved to `@sages/pi-orchestrator` (a sibling
 * monorepo package). This package retains only the conductor layer:
 *
 *   - Profile loading + 4-segment schema (extensions / tools / prompts / policies)
 *   - Conductor runtime that translates the profile into three pi standard hooks
 *     (tool filter, prompt composer, reminder injector)
 *   - The 4 sage-flavored subagent templates in `templates/agents/`
 *
 * The conductor gates orchestrator tools at runtime via `profile.tools`;
 * the orchestrator package itself unconditionally registers all of them
 * and the conductor decides what the LLM may invoke.
 *
 * For more details, see `templates/SYSTEM.md` (sages-style agent system
 * prompt) and the `templates/prompts/*.md` presets.
 */

export { default as default, default as registerSagesExtension } from "./extension.js";
export { registerConductorOnly } from "./extension.js";

// Profile subsystem (conductor input)
export {
	loadProfile,
	clearProfileCache,
	type Profile,
	STANDARD_PROFILE,
	ProfileSchema,
} from "./profile/index.js";