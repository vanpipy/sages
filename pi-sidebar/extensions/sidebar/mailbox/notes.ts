/**
 * notes.ts — the system note the `ctrl+shift+t` shortcut injects.
 *
 * The shortcut picks from the MERGED panel, which since the mailbox
 * landed contains both the Sages board and mailbox mail. Those two
 * surfaces have different ids and different owners: `#7` on the board is
 * readable with `TaskGet`, while `m-3` lives in a file the task tools
 * never look at and is only reachable through `mailbox_list`. Emitting
 * the same "user selected task #…" note for both leaves the agent
 * holding an id it cannot resolve with any tool it was told to use —
 * a dead end that reads as a missing-task bug rather than a note that
 * named the wrong surface.
 *
 * So the note names the surface it came from. That is the whole fix:
 * no id is invented, nothing is dropped, and the agent is pointed at
 * the one tool that can answer for it.
 */

import type { Task } from "../types.js";

/** The note for a row that lives on the Sages board. */
export function buildSelectionNote(taskId: string, subject: string): string {
	return `Sidebar: user selected task #${taskId} — ${subject}`;
}

/** The note for a row that came from the mailbox file. */
export function buildMailboxSelectionNote(taskId: string, subject: string): string {
	return (
		`Sidebar: user selected mailbox task #${taskId} — ${subject}. ` +
		`It lives in the sidebar mailbox, not the task board — read it with mailbox_list.`
	);
}

/**
 * The note for `taskId`, given everything the mailbox currently holds.
 *
 * Ids are the only discriminator available: the panel row carries no
 * source tag, and the board and the mailbox are separate files that can
 * each mint an id the other also uses. Membership in the mailbox wins,
 * because a mailbox id is the one that is otherwise unresolvable.
 */
export function buildSelectionNoteFor(
	taskId: string,
	subject: string,
	mailbox: Task[],
): string {
	const inMailbox = mailbox.some((t) => t.id === taskId);
	return inMailbox
		? buildMailboxSelectionNote(taskId, subject)
		: buildSelectionNote(taskId, subject);
}