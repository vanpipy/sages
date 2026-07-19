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

export class AftBridge {
	private handle: ProcessHandle;

	private constructor(handle: ProcessHandle) {
		this.handle = handle;
	}

	/**
	 * Returns the shared bridge for the current session. Spawns the AFT daemon
	 * on first call.
	 *
	 * Throws AftBinaryNotFoundError if the binary can't be resolved.
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

			// Safety: 60s timeout — capture the timer handle so we can cancel
			// it when a response arrives. Without clearTimeout, completed
			// requests leave the timer to fire 60s later as a no-op, which
			// accumulates in the event loop (matches user-reported symptom
			// of "tool runs always and can't cancel").
			const timer = setTimeout(() => {
				if (this.handle.pending.has(id)) {
					this.handle.pending.delete(id);
					reject(new Error(`[AFT] Request ${id} timed out`));
				}
			}, 60_000);

			this.handle.pending.set(id, (r: AftResponse) => {
				clearTimeout(timer);
				if (r.success) resolve(r);
				else resolve(r); // never reject — let caller branch on success
			});

			this.handle.proc.stdin?.write(JSON.stringify(request) + "\n");
		});
	}

	/** Test-only accessor for the underlying handle. */
	_testHandle(): ProcessHandle {
		return this.handle;
	}
}

/** Convenience: get-or-create the singleton bridge. */
export function bridgeFor(): AftBridge {
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

	proc.stdout?.setEncoding("utf-8");
	proc.stdout?.on("data", (chunk: string) => {
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
				} else if ((msg as any).type === "status_changed" || (msg as any).type === "configure_warnings") {
					for (const n of handle.notifications) n(msg);
				}
			} catch (e) {
				console.warn(`[AFT] malformed NDJSON line: ${line.slice(0, 200)}`);
			}
		}
	});

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
