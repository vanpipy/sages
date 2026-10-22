/**
 * mailbox-notes.test.ts — the `ctrl+shift+t` system note.
 *
 * The shortcut picks from the MERGED panel, so one note format has to
 * serve two surfaces with two different id spaces. A board id resolves
 * with `TaskGet`; a mailbox id (`m-3`) exists only in the mailbox file
 * and is reachable through `mailbox_list`. Handing the agent the wrong
 * pointer is a dead end that reads as a missing task rather than a note
 * that named the wrong surface — so the surface has to be in the note.
 */

import { describe, expect, it } from "vitest";
import {
	buildMailboxSelectionNote,
	buildSelectionNote,
	buildSelectionNoteFor,
} from "../extensions/sidebar/mailbox/notes.js";
import type { Task } from "../extensions/sidebar/types.js";

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		type: "plan",
		subject: `subject ${id}`,
		description: "",
		status: "pending",
		metadata: {},
		blocks: [],
		blockedBy: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
		id,
	};
}

describe("selection notes", () => {
	it("names the board tool for a board id", () => {
		expect(buildSelectionNote("7", "ship the uploader")).toBe(
			"Sidebar: user selected task #7 — ship the uploader",
		);
	});

	it("points a mailbox id at mailbox_list, not TaskGet", () => {
		const note = buildMailboxSelectionNote("m-3", "Add retry to the uploader");
		expect(note).toContain("#m-3");
		expect(note).toContain("mailbox_list");
		expect(note).not.toContain("TaskGet");
	});

	it("routes by membership in the mailbox", () => {
		const mailbox = [task("m-3", { type: "intent" })];
		expect(buildSelectionNoteFor("m-3", "mail", mailbox)).toContain("mailbox_list");
		expect(buildSelectionNoteFor("7", "board", mailbox)).toBe(
			"Sidebar: user selected task #7 — board",
		);
	});

	it("treats an empty or unreadable mailbox as board-only", () => {
		expect(buildSelectionNoteFor("m-3", "unknown", [])).toBe(
			"Sidebar: user selected task #m-3 — unknown",
		);
	});
});