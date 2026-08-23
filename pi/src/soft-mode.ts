/**
 * Soft mode — the Sages main-agent policy under GC-2026-031.
 *
 * Soft mode replaces the historical two-layer hard gate (Layer 1 +
 * Layer 2) with a once-per-process reminder. The main agent has full
 * tool access (`edit` / `write` / `aft_edit` / `apply_patch` /
 * unrestricted `bash`). Subagent dispatch via the 4-stage DAG workflow
 * is RECOMMENDED but never required; drift from the recommended
 * pattern is auto-steered (a system reminder is appended via
 * `pi.appendEntry`), never blocked.
 *
 * As of GC-2026-049, the reminder string is no longer a static module
 * constant. It is a field on `Profile` loaded by `pi/src/profile.ts`.
 * Use `softModeReminder(profile)` to read it.
 */

import type { Profile } from "./profile.js";

/** Goal-orientation reminder, fired once per process on first write-intent bash. */
export function softModeReminder(profile: Profile): string {
	return profile.soft_mode_reminder;
}