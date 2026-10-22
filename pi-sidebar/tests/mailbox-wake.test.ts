/**
 * mailbox-wake.test.ts — the wake state machine.
 *
 * The whole point of this module is restraint: it speaks to the main
 * agent as rarely as possible, and never mid-turn. Everything here is
 * pure — the board arrives as an array, the clock and the timer come
 * from injected dependencies, and `send` is a spy. No pi session, no
 * filesystem, no real waiting.
 *
 * `turn_end` is the signal under test and it is a bad one on its own:
 * pi emits it after EVERY assistant message, including the ones inside
 * an ongoing tool-call chain. A `turn_end` carrying a tool-call block
 * means "still working", and every test below that matters encodes that
 * distinction.
 */

import { describe, expect, it } from "vitest";
import {
	WakeMachine,
	buildWakeNote,
	turnEndHadToolCalls,
	type WakeDeps,
} from "../extensions/sidebar/mailbox/wake.js";
import type { Task } from "../extensions/sidebar/types.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
	return {
		type: "intent",
		subject: `subject ${overrides.id}`,
		description: "",
		status: "pending",
		metadata: {},
		blocks: [],
		blockedBy: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

/** A `turn_end` event with no tool calls is a real idle boundary. */
function turnEndNoTools(): unknown {
	return { type: "turn_end", message: { content: [{ type: "text", text: "done" }] } };
}

/** A `turn_end` mid tool-call chain is NOT an idle boundary. */
function turnEndWithTools(): unknown {
	return {
		type: "turn_end",
		message: { content: [{ type: "text", text: "…" }, { type: "toolCall", name: "bash" }] },
	};
}

function setup(opts: { backoffMs?: number; debounceMs?: number } = {}) {
	let clock = 1_000_000;
	const sent: string[] = [];
	let board: Task[] = [];
	const timers: Array<{ fn: () => void; ms: number }> = [];
	let cleared = 0;

	const deps: WakeDeps = {
		now: () => clock,
		readBoard: () => board,
		send: (note) => {
			sent.push(note);
		},
		setTimer: (fn, ms) => {
			timers.push({ fn, ms });
			return timers.length - 1;
		},
		clearTimer: () => {
			cleared++;
		},
	};

	const wake = new WakeMachine(
		{
			debounceMs: opts.debounceMs ?? 1500,
			backoffMs: opts.backoffMs ?? 300_000,
		},
		deps,
	);

	return {
		wake,
		sent,
		timers,
		getCleared: () => cleared,
		setClock: (v: number) => {
			clock = v;
		},
		advance: (ms: number) => {
			clock += ms;
		},
		setBoard: (tasks: Task[]) => {
			board = tasks;
		},
		/** Drain every pending timer at the current clock, as the host would. */
		runTimers: () => {
			const pending = timers.splice(0, timers.length);
			for (const t of pending) t.fn();
		},
	};
}

describe("turnEndHadToolCalls", () => {
	it("detects both toolCall and toolUse blocks", () => {
		expect(turnEndHadToolCalls(turnEndWithTools())).toBe(true);
		expect(
			turnEndHadToolCalls({
				type: "turn_end",
				message: { content: [{ type: "toolUse", name: "read" }] },
			}),
		).toBe(true);
	});

	it("treats a plain assistant message as an idle boundary", () => {
		expect(turnEndHadToolCalls(turnEndNoTools())).toBe(false);
	});

	it("treats a malformed event as an idle boundary rather than throwing", () => {
		expect(turnEndHadToolCalls(undefined)).toBe(false);
		expect(turnEndHadToolCalls({})).toBe(false);
		expect(turnEndHadToolCalls({ message: { content: "not-an-array" } })).toBe(false);
	});
});

describe("WakeMachine: announcing", () => {
	it("announces once when it sees unclaimed mail while idle", () => {
		const s = setup();
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);
		s.wake.poll(board);
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]).toContain("#m-3");
	});

	it("treats a fresh session as already idle, so unattended mail still wakes", () => {
		// Mail that arrived while NO session was running must be picked
		// up on the next session_start. If `idle` only ever became true
		// via turn_end, a session the user never types into would sit on
		// the mail forever.
		const s = setup();
		expect(s.wake.snapshot.idle).toBe(true);
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);
		s.wake.poll(board);
		expect(s.sent).toHaveLength(1);
	});

	it("does not re-announce the same id across repeated polls (acceptance 4)", () => {
		const s = setup();
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);
		for (let i = 0; i < 5; i++) s.wake.poll(board);
		expect(s.sent).toHaveLength(1);
	});

	it("stays silent while no unclaimed intent exists", () => {
		const s = setup();
		const board = [
			makeTask({ id: "m-1", status: "in_progress", owner: "sess-a" }),
			makeTask({ id: "2", type: "plan" }),
		];
		s.setBoard(board);
		s.wake.poll(board);
		expect(s.sent).toEqual([]);
	});

	it("names every unclaimed intent in the note but only announces the oldest", () => {
		const s = setup();
		const board = [
			makeTask({ id: "m-7", createdAt: 200 }),
			makeTask({ id: "m-3", createdAt: 100 }),
		];
		s.setBoard(board);
		s.wake.poll(board);
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]).toContain("#m-3");
		expect(s.sent[0]).toContain("#m-7");
		expect(s.sent[0]).toContain("mailbox_claim");
	});
});

describe("WakeMachine: the idle boundary (acceptance 2, 3)", () => {
	it("withholds when the turn carried tool calls and fires at the next real boundary", () => {
		const s = setup();
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);

		s.wake.onTurnStart();
		s.wake.poll(board); // mid-turn poll: idle is false, so nothing is sent
		expect(s.sent).toEqual([]);

		s.wake.onTurnEnd(turnEndWithTools()); // still mid-chain
		s.runTimers();
		expect(s.sent).toEqual([]);

		s.wake.onTurnEnd(turnEndNoTools()); // real boundary
		s.runTimers();
		expect(s.sent).toHaveLength(1);
	});

	it("debounces the boundary fire so an idle->idle->idle flap sends once", () => {
		const s = setup({ debounceMs: 1500 });
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);
		s.wake.onTurnStart();
		s.wake.poll(board);
		expect(s.sent).toEqual([]); // mid-turn: mail noticed, nothing said

		s.wake.onTurnEnd(turnEndNoTools());
		s.wake.onTurnEnd(turnEndNoTools());
		s.wake.onTurnEnd(turnEndNoTools());
		s.runTimers();
		expect(s.sent).toHaveLength(1);
	});

	it("does not fire the debounced wake if a new turn started in the meantime", () => {
		const s = setup({ debounceMs: 1500 });
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);
		s.wake.onTurnStart();
		s.wake.poll(board); // mail noticed mid-turn
		s.wake.onTurnEnd(turnEndNoTools()); // boundary arms the debounce
		s.wake.onTurnStart(); // user typed before the timer fired
		s.runTimers();
		expect(s.sent).toEqual([]);
	});

	it("stays quiet mid-turn even with mail pending", () => {
		const s = setup();
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);
		s.wake.onTurnStart();
		for (let i = 0; i < 3; i++) {
			s.wake.poll(board);
			s.wake.onTurnEnd(turnEndWithTools());
		}
		s.runTimers();
		expect(s.sent).toEqual([]);
	});
});

describe("WakeMachine: the re-read inside fire()", () => {
	it("drops a stale announce when the agent claimed the mail while we waited", () => {
		const s = setup();
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);

		// Mid-turn the poll notices the mail but cannot speak.
		s.wake.onTurnStart();
		s.wake.poll(board);
		// The agent — a different session, or the user — claims it before
		// the quiet moment arrives.
		s.setBoard([makeTask({ id: "m-3", createdAt: 100, status: "in_progress", owner: "sess-a" })]);

		s.wake.onTurnEnd(turnEndNoTools());
		s.runTimers();
		expect(s.sent).toEqual([]);
	});

	it("drops a stale announce on the poll path too", () => {
		const s = setup();
		s.wake.onTurnStart();
		s.wake.poll([makeTask({ id: "m-3", createdAt: 100 })]);
		s.setBoard([makeTask({ id: "m-3", createdAt: 100, status: "in_progress", owner: "sess-a" })]);
		s.wake.onTurnEnd(turnEndNoTools());
		s.runTimers();
		expect(s.sent).toEqual([]);
	});

	it("forgets an id that left the board, so returning mail is announced again", () => {
		const s = setup();
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);
		s.wake.poll(board);
		expect(s.sent).toHaveLength(1);

		// Claimed, then completed and the board is emptied.
		s.setBoard([]);
		s.wake.poll([]);

		// A later intent with the same id is a different piece of mail.
		const again = [makeTask({ id: "m-3", createdAt: 900 })];
		s.setBoard(again);
		s.wake.poll(again);
		expect(s.sent).toHaveLength(2);
	});
});

describe("WakeMachine: send failure", () => {
	it("keeps wakePending true so the next poll retries", () => {
		let clock = 2_000_000;
		let board: Task[] = [];
		const sent: string[] = [];
		let fail = true;
		const wake = new WakeMachine(
			{ debounceMs: 1500, backoffMs: 300_000 },
			{
				now: () => clock,
				readBoard: () => board,
				send: (note) => {
					if (fail) throw new Error("host refused");
					sent.push(note);
				},
				setTimer: () => 0,
				clearTimer: () => {},
			},
		);
		board = [makeTask({ id: "m-3", createdAt: 100 })];

		wake.poll(board);
		expect(sent).toEqual([]);
		fail = false;
		clock += 10_000;
		wake.poll(board);
		expect(sent).toHaveLength(1);
	});
});

describe("WakeMachine: backoff", () => {
	it("permits exactly one re-announce of an unclaimed intent after the backoff", () => {
		const s = setup({ backoffMs: 300_000 });
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);

		s.wake.poll(board);
		expect(s.sent).toHaveLength(1);

		// Well inside the backoff window: silent.
		s.advance(60_000);
		s.wake.poll(board);
		expect(s.sent).toHaveLength(1);

		// Past it: exactly one re-announce.
		s.advance(300_000);
		s.wake.poll(board);
		expect(s.sent).toHaveLength(2);

		// And then never again, however long the intent stays unclaimed.
		s.advance(10 * 300_000);
		s.wake.poll(board);
		expect(s.sent).toHaveLength(2);
	});

	it("cancels the backoff the moment the intent is claimed", () => {
		const s = setup({ backoffMs: 1000 });
		const board = [makeTask({ id: "m-3", createdAt: 100 })];
		s.setBoard(board);
		s.wake.poll(board);
		expect(s.sent).toHaveLength(1);

		s.setBoard([makeTask({ id: "m-3", createdAt: 100, status: "in_progress", owner: "s" })]);
		s.advance(10_000);
		s.wake.poll([]);
		expect(s.sent).toHaveLength(1);
	});
});

describe("buildWakeNote", () => {
	it("matches the design doc's phrasing", () => {
		const note = buildWakeNote([makeTask({ id: "m-3" }), makeTask({ id: "m-7" })]);
		expect(note).toContain("<system-reminder>");
		expect(note).toContain("</system-reminder>");
		expect(note).toContain("2 unclaimed intent tasks");
		expect(note).toContain("#m-3");
		expect(note).toContain("#m-7");
		expect(note).toContain("Do not mention this to the user");
		expect(note).toContain("mailbox_list");
		expect(note).toContain("mailbox_claim");
	});

	it("uses the singular for one intent", () => {
		expect(buildWakeNote([makeTask({ id: "m-3" })])).toContain("1 unclaimed intent task");
	});

	it("is not a task dump — no subjects leak into the note", () => {
		const note = buildWakeNote([makeTask({ id: "m-3", subject: "SECRET BRIEF" })]);
		expect(note).not.toContain("SECRET BRIEF");
	});

	it("bounds a very long id list rather than emitting hundreds of ids", () => {
		const many = Array.from({ length: 40 }, (_, i) => makeTask({ id: `m-${i}` }));
		const note = buildWakeNote(many);
		expect(note).toContain("more");
		expect(note.split("#").length).toBeLessThan(20);
	});
});