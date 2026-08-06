/**
 * Tests for the bash-guard: path-aware classifier that classifies bash
 * commands. In soft mode (GC-2026-031) `shouldBlockBashCommand` is an
 * advisory classifier only — it returns `{ block: false }` for every
 * command. No bash write-intent is denied, including destructive
 * commands (`rm` / `mv` / `cp` / `unlink` / `rmdir`). The classifier
 * functions (`classifyBashCommand`, `extractBashTargets`,
 * `isGitMetaCommand`) remain useful for downstream consumers
 * (advisory metadata, audit reports) and are tested independently.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import {
	classifyBashCommand,
	extractBashTargets,
	isGitMetaCommand,
	shouldBlockBashCommand,
} from "@/tools/bash-guard.js";
import { canMainAgentWriteMeta } from "@/tools/file-gate.js";

const CTX = { cwd: "/tmp/sages-project" };

describe("shouldBlockBashCommand — soft mode (always { block: false })", () => {
	it("never blocks — fail-closed shell syntax is no longer enforced", () => {
		// Soft mode: no commands are blocked.
		const commands = [
			"cat README.md\necho bypass",
			"cat README.md | tee src/bypass.ts",
			"echo $(touch src/bypass.ts)",
			"echo `touch src/bypass.ts`",
			"env X=1 sed -i 's/a/b/' src/bypass.ts",
			"find . -name '*.ts' -exec touch {} +",
		];
		for (const command of commands) {
			expect(shouldBlockBashCommand(command, CTX)).toEqual({ block: false });
		}
	});

	it("does NOT block write-intent commands with no extracted target (soft mode)", () => {
		const commands = ["chmod 600", "tee", "mkdir -p", "sed -i 's/a/b/'"];
		for (const command of commands) {
			expect(shouldBlockBashCommand(command, CTX).block).toBe(false);
		}
	});

	it("does NOT block absolute targets under cwd (soft mode)", () => {
		const target = join(CTX.cwd, "src/absolute-bypass.ts");
		const result = shouldBlockBashCommand(`echo x > ${target}`, CTX);
		expect(result.block).toBe(false);
	});

	it("returns { block: false } for documented safe reads and out-of-repo redirects", () => {
		for (const command of [
			"cat README.md",
			"ls -la",
			"grep TODO README.md",
			"git status",
			"bun test",
			"echo x > /tmp/sages-safe-output",
		]) {
			expect(shouldBlockBashCommand(command, CTX)).toEqual({ block: false });
		}
	});
});

describe("shouldBlockBashCommand — 15 design cases (soft mode inverts all blocks)", () => {
	it("T1 (inverted): rm src/auth/service.ts → block:false", () => {
		const r = shouldBlockBashCommand("rm src/auth/service.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T2 (inverted): rm -rf /tmp/foo → block:false (destructives are no longer denied)", () => {
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

	it("T5 (inverted): echo x > src/foo.ts → block:false (redirect to src/)", () => {
		const r = shouldBlockBashCommand("echo x > src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T6 (inverted): mv src/foo.ts /tmp/ → block:false", () => {
		const r = shouldBlockBashCommand("mv src/foo.ts /tmp/", CTX);
		expect(r.block).toBe(false);
	});

	it("T7 (inverted): mv /tmp/x.ts src/foo.ts → block:false (destructives no longer denied)", () => {
		const r = shouldBlockBashCommand("mv /tmp/x.ts src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T8 (inverted): git checkout -- src/foo.ts → block:false", () => {
		const r = shouldBlockBashCommand("git checkout -- src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T9 (inverted): git checkout HEAD~1 -- src/foo.ts → block:false", () => {
		const r = shouldBlockBashCommand("git checkout HEAD~1 -- src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T10: git status → block:false (read-only)", () => {
		const r = shouldBlockBashCommand("git status", CTX);
		expect(r.block).toBe(false);
	});

	it("T11 (inverted): find . -name \"*.bak\" -delete → block:false", () => {
		const r = shouldBlockBashCommand('find . -name "*.bak" -delete', CTX);
		expect(r.block).toBe(false);
	});

	it("T12: npm test → block:false (read-only)", () => {
		const r = shouldBlockBashCommand("npm test", CTX);
		expect(r.block).toBe(false);
	});

	it("T13 (inverted): python3 -c with os.remove → block:false (soft mode)", () => {
		const r = shouldBlockBashCommand(
			`python3 -c "import os; os.remove('src/x.ts')"`,
			CTX,
		);
		expect(r.block).toBe(false);
	});

	it("T14 (inverted): python3 -c without extractable target → block:false (soft mode)", () => {
		const r = shouldBlockBashCommand(
			`python3 -c "import os; os.remove('src/x.ts')"`,
			CTX,
		);
		expect(r.block).toBe(false);
	});

	it("T15 (inverted): sed -i 's/a/b/' src/foo.ts → block:false (soft mode)", () => {
		const r = shouldBlockBashCommand(`sed -i 's/a/b/' src/foo.ts`, CTX);
		expect(r.block).toBe(false);
	});
});

/**
 * Chained-command hardening (T16–T22, 2026-07-25). The chained-command
 * splitter and per-segment classification are still useful for
 * downstream consumers (e.g. the bash handler in `extension.ts` uses
 * `classifyBashCommand` to decide whether to emit the soft-mode
 * reminder). In soft mode, every command — chained or not — returns
 * `{ block: false }` regardless of whether any segment was write-intent.
 */
describe("shouldBlockBashCommand — chained commands (T16–T22, soft mode inverts blocks)", () => {
	it("T16 (inverted): `echo done && rm src/foo.ts` → block:false", () => {
		const r = shouldBlockBashCommand("echo done && rm src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T17 (inverted): `cat src/foo.ts && rm src/foo.ts` → block:false", () => {
		const r = shouldBlockBashCommand("cat src/foo.ts && rm src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T18: `cat src/foo.ts && echo done` → allow (all segments read-only)", () => {
		const r = shouldBlockBashCommand("cat src/foo.ts && echo done", CTX);
		expect(r.block).toBe(false);
	});

	it("T19 (inverted): `rm /tmp/foo && rm src/foo.ts` → block:false (destructives no longer denied)", () => {
		const r = shouldBlockBashCommand("rm /tmp/foo && rm src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T20 (inverted): `rm src/foo.ts || echo failed` → block:false", () => {
		const r = shouldBlockBashCommand("rm src/foo.ts || echo failed", CTX);
		expect(r.block).toBe(false);
	});

	it("T21 (inverted): `rm src/foo.ts; echo done` → block:false", () => {
		const r = shouldBlockBashCommand("rm src/foo.ts; echo done", CTX);
		expect(r.block).toBe(false);
	});

	it("T22 (inverted): `rm src/foo.ts && echo done` → block:false", () => {
		const r = shouldBlockBashCommand(`rm src/foo.ts && echo done`, CTX);
		expect(r.block).toBe(false);
	});

	it("T23 (inverted): `rm \"src/foo.ts\" && echo done` → block:false", () => {
		const r = shouldBlockBashCommand(
			`rm "src/foo.ts" && echo done`,
			CTX,
		);
		expect(r.block).toBe(false);
	});

	it("T23b: chained command does NOT split on quoted `&&`", () => {
		// `echo "a && b"` is one segment; no chain. We split outside the
		// quotes, so the inner `&&` is preserved as data. The result is
		// `echo "a && b"` — read-only — followed by an empty trailing
		// segment that gets dropped. Should allow.
		const r = shouldBlockBashCommand('echo "a && b" && echo done', CTX);
		expect(r.block).toBe(false);
	});

	it("T24 (inverted): `(echo done) && rm src/foo.ts` → block:false", () => {
		const r = shouldBlockBashCommand("(echo done) && rm src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T25 (inverted): `perl -e \"unlink 'src/foo.ts'\"` → block:false", () => {
		const r = shouldBlockBashCommand(
			`perl -e "unlink 'src/foo.ts'"`,
			CTX,
		);
		expect(r.block).toBe(false);
	});

	it("T26 (inverted): `echo x 2> src/foo.ts` → block:false", () => {
		const r = shouldBlockBashCommand("echo x 2> src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T25b (inverted): `perl -e \"unlink 'src/foo.ts'\"` → block:false", () => {
		const r = shouldBlockBashCommand(
			`perl -e "unlink 'src/foo.ts'"`,
			CTX,
		);
		expect(r.block).toBe(false);
	});

	it("T26b (inverted): `echo x 2> src/foo.ts` → block:false", () => {
		const r = shouldBlockBashCommand(
			`echo x 2> src/foo.ts`,
			CTX,
		);
		expect(r.block).toBe(false);
	});

	it("T26c: `echo x 2>&1` → allow (fd duplication, not a file redirect)", () => {
		const r = shouldBlockBashCommand("echo x 2>&1", CTX);
		expect(r.block).toBe(false);
	});

	it("T27: `cd /tmp && cat /etc/hostname` → block:false (cd is read-only)", () => {
		const r = shouldBlockBashCommand("cd /tmp && cat /etc/hostname", CTX);
		expect(r.block).toBe(false);
	});

	it("T28 (inverted): `cd /tmp && rm src/foo.ts` → block:false", () => {
		const r = shouldBlockBashCommand("cd /tmp && rm src/foo.ts", CTX);
		expect(r.block).toBe(false);
	});

	it("T29: `pwd && echo done` → block:false (pwd is read-only)", () => {
		const r = shouldBlockBashCommand("pwd && echo done", CTX);
		expect(r.block).toBe(false);
	});
});

describe("classifyBashCommand — selected cases (unchanged)", () => {
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
		expect(classifyBashCommand("git checkout main")).toBe("git-meta");
	});
});

describe("extractBashTargets — selected cases (unchanged)", () => {
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

describe("isGitMetaCommand — unchanged", () => {
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
		"git checkout main", "git checkout feature/x", "git checkout -b feature/x",
		"git checkout -B feature/x", "git checkout --orphan orphan-branch",
		"git checkout --detach HEAD~1", "git checkout -",
		"git switch main", "git switch -c feature/x", "git switch -C feature/x",
		"git switch --orphan orphan-branch", "git switch --detach HEAD~1",
	];
	for (const [index, command] of l2Allow.entries()) it(`T-L2-${String(index + 1).padStart(2, "0")} L2 git-meta allows ${command}`, () => {
		expect(isGitMetaCommand(command).allow).toBe(true);
	});
	const l2Deny = [
		"git checkout -- src/foo.ts", "git restore src/foo.ts", "git rm src/foo.ts",
		"git mv src/foo.ts src/bar.ts", "git reset --hard HEAD~1", "git clean -fd",
		"git stash drop", "git tag -d v1.0.0", "git branch -D feature/x",
		"git push --force origin main", "git push -f origin main", "git worktree remove --force /tmp/w",
		"git switch --discard-changes",
		"git push --force-with-lease origin main", "git push --force-if-includes origin main",
	];
	for (const [index, command] of l2Deny.entries()) it(`T-L2-D-${String(index + 1).padStart(2, "0")} L2 git-meta destructive denies ${command}`, () => {
		const verdict = isGitMetaCommand(command);
		expect(verdict.allow).toBe(false);
		if (!verdict.allow) expect(verdict.reason).toContain("destructive:");
	});
});

describe("soft mode bash-guard — every command returns { block: false }", () => {
	const allCommands = [
		"cat src/foo.ts",
		"rm src/foo.ts",
		"rm -rf /tmp/foo",
		"echo x > src/foo.ts",
		"mv src/foo.ts /tmp/",
		"git checkout -- src/foo.ts",
		"find . -name '*.bak' -delete",
		"sed -i 's/a/b/' src/foo.ts",
		"python3 -c \"import os; os.remove('src/x.ts')\"",
		"echo x > .pi/orchestrator/audit-P1.md",
		"sed -i 's/foo/bar/' pi/templates/SYSTEM.md",
		"echo text > pi/src/extension.ts",
		"echo text > pi-subagents/src/agent-runner.ts",
		"cat > src/foo.ts <<EOF\ntext\nEOF",
		"rm pi/src/foo.ts && echo done",
		"env X=1 sed -i 's/a/b/' src/bypass.ts",
		"find . -name '*.ts' -exec touch {} +",
	];
	for (const [index, command] of allCommands.entries()) {
		it(`T-SOFT-${String(index + 1).padStart(3, "0")} allows ${command}`, () => {
			expect(shouldBlockBashCommand(command, CTX).block).toBe(false);
		});
	}
});

describe("soft mode — destructive commands are no longer denied", () => {
	it("T-D-INV-01: `rm .pi/orchestrator/test.md` → block:false (destructives allowed)", () => {
		const r = shouldBlockBashCommand("rm .pi/orchestrator/test.md", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-02: `rm AGENTS.md` → block:false", () => {
		const r = shouldBlockBashCommand("rm AGENTS.md", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-03: `mv pi/templates/foo.md pi/templates/bar.md` → block:false", () => {
		const r = shouldBlockBashCommand("mv pi/templates/foo.md pi/templates/bar.md", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-04: `cp pi/skills/foo.md pi/skills/bar.md` → block:false", () => {
		const r = shouldBlockBashCommand("cp pi/skills/foo.md pi/skills/bar.md", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-05: `rm -rf .pi/orchestrator` → block:false", () => {
		const r = shouldBlockBashCommand("rm -rf .pi/orchestrator", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-06: `rm --force .pi/orchestrator/anything.md` → block:false", () => {
		const r = shouldBlockBashCommand("rm --force .pi/orchestrator/anything.md", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-07: `unlink .pi/orchestrator/foo.md` → block:false", () => {
		const r = shouldBlockBashCommand("unlink .pi/orchestrator/foo.md", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-08: `rmdir .pi/orchestrator/subdir` → block:false", () => {
		const r = shouldBlockBashCommand("rmdir .pi/orchestrator/subdir", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-09: `mkdir -p .pi/orchestrator/new-dir` → block:false", () => {
		const r = shouldBlockBashCommand("mkdir -p .pi/orchestrator/new-dir", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-10: `tee .pi/orchestrator/foo.md < /dev/null` → block:false", () => {
		const r = shouldBlockBashCommand("tee .pi/orchestrator/foo.md < /dev/null", CTX);
		expect(r.block).toBe(false);
	});

	it("T-D-INV-11: `echo done && rm .pi/orchestrator/foo.md` → block:false", () => {
		const r = shouldBlockBashCommand("echo done && rm .pi/orchestrator/foo.md", CTX);
		expect(r.block).toBe(false);
	});
});

describe("extractBashTargets — chain-parser correctness (unchanged)", () => {
	it("T-CP-01: extractBashTargets(`rm pi/src/test.ts 2>&1 | head -5`) → only [pi/src/test.ts]", () => {
		const t = extractBashTargets("rm pi/src/test.ts 2>&1 | head -5");
		expect(t).toEqual(["pi/src/test.ts"]);
	});

	it("T-CP-02: extractBashTargets(`mv src/foo.ts src/bar.ts && echo done`) → [src/foo.ts, src/bar.ts]", () => {
		const t = extractBashTargets("mv src/foo.ts src/bar.ts && echo done");
		expect(t).toEqual(["src/foo.ts", "src/bar.ts"]);
	});

	it("T-CP-03: extractBashTargets(`cat > .pi/orchestrator/test.md <<EOF\\nfoo\\nEOF`) → [.pi/orchestrator/test.md]", () => {
		const t = extractBashTargets("cat > .pi/orchestrator/test.md <<EOF\nfoo\nEOF");
		expect(t).toEqual([".pi/orchestrator/test.md"]);
	});

	it("T-CP-04: extractBashTargets(`sed -i 's/foo/bar/' pi/src/index.ts`) → [pi/src/index.ts] only", () => {
		const t = extractBashTargets("sed -i 's/foo/bar/' pi/src/index.ts");
		expect(t).toEqual(["pi/src/index.ts"]);
	});

	it("T-CP-05: extractBashTargets(`rm -rf /tmp/foo`) → [/tmp/foo]", () => {
		const t = extractBashTargets("rm -rf /tmp/foo");
		expect(t).toEqual(["/tmp/foo"]);
	});

	it("T-CP-06: extractBashTargets(`mkdir -p .pi/orchestrator/sub && echo done`) → [.pi/orchestrator/sub]", () => {
		const t = extractBashTargets("mkdir -p .pi/orchestrator/sub && echo done");
		expect(t).toEqual([".pi/orchestrator/sub"]);
	});

	it("T-CP-07: extractBashTargets(`cp src/foo.ts dst/ ; rm bar`) → [dst/]", () => {
		const t = extractBashTargets("cp src/foo.ts dst/ ; rm bar");
		expect(t).toEqual(["dst/"]);
	});
});
