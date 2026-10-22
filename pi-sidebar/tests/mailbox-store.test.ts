/**
 * mailbox-store.test.ts — the mailbox file store.
 *
 * The store is the only module in the mailbox that touches the
 * filesystem, so everything here runs against a real temp directory with
 * no pi session, no home directory, and no `process.env` mutation: the
 * env bag is injected per call.
 *
 * The load-bearing assertion in this file is the `parseTasksJson`
 * compatibility block. The whole mailbox design rests on the premise
 * that the sidebar's EXISTING parser can read what the mailbox writes,
 * which is why the panel needs zero renderer changes. If a future edit
 * adds a status value, renames a field, or drops a required key, that
 * block is what catches it — before a user sees an empty panel.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
	MailboxStore,
	acquireMailboxLock,
	allocateTaskIds,
	childTasks,
	compareFifo,
	openChildTasks,
	releaseMailboxLock,
	unclaimedIntents,
} from "../extensions/sidebar/mailbox/store.js";
import { mailboxEnvFrom, mailboxPathFor } from "../extensions/sidebar/mailbox/types.js";
import { parseTasksJson } from "../extensions/sidebar/tasks.js";
import type { Task } from "../extensions/sidebar/types.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
	return {
		type: "plan",
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

let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-sidebar-mailbox-store-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

function storeIn(dirName: string, opts?: ConstructorParameters<typeof MailboxStore>[1]) {
	const file = path.join(tmpRoot, dirName, "mailbox", "tasks.json");
	return new MailboxStore(file, opts);
}

describe("mailbox env knobs", () => {
	it("ships the design-doc defaults", () => {
		expect(mailboxEnvFrom({})).toEqual({
			enabled: true,
			pollMs: 10000,
			wakeDebounceMs: 1500,
			wakeBackoffMs: 300000,
		});
	});

	it("honors every documented override", () => {
		expect(
			mailboxEnvFrom({
				PI_SIDEBAR_MAILBOX: "off",
				PI_SIDEBAR_MAILBOX_POLL_MS: "2500",
				PI_SIDEBAR_WAKE_DEBOUNCE_MS: "50",
				PI_SIDEBAR_WAKE_BACKOFF_MS: "60000",
			}),
		).toEqual({
			enabled: false,
			pollMs: 2500,
			wakeDebounceMs: 50,
			wakeBackoffMs: 60000,
		});
	});

	it("falls back on malformed values rather than throwing", () => {
		const env = mailboxEnvFrom({
			PI_SIDEBAR_MAILBOX_POLL_MS: "soon",
			PI_SIDEBAR_WAKE_DEBOUNCE_MS: "",
		});
		expect(env.pollMs).toBe(10000);
		expect(env.wakeDebounceMs).toBe(1500);
	});

	it("resolves the mailbox path under the orchestrator workdir + projectKey", () => {
		const cwd = "/home/dev/project";
		const path_ = mailboxPathFor(cwd, { ORCHESTRATOR_WORKDIR: "/tmp/orch" });
		expect(path_).toBe(
			path.join(
				"/tmp/orch",
				"--home-dev-project--",
				"mailbox",
				"tasks.json",
			),
		);
	});

	it("keeps ORCHESTRATOR_WORKDIR out of the process env by default in tests", () => {
		// A session-scoped root: the mailbox must not land in the user's
		// real orchestrator workdir just because a test called it.
		expect(mailboxPathFor("/w", {})).toContain(path.join("sages-orchestrator", "--w--"));
	});
});

describe("MailboxStore round-trip", () => {
	it("reads an absent store as empty rather than throwing", () => {
		const store = storeIn("missing");
		expect(existsSync(store.path)).toBe(false);
		expect(store.exists()).toBe(false);
		expect(store.read()).toEqual([]);
	});

	it("persists a mutation and reads it back", () => {
		const store = storeIn("round-trip");
		const out = store.mutate((tasks) => ({
			ok: true,
			tasks: [
				...tasks,
				makeTask({
					id: "m-1",
					type: "intent",
					subject: "Add retry to the uploader",
					description: "the mail body",
					createdAt: 1756000000000,
					updatedAt: 1756000000000,
				}),
			],
			value: "written",
		}));
		expect(out).toEqual({ ok: true, value: "written" });
		expect(store.exists()).toBe(true);
		expect(store.read()).toHaveLength(1);
		expect(store.read()[0].subject).toBe("Add retry to the uploader");
	});

	it("leaves the file untouched when the mutator refuses", () => {
		const store = storeIn("refused");
		store.mutate(() => ({ ok: true, tasks: [makeTask({ id: "m-1" })], value: 1 }));
		const before = readFileSync(store.path, "utf8");
		const out = store.mutate(() => ({ ok: false, error: "nope" }));
		expect(out).toEqual({ ok: false, error: "nope" });
		expect(readFileSync(store.path, "utf8")).toBe(before);
	});

	it("refuses to overwrite a malformed store", () => {
		const store = storeIn("malformed");
		mkdirSync(path.dirname(store.path), { recursive: true });
		writeFileSync(store.path, "{ not json");
		let invoked = false;
		const out = store.mutate(() => {
			invoked = true;
			return { ok: true, tasks: [], value: 1 };
		});
		expect(out.ok).toBe(false);
		expect(invoked).toBe(false);
		expect(readFileSync(store.path, "utf8")).toBe("{ not json");
		expect(store.read()).toEqual([]);
	});
});

describe("MailboxStore parseTasksJson compatibility", () => {
	/**
	 * The load-bearing invariant. Every field the mailbox writes must
	 * survive the sidebar's EXISTING parser, because the panel renders
	 * the mailbox through it with zero renderer changes.
	 */
	it("writes a file the sidebar's own parseTasksJson reads back", () => {
		const store = storeIn("compat");
		store.mutate((tasks) => ({
			ok: true,
			tasks: [
				...tasks,
				makeTask({
					id: "m-3",
					type: "intent",
					subject: "Add retry to the uploader",
					description: "the mail body is the entire brief",
					activeForm: "uploading",
					owner: "sess-abc",
					metadata: { wokenAt: 1756000000000 },
					blocks: [],
					blockedBy: [],
					createdAt: 1756000000000,
					updatedAt: 1756000000000,
				}),
				makeTask({
					id: "1",
					subject: "Step one",
					blockedBy: [],
					metadata: { sourceIntent: "m-3" },
					createdAt: 1756000000001,
				}),
				makeTask({
					id: "2",
					subject: "Step two",
					blockedBy: ["1"],
					blocks: [],
					metadata: { sourceIntent: "m-3" },
					createdAt: 1756000000002,
				}),
			],
			value: 1,
		}));

		const parsed = parseTasksJson(readFileSync(store.path, "utf8"));
		expect(parsed).not.toBeNull();
		expect(parsed).toHaveLength(3);

		const intent = parsed!.find((t) => t.id === "m-3")!;
		expect(intent.type).toBe("intent");
		expect(intent.status).toBe("pending");
		expect(intent.metadata.wokenAt).toBe(1756000000000);

		const child = parsed!.find((t) => t.id === "2")!;
		expect(child.type).toBe("plan");
		expect(child.blockedBy).toEqual(["1"]);
		expect(child.metadata.sourceIntent).toBe("m-3");
	});

	it("round-trips owner and activeForm, which parseTasksJson drops", () => {
		// The panel parser rebuilds every record field by field and never
		// copies `owner` / `activeForm` (`tasks.ts:105`). That is invisible
		// to the panel — `toTaskRows` reads neither — but `mailbox_claim`
		// WRITES `owner` and reads it back to lose the claim race, so the
		// store re-attaches it from the same payload instead of widening
		// the shared parser. Pinned here so the gap stays a decision.
		const store = storeIn("owner-round-trip");
		store.mutate((tasks) => ({
			ok: true,
			tasks: [
				...tasks,
				makeTask({
					id: "m-3",
					type: "intent",
					activeForm: "uploading",
					owner: "sess-abc",
				}),
			],
			value: 1,
		}));
		expect(parseTasksJson(readFileSync(store.path, "utf8"))![0].owner).toBeUndefined();
		expect(store.read()[0].owner).toBe("sess-abc");
		expect(store.read()[0].activeForm).toBe("uploading");
	});

	it("writes the exact envelope the design doc specifies", () => {
		const store = storeIn("envelope");
		store.mutate((tasks) => ({
			ok: true,
			tasks: [...tasks, makeTask({ id: "m-1", type: "intent" })],
			value: 1,
		}));
		const raw = JSON.parse(readFileSync(store.path, "utf8"));
		expect(Object.keys(raw)).toEqual(["tasks"]);
		expect(Array.isArray(raw.tasks)).toBe(true);
	});

	it("claims as pending -> in_progress + owner, which the parser accepts", () => {
		const store = storeIn("claim-shape");
		store.mutate((tasks) => ({
			ok: true,
			tasks: [...tasks, makeTask({ id: "m-1", type: "intent" })],
			value: 1,
		}));
		store.mutate((tasks) => ({
			ok: true,
			tasks: tasks.map((t) =>
				t.id === "m-1" ? { ...t, status: "in_progress" as const, owner: "sess-1" } : t,
			),
			value: 1,
		}));
		const parsed = parseTasksJson(readFileSync(store.path, "utf8"))!;
		expect(parsed[0].status).toBe("in_progress");
		expect(store.read()[0].owner).toBe("sess-1");
	});
});

describe("MailboxStore claim race", () => {
	it("refuses the second claimer and leaves the store unchanged", () => {
		const store = storeIn("race");
		store.mutate((tasks) => ({
			ok: true,
			tasks: [...tasks, makeTask({ id: "m-1", type: "intent" })],
			value: 1,
		}));
		const before = readFileSync(store.path, "utf8");

		const winner = store.mutate((tasks) => {
			const target = tasks.find((t) => t.id === "m-1")!;
			return {
				ok: true,
				tasks: tasks.map((t) =>
					t.id === "m-1"
						? { ...t, status: "in_progress" as const, owner: "sess-A" }
						: t,
				),
				value: target.id,
			};
		});
		expect(winner.ok).toBe(true);

		const loser = store.mutate((tasks) => {
			const target = tasks.find((t) => t.id === "m-1")!;
			if (target.status !== "pending" || target.owner) {
				return { ok: false, error: `already claimed by ${target.owner}` };
			}
			return {
				ok: true,
				tasks: tasks.map((t) =>
					t.id === "m-1"
						? { ...t, status: "in_progress" as const, owner: "sess-B" }
						: t,
				),
				value: target.id,
			};
		});
		expect(loser).toEqual({ ok: false, error: "already claimed by sess-A" });
		expect(store.read()[0].owner).toBe("sess-A");
		expect(readFileSync(store.path, "utf8")).not.toBe(before);
		expect(store.read()[0].status).toBe("in_progress");
	});
});

describe("MailboxStore children and the all-children-done gate", () => {
	it("finds children by metadata.sourceIntent", () => {
		const tasks = [
			makeTask({ id: "m-1", type: "intent" }),
			makeTask({ id: "1", metadata: { sourceIntent: "m-1" } }),
			makeTask({ id: "2", metadata: { sourceIntent: "m-1" }, status: "completed" }),
			makeTask({ id: "3", metadata: { sourceIntent: "m-9" } }),
			makeTask({ id: "4" }),
		];
		expect(childTasks(tasks, "m-1").map((t) => t.id)).toEqual(["1", "2"]);
		expect(openChildTasks(tasks, "m-1").map((t) => t.id)).toEqual(["1"]);
		expect(openChildTasks(tasks, "m-9").map((t) => t.id)).toEqual(["3"]);
		expect(openChildTasks(tasks, "m-none")).toEqual([]);
	});

	it("treats an intent with no children at all as closable", () => {
		expect(openChildTasks([makeTask({ id: "m-1", type: "intent" })], "m-1")).toEqual([]);
	});
});

describe("task id allocation", () => {
	it("continues the numeric sequence already on the board", () => {
		expect(allocateTaskIds([makeTask({ id: "1" }), makeTask({ id: "2" })], 2)).toEqual([
			"3",
			"4",
		]);
	});

	it("ignores non-numeric ids when finding the high-water mark", () => {
		expect(allocateTaskIds([makeTask({ id: "m-3" }), makeTask({ id: "7" })], 1)).toEqual([
			"8",
		]);
	});

	it("never collides with an existing id", () => {
		expect(allocateTaskIds([makeTask({ id: "1" }), makeTask({ id: "2" })], 1)).toEqual(["3"]);
		expect(
			allocateTaskIds([makeTask({ id: "3" }), makeTask({ id: "x" }), makeTask({ id: "4" })], 1),
		).toEqual(["5"]);
	});

	it("starts at 1 on an empty board", () => {
		expect(allocateTaskIds([], 3)).toEqual(["1", "2", "3"]);
	});
});

describe("unclaimed intents (FIFO)", () => {
	it("keeps only pending, owner-less intents", () => {
		const tasks = [
			makeTask({ id: "a", type: "intent", status: "pending" }),
			makeTask({ id: "b", type: "intent", status: "pending", owner: "sess-1" }),
			makeTask({ id: "c", type: "intent", status: "in_progress" }),
			makeTask({ id: "d", type: "intent", status: "completed" }),
			makeTask({ id: "e", type: "plan", status: "pending" }),
		];
		expect(unclaimedIntents(tasks).map((t) => t.id)).toEqual(["a"]);
	});

	it("orders oldest-first on createdAt", () => {
		const tasks = [
			makeTask({ id: "b", type: "intent", createdAt: 200 }),
			makeTask({ id: "a", type: "intent", createdAt: 100 }),
		];
		expect(unclaimedIntents(tasks).map((t) => t.id)).toEqual(["a", "b"]);
	});

	it("breaks a createdAt tie numerically, not lexicographically", () => {
		// The naive `"10" < "9"` string compare would announce task 10
		// before task 9, which is exactly the kind of quiet wrong-order
		// bug that never shows up on a board with single digits.
		const tasks = [
			makeTask({ id: "10", type: "intent", createdAt: 100 }),
			makeTask({ id: "9", type: "intent", createdAt: 100 }),
		];
		expect(compareFifo(tasks[0], tasks[1])).toBeGreaterThan(0);
		expect(unclaimedIntents(tasks).map((t) => t.id)).toEqual(["9", "10"]);
	});

	it("falls back to a string compare for non-numeric ids", () => {
		const tasks = [
			makeTask({ id: "m-10", type: "intent", createdAt: 100 }),
			makeTask({ id: "m-9", type: "intent", createdAt: 100 }),
		];
		expect(unclaimedIntents(tasks).map((t) => t.id)).toEqual(["m-10", "m-9"]);
	});
});

describe("MailboxStore locking", () => {
	it("acquires and releases the lock around a mutation", () => {
		const store = storeIn("lock-cycle");
		store.mutate((tasks) => ({ ok: true, tasks, value: 1 }));
		expect(existsSync(`${store.path}.lock`)).toBe(false);
	});

	it("reaps a lock naming a dead process", () => {
		const store = storeIn("stale-reap", { retryMs: 1, maxRetries: 5 });
		mkdirSync(path.dirname(store.path), { recursive: true });
		// A real PID of a shell that has already exited — the staleness
		// check is `process.kill(pid, 0)`, so a live-looking-but-dead pid
		// is the only honest way to exercise the reap.
		const deadPid = execFileSync("sh", ["-c", "echo $$"]).toString().trim();
		writeFileSync(`${store.path}.lock`, `${deadPid}:dead-token`);

		const out = store.mutate((tasks) => ({
			ok: true,
			tasks: [...tasks, makeTask({ id: "m-1" })],
			value: 1,
		}));
		expect(out.ok).toBe(true);
		expect(store.read()).toHaveLength(1);
	});

	it("refuses rather than corrupting when a live process holds the lock", () => {
		const store = storeIn("live-lock", { retryMs: 1, maxRetries: 3 });
		mkdirSync(path.dirname(store.path), { recursive: true });
		// Our OWN pid is definitionally alive, so the stale-reap branch
		// must not fire and the mutator must never run.
		writeFileSync(`${store.path}.lock`, `${process.pid}:held-by-someone-else`);

		let invoked = false;
		const out = store.mutate((tasks) => {
			invoked = true;
			return { ok: true, tasks, value: 1 };
		});
		expect(out.ok).toBe(false);
		expect(invoked).toBe(false);
		expect(existsSync(store.path)).toBe(false);
	});

	it("does not delete a successor's lock on release", () => {
		const lockPath = path.join(tmpRoot, "successor", "mailbox", "tasks.json.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		const ours = acquireMailboxLock(lockPath, { retryMs: 1, maxRetries: 3 });
		// Simulate the reap-then-steal window: between our acquire and our
		// release, a successor decided our lock was stale (the PID check
		// answers from the local process table, so a holder in another PID
		// namespace reads as dead) and took the lock itself.
		writeFileSync(lockPath, `${process.pid}:successor-token`);
		releaseMailboxLock(lockPath, ours);
		// Without the token check this would unlink the successor's lock
		// and two holders would write the file at once.
		expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}:successor-token`);
	});

	it("releases its own lock when nothing stole it", () => {
		const lockPath = path.join(tmpRoot, "own-release", "mailbox", "tasks.json.lock");
		const token = acquireMailboxLock(lockPath, { retryMs: 1, maxRetries: 3 });
		expect(readFileSync(lockPath, "utf8")).toBe(token);
		releaseMailboxLock(lockPath, token);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("survives releasing a lock that is already gone", () => {
		const lockPath = path.join(tmpRoot, "gone", "mailbox", "tasks.json.lock");
		mkdirSync(path.dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "1:whatever");
		expect(() => releaseMailboxLock(lockPath, "1:whatever")).not.toThrow();
	});
});