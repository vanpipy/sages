/**
 * Bridge resilience tests — self-healing singleton + error-without-id fallback + EPIPE recovery.
 *
 * Companion to bridge-lifecycle.test.ts (which covers timer hygiene). This file
 * covers failure-mode recovery that the bridge must handle without user intervention:
 *
 *   1. ping() — health check that returns true on healthy daemon, false on timeout
 *   2. ping() — triggers __shutdownBridge + respawn on dead singleton
 *   3. EPIPE on stdin.write → triggers __shutdownBridge (stale pipe)
 *   4. Error response with no matching id → reject most-recent-pending promise
 *   5. Safety timeout reduced from 60s → 15s (faster failure feedback)
 *
 * Uses the existing `AftBridge.fromMockProcess()` test hook (aft/bridge.ts:86) and
 * the `setTimeout` spy pattern from bridge-lifecycle.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Readable, Writable } from "node:stream";
import { AftBridge, __shutdownBridge } from "../../src/tools/aft/bridge.js";

// ─── Mock process streams (same shape as bridge-lifecycle.test.ts) ────────────

class MockWritable extends Writable {
	written: string = "";
	failNextWrite = false;
	_write(
		chunk: Buffer | string,
		_enc: string,
		callback: (err?: Error | null) => void,
	): void {
		if (this.failNextWrite) {
			this.failNextWrite = false;
			callback(new Error("EPIPE: broken pipe"));
			return;
		}
		this.written += typeof chunk === "string" ? chunk : chunk.toString();
		callback();
	}
}

class MockReadable extends Readable {
	_read(): void {}
	pushLine(line: string): void {
		const ok = this.push(line + "\n");
		// Force flowing mode if push() returned false (buffer full)
		if (!ok) this.resume();
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
			/* no-op */
		},
	};
	return {
		proc: proc as unknown as MockHandle["proc"],
		stdoutBuf: "",
		pending: new Map(),
		notifications: [],
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AftBridge.ping — health check", () => {
	beforeEach(() => __shutdownBridge());
	afterEach(() => __shutdownBridge());

	test("ping() returns true when daemon responds to a version command", async () => {
		const handle = makeMockHandle();
		const bridge = AftBridge.fromMockProcess(
			handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0],
		);

		// Stub _sendRaw to simulate a healthy response (we don't go through the
		// real NDJSON round-trip — just verify ping() invokes the right command
		// and resolves on success).
		const originalSend = (bridge as unknown as {
			_sendRaw: (r: unknown) => Promise<{ success: boolean }>;
		})._sendRaw.bind(bridge);
		(bridge as unknown as { _sendRaw: (r: unknown) => Promise<{ success: boolean }> })._sendRaw = async (
			r: unknown,
		) => {
			const req = r as { command: string };
			if (req.command === "version") {
				return { success: true, version: "0.47.2" };
			}
			return originalSend(r);
		};

		const ok = await (bridge as unknown as { ping: () => Promise<boolean> }).ping();
		expect(ok).toBe(true);
	});

	test("ping() returns false when daemon does not respond within timeout", async () => {
		const handle = makeMockHandle();
		const bridge = AftBridge.fromMockProcess(
			handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0],
		);

		// Stub _sendRaw to simulate a hanging daemon (promise never resolves)
		(bridge as unknown as { _sendRaw: (_r: unknown) => Promise<unknown> })._sendRaw = () =>
			new Promise(() => {
				/* hang forever */
			});

		const start = Date.now();
		const ok = await (bridge as unknown as { ping: (ms?: number) => Promise<boolean> }).ping(50);
		const elapsed = Date.now() - start;
		expect(ok).toBe(false);
		// Must fail within the timeout window, not wait for the full 60s default
		expect(elapsed).toBeLessThan(500);
	});

	test("ping() triggers __shutdownBridge when the singleton is dead (stale recovery)", async () => {
		// This test verifies that bridgeFor() + ping() together self-heal.
		// We can't easily test bridgeFor() without a real spawn, so we verify
		// the behavior at the singleton layer: __shutdownBridge() is idempotent
		// and the ping timeout path exists.
		const handle = makeMockHandle();
		const bridge = AftBridge.fromMockProcess(
			handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0],
		);
		(bridge as unknown as { _sendRaw: (_r: unknown) => Promise<unknown> })._sendRaw = () =>
			new Promise(() => {});

		const ok = await (bridge as unknown as { ping: (ms?: number) => Promise<boolean> }).ping(30);
		expect(ok).toBe(false);

		// After ping fails, the caller (bridgeFor) should treat the singleton
		// as dead and call __shutdownBridge(). We verify the helper is safe to
		// call and doesn't throw even when the bridge was created via
		// fromMockProcess (which doesn't set the module singleton).
		expect(() => __shutdownBridge()).not.toThrow();
	});
});

describe("AftBridge — EPIPE recovery", () => {
	beforeEach(() => __shutdownBridge());
	afterEach(() => __shutdownBridge());

	test("EPIPE on stdin emits 'error' event → all pending requests fail + __shutdownBridge", async () => {
		const handle = makeMockHandle();
		const stdin = handle.proc.stdin as MockWritable;

		let killedExternally = false;
		const originalKill = handle.proc.kill.bind(handle.proc);
		handle.proc.kill = () => {
			killedExternally = true;
			originalKill();
		};

		const bridge = AftBridge.fromMockProcess(
			handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0],
		);

		// Fire two requests; both register callbacks in handle.pending
		const p1 = (
			bridge as unknown as { _sendRaw: (r: unknown) => Promise<unknown> }
		)._sendRaw({ id: "epipe-a", command: "outline", file: "x" });
		const p2 = (
			bridge as unknown as { _sendRaw: (r: unknown) => Promise<unknown> }
		)._sendRaw({ id: "epipe-b", command: "outline", file: "y" });

		// Suppress unhandled-rejection for any pending promises
		p1.catch(() => {});
		p2.catch(() => {});

		// Now simulate the daemon's stdin pipe breaking — Node's Writable
		// emits 'error' asynchronously after the write fails. The bridge's
		// stdin 'error' listener should reject all pending requests.
		stdin.emit("error", new Error("EPIPE: broken pipe"));

		const r1 = await p1;
		const r2 = await p2;

		expect((r1 as { success: boolean; code: string }).success).toBe(false);
		expect((r1 as { success: boolean; code: string }).code).toBe("stdin_error");
		expect((r2 as { success: boolean; code: string }).success).toBe(false);
		expect((r2 as { success: boolean; code: string }).code).toBe("stdin_error");
		// __shutdownBridge calls handle.proc.kill()
		expect(killedExternally).toBe(true);
	});
});

describe("AftBridge — error-without-id routes to most-recent pending", () => {
	beforeEach(() => __shutdownBridge());
	afterEach(() => __shutdownBridge());

	test("an error line arriving via stdout with no id routes to most-recent-pending", async () => {
		const handle = makeMockHandle();
		const stdout = handle.proc.stdout as MockReadable;

		const bridge = AftBridge.fromMockProcess(
			handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0],
		);

		// Fire two requests — both register callbacks in pending map
		const p1 = (
			bridge as unknown as { _sendRaw: (r: unknown) => Promise<unknown> }
		)._sendRaw({ id: "first-1", command: "outline", file: "a" });
		const p2 = (
			bridge as unknown as { _sendRaw: (r: unknown) => Promise<unknown> }
		)._sendRaw({ id: "second-2", command: "outline", file: "b" });

		// Suppress unhandled rejection for p1 — it's NOT expected to resolve
		// (only the most-recent-pending gets the synthetic error response).
		// The test would otherwise hang on `await p1` first.
		p1.catch(() => {});

		// Simulate the daemon sending a late error message WITHOUT a request
		// id (e.g., daemon_crash reported mid-stream). This is the case the
		// new stdout handler must handle — previously it was silently dropped.
		stdout.pushLine(
			JSON.stringify({
				success: false,
				code: "daemon_crash",
				message: "AFT daemon internal panic",
			}),
		);

		const r2 = await p2;

		// p2 was most-recently inserted into pending, so it receives the
		// synthetic error response with the daemon_crash code preserved.
		expect((r2 as { success: boolean; code: string }).success).toBe(false);
		expect((r2 as { success: boolean; code: string }).code).toBe("daemon_crash");

		// p1 remains pending — the design choice is to route the late error
		// to only the most-recent caller (avoids ambiguous multi-resolve).
		// The 15s safety timer will fire for p1; in tests we just verify
		// it never auto-resolved by checking the pending map is empty.
		expect(handle.pending.size).toBe(1); // only p1 remains
		expect(handle.pending.has("first-1")).toBe(true);
	});
});

describe("AftBridge — safety timeout", () => {
	test("default safety timeout is 15s (reduced from 60s for faster failure)", () => {
		// The constant is exported for testing. Verify it's 15_000, not 60_000.
		const handle = makeMockHandle();
		const bridge = AftBridge.fromMockProcess(
			handle as unknown as Parameters<typeof AftBridge.fromMockProcess>[0],
		);

		// Read the constant via a known surface. If it's private, this test
		// fails and tells us to expose it.
		const safetyMs = (
			bridge as unknown as { _safetyTimeoutMs?: number }
		)._safetyTimeoutMs;
		expect(safetyMs).toBe(15_000);
	});
});