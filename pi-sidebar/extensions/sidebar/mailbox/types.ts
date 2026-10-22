/**
 * mailbox/types.ts — mailbox vocabulary and env knob resolution.
 *
 * Two things live here and nothing else: the type of a task as the
 * mailbox sees it (which is the sidebar's EXISTING `Task`, not a new
 * shape — see the note below) and the resolution of the four
 * `PI_SIDEBAR_*` knobs that drive intake and the wake.
 *
 * ## Why the mailbox reuses `Task` verbatim
 *
 * The design's load-bearing decision is that the mailbox file is
 * byte-compatible with `parseTasksJson`
 * (`extensions/sidebar/tasks.ts:69`), so the panel renders the mailbox
 * with zero renderer changes. That only works because the mailbox
 * introduces no new status vocabulary:
 *
 *   - "unplanned" is `status: "pending"`
 *   - "claimed" is `status: "in_progress"` + `owner`
 *   - parent linkage is `metadata.sourceIntent` on each child
 *
 * `metadata` is already a free-form bag on the parsed shape, so child
 * linkage costs no schema change. If a future edit is tempted to add a
 * `claimed` status or a `parentId` field, the compatibility test in
 * `tests/mailbox-store.test.ts` is the thing that will say no — and it
 * will say no for the right reason, because it reads the file back
 * through the sidebar's own parser.
 */

import { join } from "node:path";
import { envBool, envInt } from "../utils.js";
import { orchestratorWorkdir, projectKey } from "../tasks.js";

export type { Task } from "../types.js";

/**
 * Resolved mailbox knobs. Kept as one object rather than four exported
 * getters so a test can assert the shipped defaults wholesale —
 * `placementConfigFromEnv` established that pattern for the panel's
 * layout knobs for the same reason: a default buried in a call site
 * cannot be asserted, and an unassertable default is one that silently
 * changes.
 */
export type MailboxEnv = {
	/** `PI_SIDEBAR_MAILBOX=off` disables intake, poll and wake entirely. */
	enabled: boolean;
	/** `PI_SIDEBAR_MAILBOX_POLL_MS` — the poll floor. */
	pollMs: number;
	/**
	 * `PI_SIDEBAR_WAKE_DEBOUNCE_MS` — collapses the idle→idle→idle
	 * flaps a tool chain that ends cleanly twice can produce into a
	 * single announcement.
	 */
	wakeDebounceMs: number;
	/**
	 * `PI_SIDEBAR_WAKE_BACKOFF_MS` — how long an announced-but-still
	 * unclaimed intent sits quiet before one re-announce is permitted.
	 */
	wakeBackoffMs: number;
};

/**
 * Resolve every mailbox knob in one place.
 *
 * All four read through the `env*` helpers rather than `process.env`
 * directly so tests can pass a bag instead of mutating the real
 * environment. `envInt` (not `envIntClamped`) is correct for the three
 * timing knobs: a zero or negative interval is meaningless, and
 * `envInt` treats those as unset, which is the behavior we want.
 */
export function mailboxEnvFrom(env: NodeJS.ProcessEnv = process.env): MailboxEnv {
	return {
		enabled: envBool("PI_SIDEBAR_MAILBOX", true, env),
		pollMs: envInt("PI_SIDEBAR_MAILBOX_POLL_MS", 10_000, env),
		wakeDebounceMs: envInt("PI_SIDEBAR_WAKE_DEBOUNCE_MS", 1500, env),
		wakeBackoffMs: envInt("PI_SIDEBAR_WAKE_BACKOFF_MS", 300_000, env),
	};
}

/**
 * Where the mailbox file lives:
 * `${ORCHESTRATOR_WORKDIR:-<tmpdir>/sages-orchestrator}/<projectKey(cwd)>/mailbox/tasks.json`.
 *
 * `projectKey` and `orchestratorWorkdir` are the sidebar's existing
 * helpers — imported, not reimplemented. `projectKey` is a contract with
 * `pi-tasks/src/task-paths.ts` enforced by tests, and duplicating the
 * encoding here would be the fastest way to break it. (Copying it is
 * fine; the whole point of the zero-`@sages/*` stance is that this
 * package cannot import the definition.)
 *
 * The `mailbox/` level rather than `tasks/` is deliberate: the Sages
 * board already owns `<root>/<key>/tasks/tasks.json` and the sidebar
 * reads it. Two writers on one file would mean every `pi-tasks` session
 * in the workspace could clobber mailbox mail, so the mailbox is a
 * sibling directory that happens to share a parser.
 */
export function mailboxPathFor(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return join(orchestratorWorkdir(env), projectKey(cwd), "mailbox", "tasks.json");
}