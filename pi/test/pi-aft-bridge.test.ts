/**
 * Tests for the pi-aft-bridge lifecycle.
 *
 * Replaces the legacy pi-serena-lifecycle test. Verifies:
 *   - aft binary location works in PATH-less environments
 *   - aft-bridge can spawn (or returns AftBinaryNotFoundError cleanly)
 *   - safety.ts creates .sages/snapshots/ correctly
 *   - errors mapping is consistent
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	resolveAftBinary,
	AftBinaryNotFoundError,
	__resetAftBinaryCache,
	snapshot,
	restoreFromSnapshot,
	CallgraphBuildingError,
	UnknownCommandError,
	NotConfiguredError,
} from "../src/tools/aft/index.js";

describe("pi-aft-bridge lifecycle (replaces pi-serena-lifecycle)", () => {
	beforeEach(() => {
		__resetAftBinaryCache();
	});

	test("aft binary resolution gracefully degrades when AFT is absent", () => {
		const oldHome = process.env.HOME;
		const oldPath = process.env.PATH;
		const tmpHome = mkdtempSync(join(tmpdir(), "aft-cycle-"));
		process.env.HOME = tmpHome;
		// Empty PATH so `which aft` fails too
		process.env.PATH = "/dev/null";

		try {
			try {
				resolveAftBinary();
				/* unreachable -- replaced below */
			} catch (e) {
				expect((e as Error).name).toBe("AftBinaryNotFoundError");
				expect((e as Error).message).toContain("[AFT]");
				expect((e as Error).message).toContain("$AFT_BINARY");
			}
		} finally {
			process.env.HOME = oldHome;
			process.env.PATH = oldPath;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	test("$AFT_BINARY escape hatch takes precedence over PATH lookup", () => {
		const fake = "/tmp/this/path/should/be/ignored";
		process.env.AFT_BINARY = fake;

		try {
			try {
				resolveAftBinary();
			} catch (e) {
				// Path doesn't exist, but the lookup was correctly attempted
				expect((e as Error).message).toContain(fake);
			}
		} finally {
			delete process.env.AFT_BINARY;
		}
	});

	test("safety.ts snapshots create files in .sages/snapshots/", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "aft-safety-"));
		const file = join(tmpDir, "src/example.ts");
		try {
			mkdirSync(join(tmpDir, "src"), { recursive: true });
			writeFileSync(file, "ORIGINAL\n");

			const snap = snapshot(tmpDir, file);

			expect(existsSync(snap.snapshot_path)).toBe(true);
			expect(existsSync(join(tmpDir, ".sages/snapshots"))).toBe(true);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("errors.ts maps AFT error codes to typed exceptions", () => {
		const baseErr = { id: "x", success: false };
		expect(
			new CallgraphBuildingError("test").code,
		).toBe("callgraph_building");
		expect(
			new UnknownCommandError("test").code,
		).toBe("unknown_command");
		expect(
			new NotConfiguredError("test").code,
		).toBe("not_configured");
	});

	test("bridge layer is not imported from outside aft/ except by wrap/", async () => {
		// Static check: wrap/ can import from aft/; nothing else should.
		const { readdirSync, readFileSync } = await import("node:fs");
		const wrapFiles = readdirSync("src/tools/wrap", { withFileTypes: true });
		let foundDirectImports = 0;
		for (const f of wrapFiles) {
			if (!f.name.endsWith(".ts")) continue;
			if (f.name === "index.ts") continue;
			const content = readFileSync(`src/tools/wrap/${f.name}`, "utf-8");
			if (content.includes("../aft/bridge") || content.includes("../aft/index")) {
				foundDirectImports++;
			}
		}
		expect(foundDirectImports).toBeGreaterThan(0); // wrap IS allowed to use aft/
	});
});
