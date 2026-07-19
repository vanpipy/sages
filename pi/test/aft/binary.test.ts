/**
 * Tests for aft/binary.ts — AFT binary resolver.
 *
 * Acceptance:
 *   - Returns env var path if $AFT_BINARY set and exists
 *   - Returns npm-bundled path if it exists
 *   - Throws with structured error if none found
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAftBinary, __resetAftBinaryCache, AftBinaryNotFoundError } from "../../src/tools/aft/binary.js";

describe("aft/binary.ts", () => {
	let savedEnv: string | undefined;
	let tmpHome: string;

	beforeEach(() => {
		savedEnv = process.env.AFT_BINARY;
		__resetAftBinaryCache();
		tmpHome = mkdtempSync(join(tmpdir(), "aft-bin-test-"));
	});

	afterEachRestore: {
		// (declared below via restoreEnv)
	}

	function restoreEnv() {
		if (savedEnv === undefined) delete process.env.AFT_BINARY;
		else process.env.AFT_BINARY = savedEnv;
		rmSync(tmpHome, { recursive: true, force: true });
	}

	test("returns $AFT_BINARY path when set and exists", () => {
		const fake = join(tmpHome, "fake-aft");
		writeFileSync(fake, "#!/bin/sh\necho fake\n");
		chmodSync(fake, 0o755);
		process.env.AFT_BINARY = fake;

		try {
			expect(resolveAftBinary()).toBe(fake);
		} finally {
			restoreEnv();
		}
	});

	test("ignores $AFT_BINARY when path doesn't exist", () => {
		process.env.AFT_BINARY = join(tmpHome, "does-not-exist");

		try {
			// Should NOT return the nonexistent path — falls through to next check
			const result = resolveAftBinary();
			expect(result).not.toBe(process.env.AFT_BINARY);
		} catch (e) {
			// If nothing else found, we get an error — also acceptable
			expect((e as Error).name).toBe("AftBinaryNotFoundError");
		} finally {
			restoreEnv();
		}
	});

	test("throws AftBinaryNotFoundError when nothing is found", () => {
		delete process.env.AFT_BINARY;
		// Force the fallthrough by emptying the search list:
		// We can't actually empty ~/.
		// Instead, point HOME at a tmp dir with nothing in it.
		const oldHome = process.env.HOME;
		process.env.HOME = tmpHome;

		try {
			expect(() => resolveAftBinary()).toThrow(AftBinaryNotFoundError);
		} finally {
			process.env.HOME = oldHome;
			restoreEnv();
		}
	});

	test("error message mentions the remediation hint", () => {
		delete process.env.AFT_BINARY;
		const oldHome = process.env.HOME;
		process.env.HOME = tmpHome;

		try {
			let captured = "";
			try {
				resolveAftBinary();
			} catch (e) {
				captured = (e as Error).message;
			}
			expect(captured).not.toBe("");
			expect(captured).toContain("[AFT]");
			expect(captured).toContain("npx @cortexkit/aft@latest setup");
			expect(captured).toContain("$AFT_BINARY");
		} finally {
			process.env.HOME = oldHome;
			restoreEnv();
		}
	});
});
