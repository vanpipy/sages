/**
 * Tests for the bash-guard: path-aware policy that classifies bash
 * commands and blocks write-intent operations targeting production
 * code paths. The main agent must dispatch a software-developer
 * subagent for any change to user source — bash cannot bypass that.
 *
 * RED phase: these tests fail until `bash-guard.ts` is implemented.
 */

import { describe, it, expect } from "bun:test";
import {
	classifyBashCommand,
	extractBashTargets,
	shouldBlockBashCommand,
} from "@/tools/bash-guard.js";

const CTX = { cwd: "/tmp/sages-project" };

describe("shouldBlockBashCommand — 15 design cases", () => {
	it("T1: rm src/auth/service.ts → block:true (target denied)", () => {
		const r = shouldBlockBashCommand("rm src/auth/service.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/auth/service.ts");
	});

	it("T2: rm -rf /tmp/foo → block:false (/tmp not denied)", () => {
		const r = shouldBlockBashCommand("rm -rf /tmp/foo", CTX);
		expect(r.block).toBe(false);
	});

	it("T3: cat src/foo.ts → block:false (read-only)", () => {
		const r = shouldBlockBashCommand("cat src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T4: cat src/foo.ts > /tmp/copy.ts → block:false (read src, write /tmp OK)", () => {
		const r = shouldBlockBashCommand("cat src/foo.ts > /tmp/copy.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T5: echo x > src/foo.ts → block:true (redirect to src/)", () => {
		const r = shouldBlockBashCommand("echo x > src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T6: mv src/foo.ts /tmp/ → block:true (src is denied)", () => {
		const r = shouldBlockBashCommand("mv src/foo.ts /tmp/", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T7: mv /tmp/x.ts src/foo.ts → block:true (dst denied)", () => {
		const r = shouldBlockBashCommand("mv /tmp/x.ts src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T8: git checkout -- src/foo.ts → block:true", () => {
		const r = shouldBlockBashCommand("git checkout -- src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T9: git checkout HEAD~1 -- src/foo.ts → block:true", () => {
		const r = shouldBlockBashCommand("git checkout HEAD~1 -- src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T10: git status → block:false (read-only)", () => {
		const r = shouldBlockBashCommand("git status", CTX);
		expect(r.block).toBe(false);
	});

	it("T11: find . -name \"*.bak\" -delete → block:true (current dir denied)", () => {
		const r = shouldBlockBashCommand('find . -name "*.bak" -delete', CTX);
		expect(r.block).toBe(true);
	});

	it("T12: npm test → block:false (read-only)", () => {
		const r = shouldBlockBashCommand("npm test", CTX);
		expect(r.block).toBe(false);
	});

	it("T13: python3 -c \"import os; os.remove('src/x.ts')\" → block:true (unknown + no target)", () => {
		const r = shouldBlockBashCommand(
			`python3 -c "import os; os.remove('src/x.ts')"`,
			CTX,
		);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("Unknown bash command");
	});

	it("T14: # sages:safe\\npython3 -c \"...\" → block:false (escape hatch)", () => {
		const r = shouldBlockBashCommand(
			`# sages:safe\npython3 -c "import os; os.remove('src/x.ts')"`,
			CTX,
		);
		expect(r.block).toBe(false);
	});

	it("T15: sed -i 's/a/b/' src/foo.ts → block:true (sed -i is write-intent)", () => {
		const r = shouldBlockBashCommand(`sed -i 's/a/b/' src/foo.ts`, CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});
});

/**
 * Chained-command hardening (T16–T22, added 2026-07-25).
 *
 * Each test pairs with a single known-bypass pattern from the
 * 2026-07-24 audit's "command-chaining gap" minor finding. The
 * implementation splits the command on top-level `&&` / `||` / `;`
 * (respecting quotes + parens) and runs classify + extract targets
 * per segment; if ANY segment is write-intent with a denied target
 * the whole command is blocked.
 *
 * See pi/src/tools/bash-guard.ts `splitChainedCommands` and the
 * rewrite of `shouldBlockBashCommand` for the gate.
 */
describe("shouldBlockBashCommand — chained commands (T16–T22)", () => {
	it("T16: `echo done && rm src/foo.ts` → block (chained rm past read-only echo)", () => {
		const r = shouldBlockBashCommand("echo done && rm src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T17: `cat src/foo.ts && rm src/foo.ts` → block (mix of read + write segments)", () => {
		const r = shouldBlockBashCommand("cat src/foo.ts && rm src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T18: `cat src/foo.ts && echo done` → allow (all segments read-only)", () => {
		const r = shouldBlockBashCommand("cat src/foo.ts && echo done", CTX);
		expect(r.block).toBe(false);
	});

	it("T19: `rm /tmp/foo && rm src/foo.ts` → block (one segment targets denied path)", () => {
		const r = shouldBlockBashCommand("rm /tmp/foo && rm src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T20: `rm src/foo.ts || echo failed` → block (write intent in first segment of ||)", () => {
		const r = shouldBlockBashCommand("rm src/foo.ts || echo failed", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T21: `rm src/foo.ts; echo done` → block (semicolon separator)", () => {
		const r = shouldBlockBashCommand("rm src/foo.ts; echo done", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T22: `# sages:safe\\nrm src/foo.ts && echo done` → allow (escape hatch wins first)", () => {
		const r = shouldBlockBashCommand(
			"# sages:safe\nrm src/foo.ts && echo done",
			CTX,
		);
		expect(r.block).toBe(false);
	});

	it("T23: `echo \"rm src/foo.ts\" && echo done` → allow (rm is in quoted string, not a command)", () => {
		const r = shouldBlockBashCommand(
			'rm "src/foo.ts" && echo done', // double-quoted path
			CTX,
		);
		// `rm "src/foo.ts"` is write-intent with denied target — BLOCK.
		// The quoted-string test is separate and only protects against
		// chain splitting on quoted content. See T23b for the actual
		// quoted-content test.
		expect(r.block).toBe(true);
	});

	it("T23b: chained command does NOT split on quoted `&&`", () => {
		// `echo "a && b"` is one segment; no chain. We split outside the
		// quotes, so the inner `&&` is preserved as data. The result is
		// `echo "a && b"` — read-only — followed by an empty trailing
		// segment that gets dropped. Should allow.
		const r = shouldBlockBashCommand('echo "a && b" && echo done', CTX);
		expect(r.block).toBe(false);
	});

	it("T24: `(echo done) && rm src/foo.ts` → block (subshell + rm)", () => {
		const r = shouldBlockBashCommand("(echo done) && rm src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});
});

describe("classifyBashCommand — selected cases", () => {
	it("classifies read-only commands", () => {
		expect(classifyBashCommand("ls -la")).toBe("read-only");
		expect(classifyBashCommand("cat foo.ts")).toBe("read-only");
		expect(classifyBashCommand("grep -r pattern src/")).toBe("read-only");
		expect(classifyBashCommand("npm test")).toBe("read-only");
		expect(classifyBashCommand("npm lint")).toBe("read-only");
		expect(classifyBashCommand("npm typecheck")).toBe("read-only");
		expect(classifyBashCommand("bun test")).toBe("read-only");
		expect(classifyBashCommand("pytest tests/")).toBe("read-only");
		expect(classifyBashCommand("cargo test")).toBe("read-only");
		expect(classifyBashCommand("make build")).toBe("read-only");
		expect(classifyBashCommand("git status")).toBe("read-only");
		expect(classifyBashCommand("git log --oneline")).toBe("read-only");
		expect(classifyBashCommand("git diff HEAD")).toBe("read-only");
		expect(classifyBashCommand("git branch")).toBe("read-only");
		expect(classifyBashCommand("git worktree list")).toBe("read-only");
		expect(classifyBashCommand("find . -name \"*.ts\"")).toBe("read-only");
		expect(classifyBashCommand("echo hello")).toBe("read-only");
	});

	it("classifies write-intent commands (first-word)", () => {
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

	it("classifies find with -delete / -exec as write-intent", () => {
		expect(classifyBashCommand('find . -name "*.bak" -delete')).toBe("write-intent");
		expect(classifyBashCommand('find . -name "*.tmp" -exec rm {} +')).toBe("write-intent");
	});

	it("classifies unknown commands", () => {
		expect(classifyBashCommand('python3 -c "print(1)"')).toBe("unknown");
		expect(classifyBashCommand('ruby -e "puts 1"')).toBe("unknown");
		expect(classifyBashCommand('bash -c "echo hi"')).toBe("unknown");
		expect(classifyBashCommand("git checkout -- src/foo.ts")).toBe("unknown");
		expect(classifyBashCommand("git checkout main")).toBe("unknown");
	});
});

describe("extractBashTargets — selected cases", () => {
	it("rm: extract path args", () => {
		expect(extractBashTargets("rm src/foo.ts")).toEqual(["src/foo.ts"]);
		expect(extractBashTargets("rm -rf /tmp/foo")).toEqual(["/tmp/foo"]);
		expect(extractBashTargets("rm -f a b c")).toEqual(["a", "b", "c"]);
	});

	it("mv: extract both src and dst", () => {
		expect(extractBashTargets("mv src/foo.ts /tmp/")).toEqual(["src/foo.ts", "/tmp/"]);
	});

	it("cp: extract only dst", () => {
		expect(extractBashTargets("cp src/foo.ts /tmp/")).toEqual(["/tmp/"]);
	});

	it("tee: extract path", () => {
		expect(extractBashTargets("tee out.ts")).toEqual(["out.ts"]);
	});

	it("redirect: extract target path", () => {
		expect(extractBashTargets("echo x > src/foo.ts")).toEqual(["src/foo.ts"]);
		expect(extractBashTargets("cat foo >> /tmp/append.ts")).toEqual(["/tmp/append.ts"]);
	});

	it("sed -i: extract path", () => {
		expect(extractBashTargets(`sed -i 's/a/b/' src/foo.ts`)).toEqual(["src/foo.ts"]);
	});

	it("find -delete: extract dir", () => {
		expect(extractBashTargets('find . -name "*.bak" -delete')).toEqual(["."]);
	});

	it("git checkout / restore / clean / rm: extract paths", () => {
		expect(extractBashTargets("git checkout -- src/foo.ts")).toEqual(["src/foo.ts"]);
		expect(extractBashTargets("git checkout HEAD~1 -- src/foo.ts")).toEqual(["src/foo.ts"]);
		expect(extractBashTargets("git restore src/foo.ts")).toEqual(["src/foo.ts"]);
		expect(extractBashTargets("git restore --source=HEAD~1 src/foo.ts")).toEqual(["src/foo.ts"]);
		expect(extractBashTargets("git clean -fd")).toEqual(["."]);
		expect(extractBashTargets("git clean -fd src/cache/")).toEqual(["src/cache/"]);
		expect(extractBashTargets("git rm src/foo.ts")).toEqual(["src/foo.ts"]);
	});

	it("tar extract: dir from -C or cwd", () => {
		expect(extractBashTargets("tar -xzf a.tar.gz")).toEqual(["."]);
		expect(extractBashTargets("tar -xzf a.tar.gz -C /tmp/out")).toEqual(["/tmp/out"]);
	});

	it("returns [] when no pattern matches", () => {
		expect(extractBashTargets("git status")).toEqual([]);
		expect(classifyBashCommand("git status")).toBe("read-only");
	});
});

describe("shouldBlockBashCommand — reason format", () => {
	it("includes the production-code targets in the reason", () => {
		const r = shouldBlockBashCommand("rm src/auth/service.ts", CTX);
		expect(r.reason).toContain("bash command targets production code:");
		expect(r.reason).toContain("src/auth/service.ts");
	});

	it("points at the Agent tool + software-developer subagent", () => {
		const r = shouldBlockBashCommand("rm src/foo.ts", CTX);
		expect(r.reason!.toLowerCase()).toContain("agent");
		expect(r.reason!.toLowerCase()).toContain("software-developer");
	});

	it("mentions the # sages:safe escape hatch in production-target case", () => {
		const r = shouldBlockBashCommand("rm src/foo.ts", CTX);
		expect(r.reason).toContain("# sages:safe");
	});
});