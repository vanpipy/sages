/**
 * store.ts — the mailbox file store. The only module here that touches
 * the filesystem.
 *
 * Everything the mailbox does to disk funnels through one
 * read-modify-write under one lock, for the same reason `pi-tasks`
 * funnels through `TaskStore.withLock`: five tools plus a 10s poll plus
 * a `curl` writing mail from outside the session all landing on the
 * same file will tear it eventually, and a torn task file is silent —
 * the parser returns `null` and the panel quietly shows "no tasks".
 *
 * The lock discipline is COPIED from `pi-tasks/src/task-store.ts:31-76`
 * rather than imported. This package has a deliberate zero-`@sages/*`
 * stance (documented in `pi/docs/learn/pi-sidebar.md`), so the pattern
 * is duplicated deliberately; the shape below is the contract, not the
 * implementation:
 *
 *   - lock file at `<store>.lock`, created with flag `wx` (O_EXCL)
 *   - the token is `<pid>:<uuid>` — the PID is what the staleness check
 *     parses, the UUID is what lets a holder tell its own lock from a
 *     successor's
 *   - a lock naming a dead PID is reaped (`process.kill(pid, 0)` throws)
 *   - 50ms × 100 retries = a 5s ceiling, then give up
 *
 * In practice contention is near-zero: the sidebar and the main agent
 * are the same process in one session, so only external mail senders
 * ever take this lock across a process boundary.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseTasksJson } from "../tasks.js";
import type { Task } from "../types.js";

/** `pi-tasks`' 50ms × 100 = 5s ceiling. Injected so tests need not wait. */
const DEFAULT_LOCK_RETRY_MS = 50;
const DEFAULT_LOCK_MAX_RETRIES = 100;

/**
 * Result of a read-modify-write. `ok: false` is a first-class outcome,
 * not an exception: "already claimed by X", "intent not claimed" and
 * "children still open" are the CORRECT results of a race the design
 * anticipates, and they must reach the LLM as readable text rather than
 * as a stack trace. A `false` outcome never writes.
 */
export type MailboxMutate<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * What the caller's mutator returns: the task list to write, or an abort.
 * The written list is deliberately NOT echoed back through `mutate` —
 * callers that need the post-write state return it as `value`, so there
 * is exactly one way to observe it.
 */
type MailboxPlan<T> =
	| { ok: true; tasks: Task[]; value: T }
	| { ok: false; error: string };

export type MailboxLockOptions = {
	/** Spacing between acquire attempts. Defaults to 50ms. */
	retryMs?: number;
	/** Attempt ceiling. Defaults to 100 (≈5s with the default spacing). */
	maxRetries?: number;
};

export type MailboxStoreOptions = MailboxLockOptions & {
	/** Clock for `updatedAt` stamps. Injectable so tests are deterministic. */
	now?: () => number;
};

/**
 * Acquire the store lock, returning the token that must be handed back
 * to `releaseMailboxLock`.
 *
 * The token is `<pid>:<uuid>`. Both halves matter: the PID prefix is
 * what the staleness check parses, and the UUID suffix makes the token
 * unique so a holder can tell its own lock from a successor's — which
 * is the only thing standing between a reclaim race and two writers
 * writing the file at once.
 */
export function acquireMailboxLock(
	lockPath: string,
	opts: MailboxLockOptions = {},
): string {
	const retryMs = opts.retryMs ?? DEFAULT_LOCK_RETRY_MS;
	const maxRetries = opts.maxRetries ?? DEFAULT_LOCK_MAX_RETRIES;
	mkdirSync(dirname(lockPath), { recursive: true });
	const token = `${process.pid}:${randomUUID()}`;

	for (let i = 0; i < maxRetries; i++) {
		try {
			// `wx` = create-exclusive: the atomic test-and-set is the
			// filesystem's, not ours. Anything else is a race.
			writeFileSync(lockPath, token, { flag: "wx" });
			return token;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw e;
			try {
				const pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
				// A lock naming a dead process is stale. So is one with no
				// readable PID, but only after a couple of attempts: the
				// file exists before its content is written, so a live
				// acquirer can look unparseable for a moment — one that
				// crashed in that window looks that way forever.
				if (pid > 0 ? !isProcessRunning(pid) : i >= 2) {
					unlinkSync(lockPath);
					continue;
				}
			} catch {
				/* unreadable lock — fall through to the retry wait */
			}
			const start = Date.now();
			while (Date.now() - start < retryMs) {
				/* busy wait, mirroring pi-tasks */
			}
		}
	}
	throw new Error(`failed to acquire mailbox lock: ${lockPath}`);
}

/**
 * Release a lock, but only if we still hold it. A lock can be reclaimed
 * out from under a live holder — `isProcessRunning` answers from the
 * local process table, so a session in another PID namespace (a
 * container, or a store shared over NFS) can read our PID as dead.
 * Without the token check we would delete the successor's lock and two
 * holders would write at once.
 */
export function releaseMailboxLock(lockPath: string, token: string): void {
	try {
		if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath);
	} catch {
		/* already gone — nothing to release */
	}
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the mailbox file into `Task`s.
 *
 * `parseTasksJson` is both the shared validator and the panel's reader,
 * and the mailbox writes exactly what it accepts — that compatibility IS
 * the design. But the parser also DROPS two fields, because it rebuilds
 * every record field by field and simply does not copy `owner` or
 * `activeForm` (`extensions/sidebar/tasks.ts:105`).
 *
 * For the panel that loss is invisible: `toTaskRows` reads neither, and
 * a claimed intent renders from `status: "in_progress"` alone. For the
 * mailbox it is not — `owner` is what `mailbox_claim` writes and what
 * the claim race reads back, and `activeForm` is a label the agent
 * authored.
 *
 * So the store validates through `parseTasksJson` and then re-attaches
 * those two fields from the same raw payload, keyed by id. Widening the
 * shared parser instead would have been the other option, and it would
 * have changed the panel's contract to serve a package the panel does
 * not own — `tasks.ts` is explicitly not this feature's to edit.
 */
export function parseMailboxJson(text: string): Task[] | null {
	const base = parseTasksJson(text);
	if (!base) return null;
	let raw: { tasks?: unknown };
	try {
		raw = JSON.parse(text) as { tasks?: unknown };
	} catch {
		return null;
	}
	if (!Array.isArray(raw.tasks)) return null;
	const extras = new Map<string, { owner?: string; activeForm?: string }>();
	for (const item of raw.tasks as Array<Record<string, unknown>>) {
		if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
		extras.set(item.id, {
			owner: typeof item.owner === "string" ? item.owner : undefined,
			activeForm: typeof item.activeForm === "string" ? item.activeForm : undefined,
		});
	}
	return base.map((t) => {
		const e = extras.get(t.id);
		return {
			...t,
			...(e?.owner ? { owner: e.owner } : {}),
			...(e?.activeForm ? { activeForm: e.activeForm } : {}),
		};
	});
}

/**
 * An intent is "unclaimed" when it is still mail: `pending`, with no
 * owner. Note this is deliberately narrower than `status !== completed`
 * — an intent the agent is actively working is not something to
 * announce, and re-announcing it would be the wake machine's one real
 * failure mode.
 */
export function isUnclaimedIntent(task: Task): boolean {
	return task.type === "intent" && task.status === "pending" && !task.owner;
}

/**
 * FIFO order: oldest `createdAt` first, id as tie-break.
 *
 * The tie-break compares NUMERICALLY when both ids parse as numbers and
 * lexicographically otherwise. A plain string compare would order `"10"`
 * before `"9"`, so the wake would announce the tenth task before the
 * ninth — a quiet, permanent wrong-order bug that never shows up on a
 * board small enough to eyeball. External senders are free to use ids
 * like `m-3`, which is exactly the non-numeric case the string compare
 * exists for.
 */
export function compareFifo(a: Task, b: Task): number {
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	const na = Number(a.id);
	const nb = Number(b.id);
	const bothNumeric = Number.isFinite(na) && Number.isFinite(nb);
	if (bothNumeric) return na - nb;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every unclaimed intent, oldest first. */
export function unclaimedIntents(tasks: Task[]): Task[] {
	return tasks.filter(isUnclaimedIntent).sort(compareFifo);
}

/**
 * The tasks a `mailbox_breakdown` produced for one intent. Child
 * linkage is `metadata.sourceIntent` rather than an edge in the DAG:
 * `blocks` / `blockedBy` order the steps relative to each other, but
 * they say nothing about which intent a step belongs to, and
 * `mailbox_complete`'s all-children-done gate needs exactly that.
 */
export function childTasks(tasks: Task[], intentId: string): Task[] {
	return tasks.filter((t) => t.metadata.sourceIntent === intentId);
}

/** Children of an intent that are not yet `completed`. */
export function openChildTasks(tasks: Task[], intentId: string): Task[] {
	return childTasks(tasks, intentId).filter((t) => t.status !== "completed");
}

/**
 * Allocate `count` fresh task ids that collide with nothing.
 *
 * Continues the numeric high-water mark already on the board, which is
 * the convention `pi-tasks` uses, but — unlike `pi-tasks`'s counter —
 * re-checks the used-id set on every candidate. That extra check is
 * what lets an externally-dropped intent carry a non-colliding id
 * (`m-3`, `7`, whatever the sender felt like) without the next
 * breakdown silently overwriting it.
 */
export function allocateTaskIds(tasks: Task[], count: number): string[] {
	const used = new Set(tasks.map((t) => t.id));
	let next = 1;
	for (const t of tasks) {
		const n = Number(t.id);
		if (Number.isFinite(n) && n >= next) next = n + 1;
	}
	const out: string[] = [];
	while (out.length < count) {
		const candidate = String(next++);
		if (used.has(candidate)) continue;
		used.add(candidate);
		out.push(candidate);
	}
	return out;
}

/**
 * One mailbox file. `read()` is the poll path (never throws — a missing
 * or malformed store reads as empty, per the design's error table) and
 * `mutate()` is the intake path (never throws either — it returns an
 * error envelope so the tools can hand the LLM readable text).
 */
export class MailboxStore {
	private storePath: string;
	private readonly lockOpts: MailboxLockOptions;
	private readonly now: () => number;

	constructor(path: string, opts: MailboxStoreOptions = {}) {
		this.storePath = path;
		this.lockOpts = {
			retryMs: opts.retryMs ?? DEFAULT_LOCK_RETRY_MS,
			maxRetries: opts.maxRetries ?? DEFAULT_LOCK_MAX_RETRIES,
		};
		this.now = opts.now ?? (() => Date.now());
	}

	get path(): string {
		return this.storePath;
	}

	get lockPath(): string {
		return `${this.storePath}.lock`;
	}

	/**
	 * Point an existing store at a different file.
	 *
	 * The mailbox path is a function of `cwd`, so a session reload or a
	 * cwd change moves it mid-process. The five LLM tools capture ONE
	 * store instance at registration time (they must, to be live before
	 * `session_start` fires), so re-pointing in place is what keeps them
	 * reading and writing the same mailbox the poller is watching. A new
	 * instance here would leave the tools stranded on the old file.
	 */
	retarget(path: string): void {
		this.storePath = path;
	}

	/**
	 * Whether the store file is on disk at all. The panel uses this to
	 * decide `available`: a session with only mailbox mail and no Sages
	 * board must still render "no tasks" rather than pretending the
	 * mailbox does not exist.
	 */
	exists(): boolean {
		return existsSync(this.path);
	}

	/** Best-effort read. Missing, unreadable, or malformed all read as `[]`. */
	read(): Task[] {
		try {
			return parseMailboxJson(readFileSync(this.path, "utf8")) ?? [];
		} catch {
			return [];
		}
	}

	/**
	 * Read-modify-write under the lock.
	 *
	 * The re-read happens INSIDE the lock, after it is held — reading
	 * before acquiring would be the classic TOCTOU, and the claim race
	 * the design cares about lives exactly in that window.
	 *
	 * `fn` receives the freshly-read tasks and returns either the tasks
	 * to write plus a value, or `{ ok: false, error }` to abort. An
	 * aborting `fn` is not a failure of the machinery: it is how
	 * "already claimed by X" stays a readable answer rather than a
	 * partial write.
	 */
	mutate<T>(fn: (tasks: Task[]) => MailboxPlan<T>): MailboxMutate<T> {
		let token: string;
		try {
			token = acquireMailboxLock(this.lockPath, this.lockOpts);
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		try {
			let parsed: Task[] | null;
			try {
				parsed = parseMailboxJson(readFileSync(this.path, "utf8"));
			} catch {
				parsed = null;
			}
			// A file that exists but does not parse is refused, not
			// overwritten. "No file" is the one legitimate empty state —
			// the mailbox is created by its first write, so an absent
			// file and an empty mailbox are the same thing.
			if (parsed === null && existsSync(this.path)) {
				return {
					ok: false,
					error: `malformed mailbox store at ${this.path} — refusing to overwrite it`,
				};
			}
			const outcome = fn(parsed ?? []);
			if (!outcome.ok) return outcome;
			this.write(outcome.tasks);
			return { ok: true, value: outcome.value };
		} finally {
			releaseMailboxLock(this.lockPath, token);
		}
	}

	/**
	 * Atomic write: temp file then rename. A reader can see the old
	 * file or the new one, never half of either — rename is the only
	 * primitive here that gives that, and a half-written JSON file is
	 * indistinguishable from a corrupt one to `parseTasksJson`.
	 */
	private write(tasks: Task[]): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmpPath = `${this.path}.tmp`;
		writeFileSync(tmpPath, JSON.stringify({ tasks }, null, 2));
		renameSync(tmpPath, this.path);
	}

	/** Stamp a mutation's `updatedAt`. Exposed so tools stamp uniformly. */
	timestamp(): number {
		return this.now();
	}
}