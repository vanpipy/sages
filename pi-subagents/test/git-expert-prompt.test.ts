/**
 * git-expert-prompt.test.ts — Content invariants of the git-expert prompt module.
 *
 * The canonical `git-expert` prompt is embedded as a built-in in
 * `pi-subagents/src/agent-prompts/git-expert.ts`. This file pins the
 * **semantic invariants** every consumer can rely on, not the prose.
 * The prose is allowed to evolve; the invariants are not.
 *
 * GC-2026-030: the git-expert sub-agent handles git inspection,
 * backtrack archaeology, worktree diagnostics, and produces
 * git-usage recipes for other subagents. It is read-only on
 * production code; all write activity happens in
 * `.pi/git-scratch-<task_id>-<suffix>/`.
 *
 * Required content:
 *   - Non-empty string > 1000 chars
 *   - Identifies itself as a senior git operator
 *   - R1 read-only-on-production block: lists allowed read commands AND
 *     forbidden mutating commands
 *   - R2 forbidden paths: /home/leroy/Project/sages/.git,
 *     /home/leroy/sages-worktrees/main/.git, .pi/worktree/<DAG>/<TASK>
 *   - R3 sandbox path: .pi/git-scratch-<task_id>-<suffix>/
 *   - All 7 scenario names:
 *     worktree-broken, lost-commit, merge-conflict-preview, bisect,
 *     branch-hygiene, git-recipe-for-<role>, general-diagnosis
 *   - BLOCKED protocol (BLOCKED: missing <field>, BLOCKED: recipe would require <violation>)
 *   - Cross-subagent recipe template with sections:
 *     Pre-conditions, Steps, Failure modes, Verify, Forbidden
 *   - Tool routing mentions bash as primary tool for git commands
 *   - Output report schema: Summary / Evidence / Diagnosis / Recommended Action / Sandbox Leftovers
 *   - Constraints: runInBackground default true, maxTurns default 120
 */

import { describe, expect, it } from "vitest";
import { GIT_EXPERT_PROMPT } from "../src/agent-prompts/git-expert.js";

describe("git-expert-prompt: invariants", () => {
	it("exports a non-empty string", () => {
		expect(typeof GIT_EXPERT_PROMPT).toBe("string");
		expect(GIT_EXPERT_PROMPT.length).toBeGreaterThan(1000);
	});

	it("identifies itself as a senior git operator", () => {
		// Identity must surface in the heading so an LLM reading the
		// prompt can immediately recognize the role. Audit reads use
		// the same anchor to verify role identity.
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toMatch(/senior.*git.*operator/);
	});

	it("declares R1 read-only-on-production block with allowed commands", () => {
		// R1 is the load-bearing policy: production repos are read-only.
		// Each named command must appear in the prompt so the policy
		// is backed by both the registry's tool list AND the prose.
		expect(GIT_EXPERT_PROMPT).toMatch(/R1[\s\S]*read[- ]only/i);
		for (const cmd of [
			"log",
			"show",
			"diff",
			"blame",
			"grep",
			"ls-files",
			"reflog",
			"fsck",
			"cat-file",
			"for-each-ref",
			"worktree list",
			"status",
			"branch",
			"tag",
		]) {
			expect(
				GIT_EXPERT_PROMPT.toLowerCase(),
				`R1 must list allowed command '${cmd}'`,
			).toContain(cmd.toLowerCase());
		}
	});

	it("R1 block lists forbidden mutating commands", () => {
		// The mirror half of R1: the prompt MUST name the mutations
		// that are forbidden against production code.
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toMatch(
			/commit|reset|checkout --|clean|rm|mv|push|pull|branch -d|tag -d|update-ref|worktree add|worktree remove|worktree prune/,
		);
	});

	it("declares R2 forbidden paths block (sages/.git, sages-worktrees/main/.git, .pi/worktree/<DAG>/<TASK>)", () => {
		// R2 names the Sages-specific invariants that must NOT be touched.
		expect(GIT_EXPERT_PROMPT).toContain("/home/leroy/Project/sages/.git");
		expect(GIT_EXPERT_PROMPT).toContain(
			"/home/leroy/sages-worktrees/main/.git",
		);
		expect(GIT_EXPERT_PROMPT).toContain(".pi/worktree/<DAG>/<TASK>");
	});

	it("declares R3 sandbox path .pi/git-scratch-<task_id>-<suffix>/", () => {
		// R3: every write must land in a path named under
		// `.pi/git-scratch-<task_id>-<suffix>/`. Pin the literal so a
		// future contributor can't quietly move the sandbox under /tmp.
		expect(GIT_EXPERT_PROMPT).toContain(".pi/git-scratch-<task_id>-<suffix>/");
	});

	it("names all 7 scenarios", () => {
		// The seven scenarios are the load-bearing scenario taxonomy.
		// A future prose edit that drops one of them would silently
		// flatten git-expert's dispatch surface — the orchestrator
		// would lose the ability to ask for that capability.
		const scenarios = [
			"worktree-broken",
			"lost-commit",
			"merge-conflict-preview",
			"bisect",
			"branch-hygiene",
			"git-recipe-for-<role>",
			"general-diagnosis",
		];
		for (const s of scenarios) {
			expect(
				GIT_EXPERT_PROMPT,
				`scenario '${s}' must be named in the prompt`,
			).toContain(s);
		}
	});

	it("BLOCKED protocol: BLOCKED: missing <field> for invalid inputs", () => {
		// The BLOCKED protocol is how git-expert tells the caller "I
		// don't have what I need; don't guess." Pin the exact prefix
		// so it cannot drift into a soft "warn" instead.
		expect(GIT_EXPERT_PROMPT).toContain("BLOCKED: missing");
	});

	it("BLOCKED protocol: BLOCKED: recipe would require <violation> for cross-subagent recipes", () => {
		// The cross-subagent BLOCKED branch must surface the violation
		// it would have to commit. A future edit that softens this
		// would let git-expert ship recipes that violate R1/R2.
		expect(GIT_EXPERT_PROMPT).toMatch(/BLOCKED:.*recipe.*would.*require/i);
	});

	it("cross-subagent recipe template carries Pre-conditions / Steps / Failure modes / Verify / Forbidden sections", () => {
		// The recipe template is the deliverable for
		// `git-recipe-for-<role>` scenarios. Pin the five section
		// headings — a future edit that drops one would let
		// recipes ship without an explicit safety check (Verify
		// / Forbidden) or a recovery path (Failure modes).
		expect(GIT_EXPERT_PROMPT).toMatch(/## Recipe for <role>/);
		expect(GIT_EXPERT_PROMPT).toContain("### Pre-conditions");
		expect(GIT_EXPERT_PROMPT).toContain("### Steps");
		expect(GIT_EXPERT_PROMPT).toContain("### Failure modes");
		expect(GIT_EXPERT_PROMPT).toContain("### Verify");
		expect(GIT_EXPERT_PROMPT).toContain("### Forbidden in this recipe");
	});

	it("declares tool routing: bash is the primary tool for git commands", () => {
		// git-expert runs read-only git commands via bash (no AFT
		// equivalent). AFT is only for confirming a finding against
		// non-git file content. Pin the routing so a future edit
		// doesn't flip git ops to AFT (which doesn't index them).
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("bash");
		// And the routing block names AFT for non-git file reads.
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toMatch(/aft/);
	});

	it("output report schema: Summary / Evidence / Diagnosis / Recommended Action / Sandbox Leftovers", () => {
		// The report schema is what the orchestrator reads back from
		// git-expert via get_subagent_result. Pin the section headings
		// so a downstream consumer (e.g. a future workflow that
		// auto-extracts findings) can rely on them.
		expect(GIT_EXPERT_PROMPT).toContain("### Summary");
		expect(GIT_EXPERT_PROMPT).toContain("### Evidence");
		expect(GIT_EXPERT_PROMPT).toContain("### Diagnosis");
		expect(GIT_EXPERT_PROMPT).toContain("### Recommended Action");
		expect(GIT_EXPERT_PROMPT).toContain("### Sandbox Leftovers");
	});

	it("constraints: runInBackground default true, maxTurns default 120", () => {
		// Archaeology can run long (1-10 min). The maxTurns budget
		// is the load-bearing number for budget planning; pin it.
		expect(GIT_EXPERT_PROMPT).toMatch(/maxTurns.*120|120.*maxTurns/);
		expect(GIT_EXPERT_PROMPT).toMatch(
			/runInBackground.*true|true.*runInBackground/,
		);
	});

	it("does NOT include a `model:` field — inherits global default", () => {
		// The caller explicitly removed the model pin; the prompt
		// must NOT pin a model. A future contributor re-adding the
		// pin would silently bypass the global default — pin the
		// absence.
		expect(GIT_EXPERT_PROMPT).not.toMatch(/model[:\s]/i);
	});

	it("declares inspect capability — log/grep/blame/ls-files/diff-tree across refs", () => {
		// The "Inspect" capability surfaces the search semantics:
		// `git log` / `git grep` / `git blame` / `git ls-files` across
		// refs. Pin the verbs.
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("inspect");
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("blame");
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("log");
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("grep");
	});

	it("declares backtrack capability — reflog/fsck/cat-file for lost state", () => {
		// The "Backtrack" capability is the archaeology path:
		// reflog + fsck + cat-file. Pin the commands.
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("backtrack");
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("reflog");
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("fsck");
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("cat-file");
	});

	it("declares cross-subagent guidance capability", () => {
		// Cross-subagent guidance is the recipe-for-role path.
		// Pin that the capability is named so a future edit can't
		// drop the dispatcher surface.
		expect(GIT_EXPERT_PROMPT.toLowerCase()).toContain("cross-subagent");
	});
});

describe("git-expert-prompt: FIRST tool priorities (GC-2026-087 P2)", () => {
	// GC-2026-087 P2: git-expert's primary tool is bash (no AFT
	// equivalent for git internals — `git cat-file`, `git reflog`,
	// `git fsck` are not indexed by AFT). The FIRST tool priorities
	// section surfaces this so the LLM does not waste turns trying
	// AFT on git object inspection. One merger-specific row added
	// to the default table.

	it("declares a 'FIRST tool priorities' section header", () => {
		expect(GIT_EXPERT_PROMPT).toMatch(/^##\s+FIRST tool priorities.*$/m);
	});

	it("FIRST tool priorities section sits between Identity and Tool set", () => {
		const identityIdx =
			GIT_EXPERT_PROMPT.match(/^##\s+.*Your Identity.*$/m)?.index ?? -1;
		const firstIdx =
			GIT_EXPERT_PROMPT.match(/^##\s+FIRST tool priorities.*$/m)?.index ?? -1;
		const toolIdx =
			GIT_EXPERT_PROMPT.match(/^##\s+.*Tool set.*$/m)?.index ?? -1;
		expect(identityIdx).toBeGreaterThanOrEqual(0);
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(toolIdx).toBeGreaterThanOrEqual(0);
		expect(
			firstIdx,
			"FIRST tool priorities must come AFTER Identity",
		).toBeGreaterThan(identityIdx);
		expect(
			firstIdx,
			"FIRST tool priorities must come BEFORE Tool set",
		).toBeLessThan(toolIdx);
	});

	it("includes at least 3 bullet entries (each '- **Task**: ...')", () => {
		expect(GIT_EXPERT_PROMPT).toContain("## FIRST tool priorities");
		const section =
			GIT_EXPERT_PROMPT.split("## FIRST tool priorities")[1]?.split("##")[0] ??
			"";
		const entries = section
			.split("\n")
			.filter((l) => l.trim().startsWith("- **"));
		expect(
			entries.length,
			`expected >= 3 bullet entries, got ${entries.length}`,
		).toBeGreaterThanOrEqual(3);
	});

	it("names bash as the right tool for git internals (cat-file / reflog / fsck)", () => {
		// The default table's `bash` fallback line is fine, but the
		// git-expert-specific row must surface git internals
		// explicitly so the LLM does not reach for AFT for git
		// objects. Pin at least one git-internals verb (cat-file /
		// reflog / fsck) in the section.
		expect(GIT_EXPERT_PROMPT).toContain("## FIRST tool priorities");
		const section =
			GIT_EXPERT_PROMPT.split("## FIRST tool priorities")[1]?.split("##")[0] ??
			"";
		expect(
			section,
			"section must name a git-internals command (cat-file/reflog/fsck)",
		).toMatch(/cat-file|reflog|fsck/);
	});
});
