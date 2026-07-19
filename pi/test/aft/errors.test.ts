/**
 * Tests for aft/errors.ts — AFT error mapping.
 */

import { describe, test, expect } from "bun:test";
import {
	aftErrorFromResponse,
	CallgraphBuildingError,
	FileNotFoundError,
	GenericAftError,
	InvalidRequestError,
	NotConfiguredError,
	ParseError,
	UnknownCommandError,
	retryHintFor,
} from "../../src/tools/aft/errors.js";

describe("aft/errors.ts", () => {
	test("callgraph_building → CallgraphBuildingError (retryable, 30s)", () => {
		const err = aftErrorFromResponse({
			id: "x",
			success: false,
			code: "callgraph_building",
			message: "still building",
		});
		expect((err as Error).name).toBe("CallgraphBuildingError");
		const hint = retryHintFor(err);
		expect(hint.retryable).toBe(true);
		expect(hint.retryAfterMs).toBe(30_000);
	});

	test("not_configured → NotConfiguredError (retryable, no wait)", () => {
		const err = aftErrorFromResponse({
			id: "x",
			success: false,
			code: "not_configured",
			message: "send configure first",
		});
		expect((err as Error).name).toBe("NotConfiguredError");
		expect(retryHintFor(err).retryable).toBe(true);
	});

	test("unknown_command → UnknownCommandError (not retryable)", () => {
		const err = aftErrorFromResponse({
			id: "x",
			success: false,
			code: "unknown_command",
			message: "no such command",
		});
		expect((err as Error).name).toBe("UnknownCommandError");
		expect(retryHintFor(err).retryable).toBe(false);
	});

	test("invalid_request → InvalidRequestError", () => {
		const err = aftErrorFromResponse({
			id: "x",
			success: false,
			code: "invalid_request",
			message: "missing param",
		});
		expect((err as Error).name).toBe("InvalidRequestError");
	});

	test("file_not_found → FileNotFoundError", () => {
		const err = aftErrorFromResponse({
			id: "x",
			success: false,
			code: "file_not_found",
			message: "X not found",
		});
		expect((err as Error).name).toBe("FileNotFoundError");
	});

	test("parse_error → ParseError", () => {
		const err = aftErrorFromResponse({
			id: "x",
			success: false,
			code: "parse_error",
			message: "bad json",
		});
		expect((err as Error).name).toBe("ParseError");
	});

	test("unknown code → GenericAftError (preserves code)", () => {
		const err = aftErrorFromResponse({
			id: "x",
			success: false,
			code: "weird_code",
			message: "something",
		});
		expect((err as Error).name).toBe("GenericAftError");
		expect(err.code).toBe("weird_code");
	});

	test("all error messages prefixed with [AFT]", () => {
		const err = aftErrorFromResponse({
			id: "x",
			success: false,
			code: "not_configured",
			message: "send configure",
		});
		expect(err.message).toContain("[AFT]");
	});
});
