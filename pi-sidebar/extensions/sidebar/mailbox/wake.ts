/**
 * wake.ts — the wake state machine.
 *
 * The point of this module is restraint. Its job is to decide whether
 * the session is GENUINELY idle, and to speak at most once about any
 * given piece of mail. Everything is pure: the board arrives as an
 * array, the clock and the timers are injected, `send` is a function.
 * That is what lets the whole state machine be tested without a pi
 * session — there is no `pi` import in this file at all, only the two
 * facts about the host it needs to know.
 *
 * ## Fact 1: `turn_end` is not an idle signal
 *
 * pi emits `turn_end` after EVERY assistant message, including the ones
 * inside an ongoing tool-call chain. A `turn_end` carrying a
 * `toolCall` / `toolUse` block means "still working"; the next real
 * boundary will arrive on its own. The guard below is lifted from
 * `pi-tasks/src/index.ts:630` for exactly that reason.
 *
 * ## Fact 2: `state.isStreaming` is not an idle signal either
 *
 * `extensions/sidebar.ts` clears `isStreaming` on every `turn_end`,
 * which is correct for autohide (it only wants "am I streaming tokens")
 * and wrong for the wake gate. So the wake keeps its own `idle` flag
 * rather than reading the renderer's.
 *
 * ## Why three sets and not the design's single `unwoken`
 *
 * The design's pseudo-code has `poll` add every unclaimed intent not in
 * `unwoken`, and `fire` delete the one it announced. Taken literally
 * those two lines cancel: the next poll re-adds the id it just
 * announced and re-announces it, which is the exact 10s-forever loop the
 * design's own comment warns against. Separating "I have seen this"
 * (`observed`), "I still owe an announcement" (`pending`) and "I have
 * already announced this, and when" (`announced`) makes the loop
 * unrepresentable, and `announced` is also what the backoff knob reads.
 */

import { compareFifo, unclaimedIntents } from "./store.js";
import type { Task } from "../types.js";

/** Cap on ids named in a wake note. The note is a nudge, not a dump. */
const NOTE_MAX_IDS = 10;

/**
 * Did this `turn_end` land inside a tool-call chain?
 *
 * Both `toolCall` and `toolUse` are checked because pi hosts have used
 * both names, and this package declares the host as a wildcard peer
 * dependency. A malformed event reads as "idle" rather than throwing:
 * a panic in a `turn_end` handler takes the panel with it.
 */
export function turnEndHadToolCalls(event: unknown): boolean {
	const msg = (event as { message?: { content?: unknown } } | undefined)?.message;
	return (
		Array.isArray(msg?.content) &&
		(msg.content as Array<{ type?: unknown }>).some(
			(c) => c?.type === "toolCall" || c?.type === "toolUse",
		)
	);
}

export type WakeConfig = {
	/** Collapse idle→idle→idle flaps into one announcement. */
	debounceMs: number;
	/** How long an announced, still-unclaimed intent may sit quiet. */
	backoffMs: number;
};

export type WakeDeps = {
	now: () => number;
	/**
	 * Re-read the board from inside `fire()`. Between the poll that
	 * noticed the mail and the quiet moment that allowed the wake, the
	 * agent may have claimed and finished it; announcing stale mail is
	 * worse than not announcing at all.
	 */
	readBoard: () => Task[];
	/** Deliver the note. May throw — see the send-failure path. */
	send: (note: string) => void;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
};

/** Observable state, for tests and for `/sidebar status`. */
export type WakeSnapshot = {
	idle: boolean;
	wakePending: boolean;
	lastWakeAt: number;
	observed: string[];
	pending: string[];
	announced: string[];
};

type Announcement = { count: number; lastAt: number };

/**
 * The note the main agent receives. Not a task dump on purpose: the
 * agent pulls the bodies with `mailbox_list`, so the note and the
 * panel cannot end up disagreeing about what exists. Matches the "DO
 * NOT mention this" phrasing of `buildSystemReminder`
 * (`pi-tasks/src/index.ts:126`) — an unacknowledged intent is quiet
 * enough on the panel that narrating it would be noise.
 */
export function buildWakeNote(unclaimed: Task[]): string {
	const ids = unclaimed.map((t) => `#${t.id}`);
	const shown = ids.slice(0, NOTE_MAX_IDS);
	const overflow = ids.length - shown.length;
	const list =
		shown.join(", ") + (overflow > 0 ? `, and ${overflow} more` : "");
	const count = `${unclaimed.length} unclaimed intent task${
		unclaimed.length === 1 ? "" : "s"
	}`;
	return [
		"<system-reminder>",
		`The sidebar mailbox has ${count} (${list}). Do not mention this to the user.`,
		`Call mailbox_list to read them, then mailbox_claim the oldest one (${showIds(unclaimed)}).`,
		"</system-reminder>",
	].join("\n");
}

function showIds(unclaimed: Task[]): string {
	const first = unclaimed[0];
	return first ? `#${first.id}` : "";
}

export class WakeMachine {
	private readonly config: WakeConfig;
	private readonly deps: Required<WakeDeps>;

	/** Every unclaimed intent ever seen while it was live on the board. */
	private readonly observed = new Set<string>();
	/** Announcements owed. `fire()` drains one entry at a time. */
	private readonly pending = new Set<string>();
	/** Ids already announced, with how many times and when. */
	private readonly announced = new Map<string, Announcement>();

	private idle = true;
	private wakePending = false;
	private lastWakeAt = 0;
	private timer: unknown;
	private timerArmed = false;

	constructor(config: WakeConfig, deps: WakeDeps) {
		this.config = config;
		this.deps = {
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			...deps,
		};
		// `idle` starts TRUE. A session that has just started has a real
		// idle boundary by definition, and mail that arrived while no
		// session was running is only useful if the first poll can act on
		// it — otherwise the feature silently depends on the user typing
		// something before any mail is ever seen.
		this.idle = true;
	}

	get snapshot(): WakeSnapshot {
		return {
			idle: this.idle,
			wakePending: this.wakePending,
			lastWakeAt: this.lastWakeAt,
			observed: [...this.observed],
			pending: [...this.pending],
			announced: [...this.announced.keys()],
		};
	}

	/**
	 * The 10s tick. Notice what is live, forget what left, and speak if
	 * the session is quiet.
	 *
	 * The poll path fires IMMEDIATELY when idle rather than arming the
	 * debounce timer: the debounce exists to collapse flap boundaries
	 * arriving in quick succession, and a poll is not a boundary.
	 */
	poll(tasks: Task[]): void {
		const live = new Set(unclaimedIntents(tasks).map((t) => t.id));
		const now = this.deps.now();

		for (const id of [...this.observed]) {
			if (!live.has(id)) {
				this.observed.delete(id);
				this.pending.delete(id);
				this.announced.delete(id);
			}
		}
		for (const id of live) {
			const already = this.announced.get(id);
			if (!already) {
				this.observed.add(id);
				this.pending.add(id);
			} else if (this.backoffElapsed(already, now)) {
				// One re-announce per id, ever: `count > 1` is terminal
				// so an intent nobody claims cannot spam the session on
				// every poll forever.
				this.pending.add(id);
			}
		}

		this.wakePending = this.pending.size > 0;
		if (this.wakePending && this.idle) this.fire();
	}

	onTurnStart(): void {
		this.idle = false;
	}

	/**
	 * The only boundary signal worth listening to. A `turn_end` with
	 * tool calls is mid-chain, so it neither marks idle nor arms the
	 * debounce; the real boundary will arrive on its own.
	 */
	onTurnEnd(event: unknown): void {
		if (turnEndHadToolCalls(event)) return;
		this.idle = true;
		if (!this.wakePending || this.pending.size === 0) return;
		this.arm();
	}

	private backoffElapsed(record: Announcement, now: number): boolean {
		if (record.count > 1) return false;
		return now - record.lastAt >= this.config.backoffMs;
	}

	private arm(): void {
		// Re-arming per `turn_end` would mean a flapping boundary keeps
		// pushing the timer forward and the wake never settles.
		if (this.timerArmed) return;
		this.timerArmed = true;
		this.timer = this.deps.setTimer(() => {
			this.timerArmed = false;
			this.timer = undefined;
			// A turn may have started inside the debounce window. Announcing
			// into a live turn is the failure this whole module exists to
			// avoid, so the boundary is re-checked rather than assumed.
			if (!this.idle) return;
			this.fire();
		}, this.config.debounceMs);
	}

	private cancelTimer(): void {
		if (!this.timerArmed) return;
		this.deps.clearTimer(this.timer);
		this.timerArmed = false;
		this.timer = undefined;
	}

	/**
	 * Announce the oldest intent we still owe an announcement for.
	 *
	 * The board is re-read first and the pending set is re-checked
	 * against it: anything claimed in the gap is silently dropped, and a
	 * wake that has nothing to say clears itself rather than staying
	 * armed for mail that no longer exists.
	 */
	private fire(): void {
		const live = unclaimedIntents(this.deps.readBoard());
		const liveIds = new Set(live.map((t) => t.id));
		for (const id of [...this.pending]) {
			if (!liveIds.has(id)) {
				this.pending.delete(id);
				this.observed.delete(id);
				this.announced.delete(id);
			}
		}
		if (live.length === 0 || this.pending.size === 0) {
			this.wakePending = this.pending.size > 0;
			return;
		}

		const owed = live.filter((t) => this.pending.has(t.id)).sort(compareFifo);
		const first = owed[0];
		if (!first) {
			this.wakePending = false;
			return;
		}

		try {
			this.deps.send(buildWakeNote(live));
		} catch {
			// The host refused the message. Leave everything as-is so the
			// next poll tries again — `wakePending` staying true IS the
			// retry, and a crash here would take the panel with it.
			this.wakePending = true;
			return;
		}

		this.pending.delete(first.id);
		this.lastWakeAt = this.deps.now();
		const prior = this.announced.get(first.id);
		this.announced.set(first.id, {
			count: (prior?.count ?? 0) + 1,
			lastAt: this.lastWakeAt,
		});
		this.wakePending = this.pending.size > 0;
		if (!this.wakePending) this.cancelTimer();
	}
}