/**
 * pi-evaluator/src/lib/jsonl-reader.ts
 *
 * Read `session.jsonl` files produced by the pi coding agent (and the legacy
 * orchestrator). Two entry points:
 *
 *   - `readSession(path)`: Promise<SessionReadResult> — full read into memory.
 *   - `readSessionIter(path)`: Iterable<{ kind: "entry", entry } | { kind: "skip", line_count, error_count }>
 *     — streaming-friendly for large sessions.
 *
 * Supported JSONL entry shapes:
 *
 *   1. **pi session format** (current):
 *      `{"type":"message","timestamp":"…","message":{"role":"…","content":[…],"usage":{…}}}`
 *   2. **legacy format**:
 *      `{"type":"message","timestamp":"…","content":"some plain text"}`
 *   3. **session markers**: `session`, `session_start`, `session_end`
 *   4. **model_change**: provider / model switch events
 *   5. **thinking_level_change**: thinking-depth changes
 *
 * Malformed lines (invalid JSON or wrong shape) are SKIPPED, not fatal. The
 * `error_count` field on the result exposes how many were dropped so callers
 * can surface a warning to the LLM judge.
 *
 * No npm dependency added (constraint: max_dependency_additions: 0). Streaming
 * uses Node's `readline` via `node:fs` — Bun also exposes `Bun.file()` but
 * the line-by-line shape works for both runtimes.
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
	ContentBlock,
	Message,
	SessionEntry,
	SessionReadResult,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Entry-point signatures
// ---------------------------------------------------------------------------

/**
 * Read the entire session.jsonl into memory. Returns parsed entries plus a
 * count of malformed lines that were skipped.
 */
export async function readSession(path: string): Promise<SessionReadResult> {
	if (!existsSync(path)) {
		throw new Error(`session.jsonl not found: ${path}`);
	}
	const entries: SessionEntry[] = [];
	let line_count = 0;
	let error_count = 0;
	for await (const item of readSessionIter(path)) {
		if (item.kind === "entry") {
			entries.push(item.entry);
			line_count += 1;
		} else {
			error_count += 1;
			line_count = item.line_count;
		}
	}
	return { entries, error_count, line_count };
}

/** A single yield from the streaming reader. */
export type SessionIterItem =
	| { kind: "entry"; entry: SessionEntry; line_count: number; error_count: number }
	| { kind: "skip"; line_count: number; error_count: number };

/**
 * Streaming-friendly reader. Yields one item per JSONL line:
 *   - `kind: "entry"` for a parsed SessionEntry
 *   - `kind: "skip"` for a malformed line; `error_count` and `line_count` reflect totals at the time of skip
 *
 * Callers that only want the entries can `for await (const item of iter) { if (item.kind === "entry") … }`.
 * Callers that need totals can read the final `skip` item, or call `readSession` instead.
 */
export function readSessionIter(path: string): AsyncIterable<SessionIterItem> {
	if (!existsSync(path)) {
		throw new Error(`session.jsonl not found: ${path}`);
	}
	return iterateLines(path);
}

async function* iterateLines(path: string): AsyncGenerator<SessionIterItem> {
	const stream = createReadStream(path, { encoding: "utf-8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	let line_count = 0;
	let error_count = 0;
	try {
		for await (const raw of rl) {
			const line = raw.trim();
			if (line === "") continue;
			line_count += 1;
			try {
				const entry = parseLine(line);
				yield { kind: "entry", entry, line_count, error_count };
			} catch {
				error_count += 1;
				yield { kind: "skip", line_count, error_count };
			}
		}
	} finally {
		rl.close();
		stream.close();
	}
}

// ---------------------------------------------------------------------------
// Per-line parser
// ---------------------------------------------------------------------------

/** Parse one JSONL line. Throws on malformed JSON or unrecognized shape. */
function parseLine(line: string): SessionEntry {
	const data = JSON.parse(line) as Record<string, unknown>;
	if (!data || typeof data !== "object") {
		throw new Error("not an object");
	}
	const type = typeof data.type === "string" ? data.type : "";
	const timestamp = typeof data.timestamp === "string" ? data.timestamp : "";

	switch (type) {
		case "session":
		case "session_start":
			return {
				type: "session_start",
				timestamp,
				session_id: typeof data.id === "string" ? data.id : undefined,
				raw: data,
			};
		case "session_end":
			return {
				type: "session_end",
				timestamp,
				session_id: typeof data.id === "string" ? data.id : undefined,
				raw: data,
			};
		case "model_change":
			return {
				type: "model_change",
				timestamp,
				provider: typeof data.provider === "string" ? data.provider : undefined,
				model_id: typeof data.modelId === "string" ? data.modelId : undefined,
				raw: data,
			};
		case "thinking_level_change":
			return {
				type: "thinking_level_change",
				timestamp,
				raw: data,
			};
		case "message":
			return parseMessageEntry(data, timestamp);
		default:
			throw new Error(`unknown entry type: ${JSON.stringify(type)}`);
	}
}

function parseMessageEntry(
	data: Record<string, unknown>,
	timestamp: string,
): SessionEntry {
	// pi session format: nested `message` object
	const nested = data["message"];
	if (nested && typeof nested === "object") {
		return {
			type: "message",
			timestamp,
			message: parsePiMessage(nested as Record<string, unknown>),
			raw: data,
		};
	}
	// Legacy format: top-level `content` string
	if (typeof data["content"] === "string") {
		const content: ContentBlock = { type: "text", content: data["content"] };
		return {
			type: "message",
			timestamp,
			message: { role: "user", content: [content] },
			raw: data,
		};
	}
	// Fallback: message entry with no usable payload — keep the shape but flag null.
	return { type: "message", timestamp, message: null, raw: data };
}

/** Parse the inner `message` object of a pi-format entry. */
function parsePiMessage(data: Record<string, unknown>): Message {
	const roleRaw = data["role"];
	const role: Message["role"] =
		roleRaw === "assistant" || roleRaw === "system" ? roleRaw : "user";
	const blocks: ContentBlock[] = [];
	const rawContent = data["content"];
	if (Array.isArray(rawContent)) {
		for (const b of rawContent) {
			if (!b || typeof b !== "object") continue;
			const block = b as Record<string, unknown>;
			const blockType = block["type"];
			if (blockType === "text" && typeof block["text"] === "string") {
				blocks.push({ type: "text", content: block["text"] });
			} else if (blockType === "thinking" && typeof block["thinking"] === "string") {
				blocks.push({ type: "thinking", content: block["thinking"] });
			} else if (blockType === "toolCall" && typeof block["name"] === "string") {
				const args = block["arguments"];
				const arguments_ =
					args && typeof args === "object" && !Array.isArray(args)
						? (args as Record<string, unknown>)
						: undefined;
				blocks.push({
					type: "toolCall",
					name: block["name"] as string,
					arguments: arguments_,
				});
			} else if (blockType === "toolResult" && typeof block["name"] === "string") {
				blocks.push({
					type: "toolResult",
					name: block["name"] as string,
					content: block["content"],
					is_error: block["isError"] === true,
				});
			}
		}
	}
	let usage: Record<string, number> | undefined;
	const rawUsage = data["usage"];
	if (rawUsage && typeof rawUsage === "object") {
		const u = rawUsage as Record<string, unknown>;
		usage = {};
		for (const [k, v] of Object.entries(u)) {
			if (typeof v === "number") usage[k] = v;
		}
	}
	return { role, content: blocks, usage };
}