/**
 * AFT bridge — the ONLY file that knows AFT tool names and protocol details.
 *
 * If AFT renames a tool (e.g., `aft_zoom` → `aft_inspect_symbol`), only this
 * file changes. wrap/* stays stable.
 *
 * Architecture (per cortexkit/aft ARCHITECTURE.md):
 *   - One long-lived AFT daemon per project root, shared across sessions
 *   - NDJSON over stdio (one JSON object per line on each side)
 *   - Configure once at session start, then fire request/response pairs
 *
 * Public methods (readFile, outline, zoom, etc.) translate sage params to
 * AFT params, send the request, parse the response into typed results.
 *
 * Error handling:
 *   - NDJSON parse error → ParseError
 *   - AFT `{success:false}` → mapped via errors.ts aFtErrorFromResponse
 *   - Process spawn error → BunspawnError
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { resolveAftBinary, AftBinaryNotFoundError } from "./binary.js";
import {
	aftErrorFromResponse,
} from "./errors.js";
import type {
	AftError,
	AftResponse,
	AftSuccess,
	CallgraphResult,
	EditResult,
	GrepResult,
	InspectResult,
	OutlineResult,
	ReadResult,
	UndoResult,
	WriteResult,
	ZoomResult,
} from "./types.js";

// ─── Raw request/response ──────────────────────────────────────────────────────

export interface AftRawRequest {
	id: string;
	command: string;
	[key: string]: unknown;
}

export type { AftResponse, AftError, AftSuccess } from "./types.js";

// ─── Bridge class ────────────────────────────────────────────────────────────

interface ProcessHandle {
	proc: ChildProcess;
	stdoutBuf: string;
	pending: Map<string, (r: AftResponse) => void>;
	notifications: ((n: AftResponse) => void)[];
}

let singletonBridge: AftBridge | undefined;
let singletonHandle: ProcessHandle | undefined;

/**
 * Default safety timeout for in-flight requests. Reduced from 60s → 15s on
 * 2026-07-19: most hangs are configuration issues (not slow commands), and a
 * 60s wait on every misconfigured call destroys agent responsiveness.
 */
export const SAFETY_TIMEOUT_MS = 15_000;

/**
 * Default timeout for `ping()` health checks. 2s is enough for an idle daemon
 * to respond to a `version` command on localhost.
 */
export const PING_TIMEOUT_MS = 2_000;

export class AftBridge {
	private handle: ProcessHandle;

	private constructor(handle: ProcessHandle) {
		this.handle = handle;
		this.wireProcessListeners(handle);
	}

	/**
	 * Wire up stdout (NDJSON parser) and stdin ('error' listener for EPIPE)
	 * on the bridge's process handle. Called from the constructor so both
	 * `getInstance()` (real spawn) and `fromMockProcess()` (test injection)
	 * get identical listener behavior.
	 */
	private wireProcessListeners(handle: ProcessHandle): void {
		// EPIPE / write-error recovery: when the daemon's stdin pipe breaks
		// (crashed, killed, disconnected), Node's Writable emits 'error' on
		// the next write attempt — pending promises waiting for responses
		// would hang until the safety timer. Catch it here, fail all pending
		// requests with the error, kill the dead proc, and shut down the
		// singleton so the next bridgeFor() respawns a fresh daemon.
		handle.proc.stdin?.on("error", (err: Error) => {
			for (const [id, cb] of handle.pending) {
				handle.pending.delete(id);
				cb({
					id,
					success: false,
					code: "stdin_error",
					message: `[AFT] daemon stdin error: ${err.message}`,
				});
			}
			try {
				handle.proc.kill();
			} catch {
				// already dead
			}
			__shutdownBridge();
		});

		// NDJSON stdout parser. Each newline is one response or notification.
		// Force flowing mode so 'data' fires immediately on push() — without
		// this, a paused Readable buffers silently (which is why mock-based
		// tests were hanging before).
		handle.proc.stdout?.setEncoding("utf-8");
		handle.proc.stdout?.resume();
		handle.proc.stdout?.on("data", (chunk: string) => {
			handle.stdoutBuf += chunk;
			let idx;
			while ((idx = handle.stdoutBuf.indexOf("\n")) !== -1) {
				const line = handle.stdoutBuf.slice(0, idx).trim();
				handle.stdoutBuf = handle.stdoutBuf.slice(idx + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line) as AftResponse;
					if (msg.id && handle.pending.has(msg.id)) {
						const cb = handle.pending.get(msg.id);
						if (cb) {
							handle.pending.delete(msg.id);
							cb(msg);
						}
					} else if (msg.id === undefined && msg.success === false) {
						// Error response arrived without an id — AFT doesn't
						// always echo the request id on async errors (e.g.,
						// daemon_crash reported mid-stream). Route to the
						// most-recent-pending request as a synthetic error
						// response, so the caller fails fast instead of
						// waiting for the 15s safety timeout.
						const keys = Array.from(handle.pending.keys());
						const mostRecentId = keys[keys.length - 1];
						if (mostRecentId !== undefined) {
							const cb = handle.pending.get(mostRecentId);
							if (cb) {
								handle.pending.delete(mostRecentId);
								cb({
									id: mostRecentId,
									success: false,
									code: (msg as { code?: string }).code ?? "daemon_error",
									message:
										(msg as { message?: string }).message ??
										`[AFT] daemon reported error without request id: ${line.slice(0, 200)}`,
								});
							}
						} else {
							console.warn(
								`[AFT] unhandled daemon error (no pending requests): ${line.slice(0, 200)}`,
							);
						}
					} else if (
						(msg as { type?: string }).type === "status_changed" ||
						(msg as { type?: string }).type === "configure_warnings"
					) {
						for (const n of handle.notifications) n(msg);
					}
				} catch (e) {
					console.warn(`[AFT] malformed NDJSON line: ${line.slice(0, 200)}`);
				}
			}
		});
	}

	/**
	 * Returns the shared bridge for the current session. Spawns the AFT daemon
	 * on first call.
	 *
	 * Throws AftBinaryNotFoundError if the binary can't be resolved.
	 *
	 * For self-healing behavior (auto-respawn on dead singleton), use
	 * `await getHealthyBridge()` instead — it pings before returning.
	 */
	static getInstance(): AftBridge {
		if (singletonBridge) return singletonBridge;
		const handle = spawnAft();
		singletonHandle = handle;
		singletonBridge = new AftBridge(handle);
		return singletonBridge;
	}

	/** Test-only: construct a bridge over a pre-built mock process. */
	static fromMockProcess(handle: ProcessHandle): AftBridge {
		return new AftBridge(handle);
	}

	/**
	 * Health check: sends `version` and waits for a response. Returns true if
	 * the daemon answered within `timeoutMs`, false otherwise.
	 *
	 * Use this from `getHealthyBridge()` to detect a stale singleton
	 * (e.g., previous session died on kill -9 without firing `session_shutdown`).
	 */
	async ping(timeoutMs: number = PING_TIMEOUT_MS): Promise<boolean> {
		try {
			const result = await Promise.race([
				this.call({
					id: `ping-${Date.now()}`,
					command: "version",
				}),
				new Promise<{ success: false; code: string }>((resolve) =>
					setTimeout(
						() => resolve({ success: false, code: "ping_timeout" }),
						timeoutMs,
					),
				),
			]);
			return result.success === true;
		} catch {
			return false;
		}
	}

	/** Send a raw request and await the typed response. */
	async call(request: AftRawRequest): Promise<AftSuccess | AftError> {
		const promise = this._sendRaw(request);
		const response = await promise;
		if (!response.success) {
			// Don't throw here — let caller decide (some errors → return shape, others → throw)
			return response;
		}
		return response;
	}

	/** Send and throw on error. */
	async callOrThrow(request: AftRawRequest): Promise<AftSuccess> {
		const response = await this.call(request);
		if (!response.success) {
			throw aftErrorFromResponse(response);
		}
		return response;
	}

	// ─── Typed helpers — these are the only methods wrap/ should call ────────

	async outline(file: string, options?: { maxAnswerChars?: number }): Promise<OutlineResult> {
		const response = (await this.callOrThrow({
			id: `outline-${Date.now()}`,
			command: "outline",
			file,
			...(options?.maxAnswerChars !== undefined ? { max_answer_chars: options.maxAnswerChars } : {}),
		})) as AftSuccess<OutlineResult>;
		return {
			file: response.file as string,
			symbols: [], // AFT returns text-form, parsing happens in wrap/
			text: (response.text as string) ?? "",
		};
	}

	async zoom(
		file: string,
		symbol: string,
		options?: { callgraph?: boolean },
	): Promise<ZoomResult> {
		const req: AftRawRequest = {
			id: `zoom-${Date.now()}`,
			command: "zoom",
			file,
			symbol,
		};
		if (options?.callgraph !== undefined) req.callgraph = options.callgraph;
		const response = (await this.callOrThrow(req)) as AftSuccess<ZoomResult>;
		return response as unknown as ZoomResult;
	}

	async callgraph(
		file: string,
		symbol: string,
		direction: "inbound" | "outbound",
	): Promise<CallgraphResult> {
		const response = (await this.callOrThrow({
			id: `cg-${Date.now()}`,
			command: "callers",
			file,
			symbol,
			direction,
		})) as AftSuccess<CallgraphResult>;
		return {
			target: symbol,
			direction,
			references: response.references as CallgraphResult["references"],
		};
	}

	async grep(pattern: string, path: string, options?: { max?: number }): Promise<GrepResult> {
		const req: AftRawRequest = {
			id: `grep-${Date.now()}`,
			command: "grep",
			pattern,
			path,
		};
		if (options?.max !== undefined) req.max = options.max;
		const response = (await this.callOrThrow(req)) as AftSuccess<GrepResult>;
		return response as unknown as GrepResult;
	}

	async inspect(path: string): Promise<InspectResult> {
		const response = (await this.callOrThrow({
			id: `inspect-${Date.now()}`,
			command: "inspect",
			path,
		})) as AftSuccess<InspectResult>;
		return response as unknown as InspectResult;
	}

	async read(file: string, options?: { offset?: number; limit?: number }): Promise<ReadResult> {
		const req: AftRawRequest = {
			id: `read-${Date.now()}`,
			command: "read",
			file,
		};
		if (options?.offset !== undefined) req.offset = options.offset;
		if (options?.limit !== undefined) req.limit = options.limit;
		const response = (await this.callOrThrow(req)) as AftSuccess<ReadResult>;
		return {
			path: file,
			content: (response.content as string) ?? "",
			start_line: response.start_line as number | undefined,
			end_line: response.end_line as number | undefined,
		};
	}

	async write(file: string, content: string): Promise<WriteResult> {
		const response = (await this.callOrThrow({
			id: `write-${Date.now()}`,
			command: "write",
			file,
			content,
		})) as AftSuccess<WriteResult>;
		return {
			path: file,
			created: (response.created as boolean) ?? false,
			formatted: (response.formatted as boolean) ?? false,
			syntax_valid: (response.syntax_valid as boolean) ?? true,
			backup_id: response.backup_id as string | undefined,
			rolled_back: (response.rolled_back as boolean) ?? false,
		};
	}

	async edit(file: string, find: string, replace: string): Promise<EditResult> {
		const response = (await this.callOrThrow({
			id: `edit-${Date.now()}`,
			command: "edit",
			file,
			find,
			replace,
		})) as AftSuccess<EditResult>;
		return {
			path: file,
			formatted: (response.formatted as boolean) ?? false,
			syntax_valid: (response.syntax_valid as boolean) ?? true,
			backup_id: response.backup_id as string | undefined,
		};
	}

	async undo(backupId: string): Promise<UndoResult> {
		const response = (await this.callOrThrow({
			id: `undo-${Date.now()}`,
			command: "undo",
			backup_id: backupId,
		})) as AftSuccess<UndoResult>;
		return {
			path: "", // Filled in by wrap/
			backup_id: backupId,
			restored_count: (response.restored_count as number) ?? 0,
			operation: (response.operation as boolean) ?? true,
			warnings: (response.warnings as string[]) ?? [],
		};
	}

	// ─── Internal: raw send/receive ───────────────────────────────────────

	private _sendRaw(request: AftRawRequest): Promise<AftResponse> {
		return new Promise<AftResponse>((resolve, reject) => {
			const id = request.id;

			// Safety: 15s timeout — reduced from 60s on 2026-07-19. Most hangs
			// are configuration issues, not slow commands, so failing fast
			// gives the agent better feedback. Timer is captured so it can be
			// cleared when a response arrives — otherwise completed requests
			// leave the timer to fire later as a no-op, accumulating in the
			// event loop (matches user-reported "tool runs always and can't
			// cancel" symptom).
			const timer = setTimeout(() => {
				if (this.handle.pending.has(id)) {
					this.handle.pending.delete(id);
					reject(
						new Error(
							`[AFT] Request ${id} timed out after ${SAFETY_TIMEOUT_MS}ms`,
						),
					);
				}
			}, SAFETY_TIMEOUT_MS);

			this.handle.pending.set(id, (r: AftResponse) => {
				clearTimeout(timer);
				if (r.success) resolve(r);
				else resolve(r); // never reject — let caller branch on success
			});

			try {
				this.handle.proc.stdin?.write(JSON.stringify(request) + "\n");
			} catch (e) {
				// EPIPE / write-failure means the daemon's stdin is closed.
				// Reject this request, clear its timer, and mark the singleton
				// dead so the next bridgeFor() respawns.
				clearTimeout(timer);
				this.handle.pending.delete(id);
				__shutdownBridge();
				reject(
					e instanceof Error
						? e
						: new Error(`[AFT] stdin write failed: ${String(e)}`),
				);
			}
		});
	}

	/** Test-only accessor for the underlying handle. */
	_testHandle(): ProcessHandle {
		return this.handle;
	}

	/**
	 * Test-only accessor for the safety timeout constant. Lets tests assert
	 * the timeout value without reaching into module scope.
	 */
	get _safetyTimeoutMs(): number {
		return SAFETY_TIMEOUT_MS;
	}
}

/**
 * Self-healing bridge accessor. Pings the singleton before returning it;
 * if the ping fails (dead proc, unconfigured daemon), shuts down and respawns.
 *
 * Use this from wrap/ tools instead of `bridgeFor()` for any session where
 * the daemon might have died (long-lived sessions, sessions that resumed
 * after a crash, etc.). The first call has ~10ms overhead from the ping;
 * subsequent calls are O(1) via the singleton.
 */
export async function getHealthyBridge(): Promise<AftBridge> {
	const existing = AftBridge.getInstance();
	const healthy = await existing.ping();
	if (healthy) return existing;
	// Dead singleton — shutdown + respawn via the next getInstance() call
	__shutdownBridge();
	return AftBridge.getInstance();
}

/**
 * Test-only: inject a custom bridge into the module singleton. Used by
 * wrap functional tests to verify execute() behavior without spawning a
 * real AFT daemon. Pass `undefined` to clear the override and fall back
 * to the real singleton.
 *
 * Only takes effect when `bridgeFor()` is the next call site — wrap tools
 * call `bridgeFor()` (not `AftBridge.getInstance()` directly), so this
 * hook works transparently.
 */
let testBridgeOverride: AftBridge | undefined;
export function __setBridgeForTesting(bridge: AftBridge | undefined): void {
	testBridgeOverride = bridge;
}

/** Convenience: get-or-create the singleton bridge. */
export function bridgeFor(): AftBridge {
	if (testBridgeOverride) return testBridgeOverride;
	return AftBridge.getInstance();
}

/**
 * Spawn the AFT daemon and wire up NDJSON parsing.
 * Each newline on stdout is one response (or notification).
 */
function spawnAft(): ProcessHandle {
	let binPath: string;
	try {
		binPath = resolveAftBinary();
	} catch (e) {
		if (e instanceof AftBinaryNotFoundError) throw e;
		throw e;
	}

	const proc = spawn(binPath, [], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const handle: ProcessHandle = {
		proc,
		stdoutBuf: "",
		pending: new Map(),
		notifications: [],
	};

	// Listeners (stdout NDJSON parser + stdin error recovery) are wired in
	// the AftBridge constructor via wireProcessListeners(handle), so they're
	// also attached when fromMockProcess() is used in tests.

	proc.on("exit", (code) => {
		for (const [, cb] of handle.pending) {
			cb({
				id: "_exit",
				success: false,
				code: "exit",
				message: `AFT daemon exited with code ${code}`,
			});
		}
		handle.pending.clear();
		singletonBridge = undefined;
		singletonHandle = undefined;
	});

	return handle;
}

/** Test-only: kill the singleton bridge (for test cleanup). */
export function __shutdownBridge(): void {
	if (singletonHandle?.proc && !singletonHandle.proc.killed) {
		singletonHandle.proc.kill();
	}
	singletonBridge = undefined;
	singletonHandle = undefined;
}
