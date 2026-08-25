/**
 * Tests for the bash-guard classifier used by the soft-mode auto-steer
 * reminder. In soft mode (GC-2026-031) the bash tool_call handler in
 * `extension.ts` calls `classifyBashCommand` on every invocation and
 * fires `softModeReminder(profile)` once when the first write-intent
 * command is detected. The historical four-layer gate, target
 * extraction, and chained-command splitter were removed (they had no
 * production caller after soft mode dropped blocking) — covered by
 * the cleanup pass that also deleted `src/tools/file-gate.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
	classifyBashCommand,
	_clearClassifyCache,
	_getClassifyCacheSize,
} from "@/bash-guard.js";

describe("classifyBashCommand — read-only fast paths", () => {
	beforeEach(() => _clearClassifyCache());

	it("classifies read-only first-word commands", () => {
		expect(classifyBashCommand("ls -la")).toBe("read-only");
		expect(classifyBashCommand("cat foo.ts")).toBe("read-only");
		expect(classifyBashCommand("grep -r pattern src/")).toBe("read-only");
		expect(classifyBashCommand("echo hello")).toBe("read-only");
	});

	it("classifies read-only test runner prefixes", () => {
		expect(classifyBashCommand("npm test")).toBe("read-only");
		expect(classifyBashCommand("npm lint")).toBe("read-only");
		expect(classifyBashCommand("npm typecheck")).toBe("read-only");
		expect(classifyBashCommand("bun test")).toBe("read-only");
		expect(classifyBashCommand("pytest tests/")).toBe("read-only");
		expect(classifyBashCommand("cargo test")).toBe("read-only");
		expect(classifyBashCommand("make build")).toBe("read-only");
	});

	it("classifies read-only git subcommands", () => {
		expect(classifyBashCommand("git status")).toBe("read-only");
		expect(classifyBashCommand("git log --oneline")).toBe("read-only");
		expect(classifyBashCommand("git diff HEAD")).toBe("read-only");
		expect(classifyBashCommand("git branch")).toBe("read-only");
		expect(classifyBashCommand("git worktree list")).toBe("read-only");
	});
});

describe("classifyBashCommand — write-intent fast paths", () => {
	beforeEach(() => _clearClassifyCache());

	it("classifies write-intent first-word commands", () => {
		expect(classifyBashCommand("rm foo.ts")).toBe("write-intent");
		expect(classifyBashCommand("mv a b")).toBe("write-intent");
		expect(classifyBashCommand("cp src dst")).toBe("write-intent");
		expect(classifyBashCommand("sed -i 's/a/b/' x.ts")).toBe("write-intent");
		expect(classifyBashCommand("perl -pi -e 's/a/b/' x.ts")).toBe("write-intent");
		expect(classifyBashCommand("tee out.txt")).toBe("write-intent");
		expect(classifyBashCommand("chmod 644 file")).toBe("write-intent");
		expect(classifyBashCommand("tar -xzf a.tar.gz")).toBe("write-intent");
		expect(classifyBashCommand("unzip a.zip")).toBe("write-intent");
	});

	it("classifies write-intent via redirect", () => {
		expect(classifyBashCommand("echo x > out.ts")).toBe("write-intent");
		expect(classifyBashCommand("ls > listing.txt")).toBe("write-intent");
	});

	it("classifies find -delete / -exec as write-intent", () => {
		expect(classifyBashCommand('find . -name "*.bak" -delete')).toBe("write-intent");
		expect(classifyBashCommand('find . -name "*.tmp" -exec rm {} +')).toBe("write-intent");
	});
});

describe("classifyBashCommand — git-meta + unknown", () => {
	beforeEach(() => _clearClassifyCache());

	it("classifies git-meta subcommands", () => {
		expect(classifyBashCommand("git checkout main")).toBe("git-meta");
		expect(classifyBashCommand("git add src/foo.ts")).toBe("git-meta");
		expect(classifyBashCommand("git commit -m 'message'")).toBe("git-meta");
		expect(classifyBashCommand("git push origin feature/x")).toBe("git-meta");
	});

	it("classifies unknown commands", () => {
		expect(classifyBashCommand('python3 -c "print(1)"')).toBe("unknown");
		expect(classifyBashCommand('ruby -e "puts 1"')).toBe("unknown");
		expect(classifyBashCommand('bash -c "echo hi"')).toBe("unknown");
		expect(classifyBashCommand("git checkout -- src/foo.ts")).toBe("unknown");
	});
});

describe("classifyBashCommand — LRU memoization", () => {
	beforeEach(() => _clearClassifyCache());

	it("grows on first call, stays the same on a cache hit", () => {
		expect(_getClassifyCacheSize()).toBe(0);
		classifyBashCommand("git status");
		expect(_getClassifyCacheSize()).toBe(1);
		classifyBashCommand("git status");
		expect(_getClassifyCacheSize()).toBe(1);
	});

	it("distinct commands occupy distinct cache slots", () => {
		classifyBashCommand("git status");
		classifyBashCommand("ls -la");
		expect(_getClassifyCacheSize()).toBe(2);
	});

	it("evicts the oldest entry when the cache exceeds the cap", () => {
		// The cap is 256; insert 257 distinct keys and confirm the
		// first is evicted.
		for (let i = 0; i < 257; i++) {
			classifyBashCommand(`echo marker_${i}`);
		}
		expect(_getClassifyCacheSize()).toBe(256);
		// Re-calling marker_0 — it was evicted, so this is a miss
		// that briefly holds 257 entries and immediately evicts the
		// next-oldest. The cap stays at 256.
		classifyBashCommand("echo marker_0");
		expect(_getClassifyCacheSize()).toBe(256);
	});

	it("_clearClassifyCache resets the cache", () => {
		classifyBashCommand("git status");
		classifyBashCommand("ls -la");
		expect(_getClassifyCacheSize()).toBe(2);
		_clearClassifyCache();
		expect(_getClassifyCacheSize()).toBe(0);
	});
});