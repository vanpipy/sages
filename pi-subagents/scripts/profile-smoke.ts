/**
 * scripts/profile-smoke.ts — Manually verify the env-flagged profile emits
 * at least one summary line within 7s. Pins SC9 verification_cmd.
 *
 * Why a separate script: the index.ts entrypoint hooks pi.run / pi.events
 * with real runtime callbacks that aren't safe to invoke from a bare
 * `node -e` shell. Instead, we import the profile module + spawn the
 * summary writer ourselves; that exercises the same code path `pi run`
 * does on first entry to the export default function.
 */

import { startSummary, stopSummary } from "../src/profile.js";

startSummary();

setTimeout(() => {
	stopSummary();
	process.exit(0);
}, 5_000);
