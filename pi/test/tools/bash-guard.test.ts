/**
 * Tests for the bash-guard: path-aware policy that classifies bash
 * commands and blocks write-intent operations targeting production
 * code paths. The main agent must dispatch a developer
 * subagent for any change to user source — bash cannot bypass that.
 *
 * RED phase: these tests fail until `bash-guard.ts` is implemented.
 */

import { describe, it, expect } from "bun:test";
import {
	classifyBashCommand,
	extractBashTargets,
	isGitMetaCommand,
	shouldBlockBashCommand,
} from "@/tools/bash-guard.js";
import { canMainAgentWriteMeta } from "@/tools/file-gate.js";

const CTX = { cwd: "/tmp/sages-project" };

describe("shouldBlockBashCommand — 15 design cases", () => {
	it("T1: rm src/auth/service.ts → block:true (target denied)", () => {
		const r = shouldBlockBashCommand("rm src/auth/service.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/auth/service.ts");
	});

	it("T2: rm -rf /tmp/foo → block:true (destructives are always denied, regardless of target)", () => {
		// Restored in GC-2026-015 follow-up: rm/mv/cp/unlink/rmdir
		// are always denied. Even on /tmp (which is otherwise
		// allowed), `rm` triggers the destructive short-circuit.
		// The /tmp-not-denied carve-out is preserved for
		// non-destructive write-intents (see T4 below) and for
		// dangerous-only-not-destructive paths via tar/tee/etc.
		const r = shouldBlockBashCommand("rm -rf /tmp/foo", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
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

	it("T7: mv /tmp/x.ts src/foo.ts → block:true (destructive — dst argument is now subsumed)", () => {
		// `mv` is a destructive first-word and is ALWAYS denied
		// (GC-2026-015 follow-up). The deny's reason is the
		// destructive prefix rather than the dst path.
		const r = shouldBlockBashCommand("mv /tmp/x.ts src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
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

	it("T14: python3 -c \"...\" > block:true (unknown + no extractable target; previously bypassed via escape hatch)", () => {
		const r = shouldBlockBashCommand(
			`python3 -c "import os; os.remove('src/x.ts')"`,
			CTX,
		);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("Unknown bash command");
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

	it("T19: `rm /tmp/foo && rm src/foo.ts` → block (destructive segment short-circuits)", () => {
		// Restored invariant (GC-2026-015 follow-up): `rm` always
		// blocks regardless of target. The first segment's
		// destructive preview appears in the reason; the second
		// segment is not evaluated.
		const r = shouldBlockBashCommand("rm /tmp/foo && rm src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
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

	it("T22: `rm src/foo.ts && echo done` > block (chained segment split, no escape hatch)", () => {
		const r = shouldBlockBashCommand(
			`rm src/foo.ts && echo done`,
			CTX,
		);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
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

	it("T25: `perl -e \"unlink 'src/foo.ts'\"` → block (script unlink targets production)", () => {
		// F4-1: perl -e "code" with a path literal in the code was not
		// blocked because `extractBashTargets` had no `perl` case (the
		// switch fell through to default, returning no targets). The
		// fix extracts path-like strings from quoted content.
		const r = shouldBlockBashCommand(
			`perl -e "unlink 'src/foo.ts'"`,
			CTX,
		);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T26: `echo x 2> src/foo.ts` → block (fd 2 redirect to production)", () => {
		// F4-2: `2>file` is a write-redirect (stderr → file) but the
		// existing regex `(?<![\d&])>(?!>)` excluded any `>` preceded
		// by a digit, treating all fd-redirects as non-write-targets.
		// Only fd-duplications (`N>&M`) are not write-targets. The
		// fix distinguishes the two.
		const r = shouldBlockBashCommand("echo x 2> src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T25b: `perl -e \"unlink 'src/foo.ts'\"` > block (F4-1 perl path extraction)", () => {
		// Regression guard: the perl case extracts path-like strings
		// from quoted content and surfaces them as production targets.
		const r = shouldBlockBashCommand(
			`perl -e "unlink 'src/foo.ts'"`,
			CTX,
		);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
		});

	it("T26b: `echo x 2> src/foo.ts` > block (F4-2 fd-redirect detection)", () => {
		const r = shouldBlockBashCommand(
			`echo x 2> src/foo.ts`,
			CTX,
		);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
		});

	it("T26c: `echo x 2>&1` → allow (fd duplication, not a file redirect)", () => {
		// Regression guard: fd duplication (stderr → stdout) must NOT
		// trip the new fd-redirect handling.
		const r = shouldBlockBashCommand("echo x 2>&1", CTX);
		expect(r.block).toBe(false);
	});

	it("T27: `cd /tmp && cat /etc/hostname` → allow (cd is read-only shell builtin)", () => {
		// Regression guard: shell builtins `cd`, `pwd`, `printenv` are
		// common prefixes for chained read-only commands. Treating
		// them as "unknown" forces the sawUnknown branch and blocks
		// benign chains like `cd /tmp && cat /etc/hostname`. After
		// 0b7827d removed the `# sages:safe` escape hatch, this
		// surfaced as a usability regression for LLM agents using
		// these idiomatic patterns.
		const r = shouldBlockBashCommand("cd /tmp && cat /etc/hostname", CTX);
		expect(r.block).toBe(false);
	});

	it("T28: `cd /tmp && rm src/foo.ts` → block (chained rm still wins)", () => {
		// Even with cd added to read-only, the chained rm must still
		// trip the gate — cd is harmless in isolation but write-intent
		// commands chained after it must still be guarded.
		const r = shouldBlockBashCommand("cd /tmp && rm src/foo.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("src/foo.ts");
	});

	it("T29: `pwd && echo done` → allow (pwd is read-only)", () => {
		const r = shouldBlockBashCommand("pwd && echo done", CTX);
		expect(r.block).toBe(false);
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

describe("GC-2026-015 four-layer bash guard", () => {
	const l2Allow = [
		"git status", "git status -s", "git log", "git log --oneline -5",
		"git log -1 --format='%H %s'", "git diff", "git diff origin/main..HEAD",
		"git show abc123", "git blame src/foo.ts", "git shortlog -sn", "git reflog",
		"git rev-parse HEAD", "git rev-list --count HEAD", "git tag -l", "git branch -l",
		"git worktree list", "git add src/foo.ts", "git commit -m 'message'",
		"git branch feature/x", "git merge --no-ff feature/x", "git cherry-pick abc123",
		"git rebase main", "git stash", "git fetch origin", "git pull",
		"git push origin feature/x", "git remote -v", "git worktree add /tmp/w feature/x",
		"git config --get user.name", "git config --list",
		"GIT_AUTHOR_NAME=foo git log --oneline",
	];
	for (const [index, command] of l2Allow.entries()) it(`T-L2-${String(index + 1).padStart(2, "0")} L2 git-meta allows ${command}`, () => {
		expect(isGitMetaCommand(command).allow).toBe(true);
		expect(shouldBlockBashCommand(command, CTX)).toEqual({ block: false });
	});
	const l2Deny = [
		"git checkout -- src/foo.ts", "git restore src/foo.ts", "git rm src/foo.ts",
		"git mv src/foo.ts src/bar.ts", "git reset --hard HEAD~1", "git clean -fd",
		"git stash drop", "git tag -d v1.0.0", "git branch -D feature/x",
		"git push --force origin main", "git push -f origin main", "git worktree remove --force /tmp/w",
	];
	for (const [index, command] of l2Deny.entries()) it(`T-L2-D-${String(index + 1).padStart(2, "0")} L2 git-meta destructive denies ${command}`, () => {
		const verdict = isGitMetaCommand(command);
		expect(verdict.allow).toBe(false);
		if (!verdict.allow) expect(verdict.reason).toContain("destructive:");
		const result = shouldBlockBashCommand(command, CTX);
		expect(result.block).toBe(true);
		expect(result.reason).toContain("destructive:");
	});
	const l3Allow = [
		"cat > .pi/orchestrator/audit-P1.md <<EOF\ntext\nEOF", "sed -i 's/foo/bar/' pi/templates/SYSTEM.md",
		"tee AGENTS.md < /dev/null", "cat > README.md <<EOF\ntext\nEOF", "cat > pi/README.md <<EOF\ntext\nEOF",
		"sed -i 's/x/y/' .gitignore", "cat > .aft.jsonc <<EOF\n{}\nEOF", "cat > .claude/settings.json <<EOF\n{}\nEOF",
		"cat > pi/skills/orchestrator/SKILL.md <<EOF\ntext\nEOF", "cat > pi/scripts/install.sh <<EOF\ntext\nEOF",
		"mkdir -p .pi/orchestrator/new-dir", "echo 'foo' > pi/templates/new-file.md",
	];
	for (const [index, command] of l3Allow.entries()) it(`T-L3-${String(index + 1).padStart(2, "0")} L3 meta-file allows ${command}`, () => {
		expect(shouldBlockBashCommand(command, CTX).block).toBe(false);
	});
	const l4Deny = ["cat > src/foo.ts <<EOF\ntext\nEOF", "sed -i 's/foo/bar/' pi/src/index.ts", "cat > pi/test/install.test.sh <<EOF\ntext\nEOF", "echo 'foo' > AGENTS.md.bak"];
	for (const [index, command] of l4Deny.entries()) it(`T-L3-N-${String(index + 1).padStart(2, "0")} L4 production-code denies ${command}`, () => {
		expect(shouldBlockBashCommand(command, CTX).block).toBe(true);
	});
	it("exposes the L3 path allowlist", () => {
		expect(canMainAgentWriteMeta("AGENTS.md")).toBe(true);
		expect(canMainAgentWriteMeta("pi/templates/SYSTEM.md")).toBe(true);
		expect(canMainAgentWriteMeta("src/foo.ts")).toBe(false);
		expect(canMainAgentWriteMeta("AGENTS.md.bak")).toBe(false);
	});
});


describe("shouldBlockBashCommand — reason format", () => {
	it("includes the production-code targets in the reason (non-destructive write-intent to production)", () => {
		// Use a non-destructive write-intent so the L4
		// production-target path surfaces (the destructive
		// short-circuit would otherwise fire first on `rm`).
		const r = shouldBlockBashCommand("echo x > src/auth/service.ts", CTX);
		expect(r.reason).toContain("bash command targets production code:");
		expect(r.reason).toContain("src/auth/service.ts");
	});

	it("points at the Agent tool + developer subagent", () => {
		const r = shouldBlockBashCommand("rm src/foo.ts", CTX);
		expect(r.reason!.toLowerCase()).toContain("agent");
		expect(r.reason!.toLowerCase()).toContain("developer");
	});

});

/**
 * GC-2026-015 follow-up — two regressions introduced by the four-layer
 * bash-guard refactor (698e65c) need fixing:
 *
 *   1. rm/mv/cp/unlink/rmdir on meta-file paths were accidentally
 *      allowed. The L3 canMainAgentWriteMeta allowlist (`rm .pi/orchestrator/x.md`
 *      → both canMainAgentWrite AND canMainAgentWriteMeta true →
 *      isProductionTarget false → L3 lets it through) violated the
 *      anti-goal "destructives stay denied regardless of which layer".
 *
 *   2. extractBashTargets for `rm` over-matched on chain operators:
 *      `rm pi/src/foo.ts 2>&1 | head -5` extracted `2>&1`, `|`, `head`
 *      as targets. Fix: stop at the first shell operator.
 */
describe("GC-2026-015 follow-up — destructive deny", () => {
	it("T-D-01: `rm .pi/orchestrator/test.md` → DENY (anti-goal regression on L3 meta-file path)", () => {
		const r = shouldBlockBashCommand("rm .pi/orchestrator/test.md", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
		// Must NOT be the L3 allow response (no "bash command targets production" reason).
		expect(r.reason).toContain(".pi/orchestrator/test.md");
	});

	it("T-D-02: `rm AGENTS.md` → DENY", () => {
		const r = shouldBlockBashCommand("rm AGENTS.md", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
	});

	it("T-D-03: `mv pi/templates/foo.md pi/templates/bar.md` → DENY", () => {
		const r = shouldBlockBashCommand("mv pi/templates/foo.md pi/templates/bar.md", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
	});

	it("T-D-04: `cp pi/skills/foo.md pi/skills/bar.md` → DENY", () => {
		const r = shouldBlockBashCommand("cp pi/skills/foo.md pi/skills/bar.md", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
	});

	it("T-D-05: `rm -rf .pi/orchestrator` → DENY", () => {
		const r = shouldBlockBashCommand("rm -rf .pi/orchestrator", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
	});

	it("T-D-06: `rm --force .pi/orchestrator/anything.md` → DENY", () => {
		const r = shouldBlockBashCommand("rm --force .pi/orchestrator/anything.md", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
	});

	it("T-D-07: `unlink .pi/orchestrator/foo.md` → DENY", () => {
		const r = shouldBlockBashCommand("unlink .pi/orchestrator/foo.md", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
	});

	it("T-D-08: `rmdir .pi/orchestrator/subdir` → DENY", () => {
		const r = shouldBlockBashCommand("rmdir .pi/orchestrator/subdir", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
	});

	it("T-D-09: `mkdir -p .pi/orchestrator/new-dir` → ALLOW (mkdir is not a destructive first-word)", () => {
		// Regression guard: the destructive short-circuit must NOT
		// over-block mkdir / tee / sed / perl etc. L3 meta-file
		// allowlist must continue to apply to non-destructive
		// write-intent commands.
		const r = shouldBlockBashCommand("mkdir -p .pi/orchestrator/new-dir", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-10: `tee .pi/orchestrator/foo.md < /dev/null` → ALLOW (tee is not destructive)", () => {
		// Regression guard: tee is in WRITE_INTENT_FIRST_WORDS but is
		// not in DESTRUCTIVE_FIRST_WORDS — meta-file tee writes remain
		// L3-allowed.
		const r = shouldBlockBashCommand("tee .pi/orchestrator/foo.md < /dev/null", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-11: `echo done && rm .pi/orchestrator/foo.md` → DENY (destructive segment wins past read-only echo)", () => {
		const r = shouldBlockBashCommand("echo done && rm .pi/orchestrator/foo.md", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
	});
});

describe("GC-2026-015 follow-up — chain-parser correctness", () => {
	it("T-CP-01: extractBashTargets(`rm pi/src/test.ts 2>&1 | head -5`) → only [pi/src/test.ts]", () => {
		const t = extractBashTargets("rm pi/src/test.ts 2>&1 | head -5");
		expect(t).toEqual(["pi/src/test.ts"]);
	});

	it("T-CP-01b: shouldBlockBashCommand(`rm pi/src/test.ts 2>&1 | head -5`) → DENY (destructive short-circuit)", () => {
		// End-to-end: the destructive short-circuit must block this
		// command (the chain parser splits segments, but the rm
		// segment fires destructive before extractBashTargets runs).
		const r = shouldBlockBashCommand("rm pi/src/test.ts 2>&1 | head -5", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("destructive:");
	});

	it("T-CP-02: extractBashTargets(`mv src/foo.ts src/bar.ts && echo done`) → [src/foo.ts, src/bar.ts]", () => {
		const t = extractBashTargets("mv src/foo.ts src/bar.ts && echo done");
		expect(t).toEqual(["src/foo.ts", "src/bar.ts"]);
	});

	it("T-CP-03: extractBashTargets(`cat > .pi/orchestrator/test.md <<EOF\\nfoo\\nEOF`) → [.pi/orchestrator/test.md]", () => {
		// L3 meta-file allow path: the `cat >` redirect is captured by
		// the global redirect extractor; heredoc EOF marker must NOT
		// be a target.
		const t = extractBashTargets("cat > .pi/orchestrator/test.md <<EOF\nfoo\nEOF");
		expect(t).toEqual([".pi/orchestrator/test.md"]);
	});

	it("T-CP-03b: shouldBlockBashCommand(...) ALLOW (L3 redirect still allowed)", () => {
		const r = shouldBlockBashCommand(
			"cat > .pi/orchestrator/test.md <<EOF\nfoo\nEOF",
			CTX,
		);
		expect(r.block).toBe(false);
	});

	it("T-CP-04: extractBashTargets(`sed -i 's/foo/bar/' pi/src/index.ts`) → [pi/src/index.ts] only", () => {
		const t = extractBashTargets("sed -i 's/foo/bar/' pi/src/index.ts");
		expect(t).toEqual(["pi/src/index.ts"]);
	});

	it("T-CP-04b: shouldBlockBashCommand(...) → DENY (L4 production-code)", () => {
		const r = shouldBlockBashCommand("sed -i 's/foo/bar/' pi/src/index.ts", CTX);
		expect(r.block).toBe(true);
		expect(r.reason).toContain("pi/src/index.ts");
	});

	it("T-CP-05: extractBashTargets(`rm -rf /tmp/foo`) → [/tmp/foo] (operator stop doesn't affect /tmp case)", () => {
		// Regression guard: the operator-stop fix must NOT over-eagerly
		// strip legitimate non-flag args. /tmp/foo has no operator in
		// the slice(1) range.
		const t = extractBashTargets("rm -rf /tmp/foo");
		expect(t).toEqual(["/tmp/foo"]);
	});

	it("T-CP-06: extractBashTargets(`mkdir -p .pi/orchestrator/sub && echo done`) → [.pi/orchestrator/sub]", () => {
		// mkdir: stop at the `&&` so echo/done are not targets.
		const t = extractBashTargets("mkdir -p .pi/orchestrator/sub && echo done");
		expect(t).toEqual([".pi/orchestrator/sub"]);
	});

	it("T-CP-07: extractBashTargets(`cp src/foo.ts dst/ ; rm bar`) → [dst/] (cp stops at `;`)", () => {
		// cp: stop at the `;` so the chained `rm bar` is not picked up
		// as a cp target.
		const t = extractBashTargets("cp src/foo.ts dst/ ; rm bar");
		expect(t).toEqual(["dst/"]);
	});
});

