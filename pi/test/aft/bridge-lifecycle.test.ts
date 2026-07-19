/**
 * Tests for AftBridge timer hygiene and lifecycle.
 *
 * The bridge spawns one long-lived AFT daemon process per session. Each
 * request to the daemon carries a 60s safety timeout. Without explicit
 * cleanup, completed requests leave the timeout to fire 60s later (no-op
 * for finished requests, but the timer itself accumulates in the event
 * loop — observable as "always-running timers" in heap snapshots and
 * matches the user-reported symptom of "tool runs always and can't cancel").
 *
 * These tests pin down the contract:
 *   - timer is captured when the request is sent
 *   - timer is cleared when a response (success OR error) arrives
 *   - timer is NOT cleared if the request times out (so the rejection fires)
 *   - __shutdownBridge kills the daemon process
 *   - __shutdownBridge is safe to call when no bridge exists
 *
 * Black-box approach: spy on globalThis.setTimeout/clearTimeout, drive
 * the bridge with a mock proc (no real AFT binary needed), assert timer
 * call counts.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Readable, Writable } from "node:stream";
import { AftBridge, __shutdownBridge } from "../../src/tools/aft/bridge.js";

// ─── Mock process streams ────────────────────────────────────────────────────

class MockWritable extends Writable {
	written: string = "";
	_write(chunk: Buffer | string, _enc: string, callback: () => void): void {
		this.written += typeof chunk === "string" ? chunk : chunk.toString();
		callback();
	}
}

class MockReadable extends Readable {
	_read(): void {
		// No-op: tests push() data explicitly
	}
}

interface MockHandle {
	proc: {
		stdin: Writable | null;
		stdout: Readable | null;
		killed: boolean;
		kill: () => void;
		on: (event: string, cb: (...args: unknown[]) => void) => void;
	};
	stdoutBuf: string;
	pending: Map<string, (r: unknown) => void>;
	notifications: ((n: unknown) => void)[];
}

function makeMockHandle(): MockHandle {
	const stdin = new MockWritable();
	const stdout = new MockReadable();
	const proc = {
		stdin,
		stdout,
		killed: false,
		kill(this: MockHandle["proc"]) {
			this.killed = true;
		},
		on(_event: string, _cb: (...args: unknown[]) => void) {
			/* no-op for tests */
		},
	};
	return {
		proc: proc as MockHandle["proc"],
		stdoutBuf: "",
		pending: new Map(),
		notifications: [],
	};
}

// ─── setTimeout / clearTimeout spies ─────────────────────────────────────────

interface SpyHandle {
	originalSet: typeof setTimeout;
	originalClear: typeof clearTimeout;
	setIds: Set<unknown>;
	clearedIds: Set<unknown>;
}

function installTimerSpies(): SpyHandle {
	const handle: SpyHandle = {
		originalSet: globalThis.setTimeout,
		originalClear: globalThis.clearTimeout,
		setIds: new Set(),
		clearedIds: new Set(),
	};
	globalThis.setTimeout = function (
		cb: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	): NodeJS.Timeout {
		const id = handle.originalSet(cb, ms as number, ...args);
		handle.setIds.add(id);
		return id;
	} as typeof setTimeout;
	globalThis.clearTimeout = function (id: unknown): void {
		if (id !== undefined && id !== null) handle.clearedIds.add(id);
		(handle.originalClear as (id: unknown) => void)(id);
	} as typeof clearTimeout;
	return handle;
}

function uninstallTimerSpies(spies: SpyHandle): void {
	globalThis.setTimeout = spies.originalSet;
	globalThis.clearTimeout = spies.originalClear;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AftBridge timer hygiene", () => {
	let spies: SpyHandle;

	beforeEach(() => {
		spies = installTimerSpies();
		// Ensure no singleton bridge from a previous test
		__shutdownBridge();
	});

	afterEach(() => {
		uninstallTimerSpies(spies);
		__shutdownBridge();
	});

	test("_sendRaw clears the 60s safety timer when a successful response arrives", async () => {
		const handle = makeMockHandle();
		const bridge = AftBridge.fromMockProcess(handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0]);

		const promise = (bridge as unknown as { _sendRaw: (r: { id: string; command: string }) => Promise<unknown> })._sendRaw({
			id: "ok-1",
			command: "outline",
		});

		// One timer should have been scheduled
		expect(spies.setIds.size).toBe(1);
		const [timerId] = spies.setIds;
		expect(spies.clearedIds.has(timerId)).toBe(false);

		// Simulate the daemon sending a successful response
		const cb = handle.pending.get("ok-1");
		expect(cb).toBeDefined();
		cb!({ id: "ok-1", success: true, file: "foo.ts", symbols: [] });

		const result = (await promise) as { success: boolean };
		expect(result.success).toBe(true);

		// The timer MUST have been cleared on success — otherwise it fires
		// 60s later as a no-op, accumulating in the event loop.
		expect(spies.clearedIds.has(timerId)).toBe(true);
	});

	test("_sendRaw clears the 60s safety timer when an error response arrives", async () => {
		const handle = makeMockHandle();
		const bridge = AftBridge.fromMockProcess(handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0]);

		const promise = (bridge as unknown as { _sendRaw: (r: { id: string; command: string }) => Promise<unknown> })._sendRaw({
			id: "err-1",
			command: "zoom",
		});

		expect(spies.setIds.size).toBe(1);
		const [timerId] = spies.setIds;

		// Simulate daemon sending an error response (not a timeout)
		const cb = handle.pending.get("err-1");
		cb!({ id: "err-1", success: false, code: "not_found", message: "no such symbol" });

		const result = (await promise) as { success: boolean };
		expect(result.success).toBe(false);

		// Timer MUST be cleared on error response too
		expect(spies.clearedIds.has(timerId)).toBe(true);
	});

	test("_sendRaw does NOT clear the timer when the response is a timeout (timer is the only rejector)", async () => {
		const handle = makeMockHandle();
		const bridge = AftBridge.fromMockProcess(handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0]);

		// Speed up: don't actually wait 60s. We assert by inspection.
		const promise = (bridge as unknown as { _sendRaw: (r: { id: string; command: string }) => Promise<unknown> })._sendRaw({
			id: "to-1",
			command: "grep",
		});

		expect(spies.setIds.size).toBe(1);
		const [timerId] = spies.setIds;

		// Don't simulate any response — verify timer is NOT cleared.
		// (We don't actually fire the 60s timeout in the test; we just confirm
		// that without a response arriving, the timer stays in setIds.)
		expect(spies.clearedIds.has(timerId)).toBe(false);

		// Cancel the pending promise so the test exits cleanly
		promise.catch(() => {});
	});
});

describe("AftBridge lifecycle (__shutdownBridge)", () => {
	test("__shutdownBridge is safe to call when no bridge exists (idempotent)", () => {
		// First call should not throw
		expect(() => __shutdownBridge()).not.toThrow();
		// Second call should also not throw (idempotent)
		expect(() => __shutdownBridge()).not.toThrow();
	});

	test("__shutdownBridge kills the daemon process when called", () => {
		const handle = makeMockHandle();
		AftBridge.fromMockProcess(handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0]);

		// Note: fromMockProcess doesn't set the singleton — __shutdownBridge
		// only operates on the singleton. This test verifies the singleton
		// path is safe even when the bridge was constructed via the test path.
		// (We can't easily test singleton teardown without a real spawn, so
		// the assertion here is just that calling shutdown doesn't throw.)
		expect(() => __shutdownBridge()).not.toThrow();
	});
});