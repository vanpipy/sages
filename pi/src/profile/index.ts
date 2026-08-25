/**
 * Profile subsystem — public surface.
 *
 * Re-exports the 4-segment profile types, loader, validator, and applier
 * for the Sages conductor. The conductor's `registerConductorOnly` (in
 * `extension.ts`) calls `loadProfile()` + `applyProfile()` to translate
 * the active profile into three pi standard hooks.
 */

export type { Profile, ToolCapability } from "./types.js";
export { ProfileSchema, STANDARD_PROFILE } from "./types.js";
export { loadProfile, clearProfileCache } from "./loader.js";
export { validateProfile, type ValidationResult } from "./validator.js";
export { applyProfile } from "./applier.js";