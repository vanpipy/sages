/**
 * AFT error mapping — translates AFT error codes to typed exceptions.
 *
 * Bridge.ts catches these and the wrap/* layer maps to sage-shaped responses.
 *
 * Per design .sages/designs/2026-07-19-aft-migration.md §Errors.
 */

import type { AftError, AftErrorCode } from "./types.js";

/** Marker base class — all AFT errors extend this. */
export abstract class AftErrorBase extends Error {
	abstract readonly code: AftErrorCode | string;
	constructor(message: string) {
		super(`[AFT] ${message}`);
		this.name = this.constructor.name;
	}
}

/** Thrown when AFT returns `callgraph_building` — recovery is "wait 30s and retry". */
export class CallgraphBuildingError extends AftErrorBase {
	readonly code = "callgraph_building" as const;
	constructor(message: string = "AFT callgraph is still building in the background") {
		super(message);
	}
}

/** Thrown when AFT has not been configured yet — recoverable by sending `configure` first. */
export class NotConfiguredError extends AftErrorBase {
	readonly code = "not_configured" as const;
}

/** Thrown when AFT doesn't know the command we sent — bug in our params. */
export class UnknownCommandError extends AftErrorBase {
	readonly code = "unknown_command" as const;
}

/** Thrown when params are wrong / incomplete. */
export class InvalidRequestError extends AftErrorBase {
	readonly code = "invalid_request" as const;
}

/** Thrown when the file doesn't exist. */
export class FileNotFoundError extends AftErrorBase {
	readonly code = "file_not_found" as const;
}

/** Thrown when AFT's NDJSON parser fails. */
export class ParseError extends AftErrorBase {
	readonly code = "parse_error" as const;
}

/** Catch-all for AFT errors we don't classify specifically. */
export class GenericAftError extends AftErrorBase {
	readonly code: string;
	constructor(originalCode: string, message: string) {
		super(`${originalCode}: ${message}`);
		this.code = originalCode;
	}
}

/** Map an AFT error response to the most specific typed exception. */
export function aftErrorFromResponse(err: AftError): AftErrorBase {
	switch (err.code) {
		case "callgraph_building":
			return new CallgraphBuildingError(err.message);
		case "not_configured":
			return new NotConfiguredError(err.message);
		case "unknown_command":
			return new UnknownCommandError(err.message);
		case "invalid_request":
			return new InvalidRequestError(err.message);
		case "file_not_found":
			return new FileNotFoundError(err.message);
		case "parse_error":
			return new ParseError(err.message);
		default:
			return new GenericAftError(err.code, err.message);
	}
}

/**
 * Marker interface — every AFT error has `retryable: boolean` so the bridge
 * can decide whether to retry automatically.
 */
export interface RetryHint {
	retryable: boolean;
	retryAfterMs?: number;
}

export function retryHintFor(err: AftErrorBase): RetryHint {
	if (err instanceof CallgraphBuildingError) return { retryable: true, retryAfterMs: 30_000 };
	if (err instanceof NotConfiguredError) return { retryable: true };
	return { retryable: false };
}
