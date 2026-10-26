/**
 * system-prompt-global-scope.test.ts — SYSTEM.md is a GLOBAL policy.
 *
 * `templates/SYSTEM.md` is the template that `scripts/install.sh` copies to
 * `$AGENT_DIR/SYSTEM.md` (`~/.pi/agent/SYSTEM.md`). pi's resource loader
 * discovers that file and uses it as the base system prompt for **every**
 * session — in every project, in every repository the user opens
 * (`pi-coding-agent/dist/core/resource-loader.js:808`
 * `discoverSystemPromptFile`). It is therefore the global definition of how
 * the pi agent behaves, not a policy about one repository.
 *
 * The failure this file guards against: the policy drifts back into
 * describing the Sages monorepo — its package layout, its git hooks, its
 * own directory names. Every such sentence is wrong the moment the same
 * file is read from a checkout that has none of them, and the agent then
 * either looks for files that do not exist or follows hooks that are not
 * installed.
 *
 * The second half of the file pins the delivery contract: the policy must
 * reach the model exactly once per session. pi already loads
 * `~/.pi/agent/SYSTEM.md` as the base system prompt, and the orchestrator
 * extension's `before_agent_start` hook prepends the same template on top
 * of it — so without a guard the same ~19 KB of policy lands in the system
 * prompt twice.
 *
 * Run: cd pi-orchestrator && bun test ./test/system-prompt-global-scope.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SYSTEM_MD = join(__dirname, "..", "templates", "SYSTEM.md");

const systemMd = readFileSync(SYSTEM_MD, "utf-8");

/**
 * Repository-relative package paths. These only resolve inside the Sages
 * monorepo; in any other checkout they are dangling references. The
 * trailing slash is what makes the check path-shaped — a bare extension
 * name (`pi-tasks` as the installed extension) is legitimate, a directory
 * in the current repository is not.
 */
const REPO_PACKAGE_PATH =
	/\bpi-(?:orchestrator|tasks|subagents|codebase-memory|evaluator|routines|sidebar)\//;

/**
 * Tool-name prefixes whose tools the runtime does not register. pi drops
 * unknown names from the active tool set
 * (`pi-coding-agent/dist/core/agent-session.js:631`
 * `setActiveToolsByName` — "Only tools in the registry can be enabled.
 * Unknown tool names are ignored"), so a policy that tells the agent to
 * call one is instructing it to make a call that fails.
 *
 * `codebase_memory_*` is in this list because no pi extension registers
 * those names: `pi-codebase-memory` ships an MCP server, and the pi tools
 * that reach it are the `mcp` proxy plus the AFT suite.
 */
const UNREGISTERED_TOOL_PREFIX = /\bcodebase_memory_[a-z_]+/g;

describe("SYSTEM.md — the policy is global, not repository-scoped", () => {
	it("does not scope the policy to the Sages monorepo", () => {
		expect(systemMd).not.toMatch(/Sages monorepo/i);
		expect(systemMd).not.toMatch(/^#\s+Sages\b/m);
		expect(systemMd).not.toMatch(/The Sages Boundary/);
	});

	it("does not name repository-relative package paths", () => {
		expect(systemMd).not.toMatch(REPO_PACKAGE_PATH);
	});

	it("carries no repository-internal identifiers", () => {
		// GC-IDs are this repository's internal goal-tracking vocabulary;
		// they mean nothing to a user in any other project.
		expect(systemMd).not.toMatch(/GC-\d{4}-/);
		// `.pi/orchestrator/` exists only inside the Sages checkout — the
		// global policy may not point the agent at it.
		expect(systemMd).not.toMatch(/\.pi\/orchestrator\//);
		// The product name itself: the policy is about the pi agent, so it
		// must not carry the brand of one project. (The `SAGES_TEMPLATE_V1`
		// sentinel is upper case and machine-facing.)
		expect(systemMd).not.toMatch(/\bSages\b/);
	});

	it("does not name this repository's git hooks", () => {
		// `orchestrator:typecheck` / `orchestrator:test` are the pre-commit
		// hooks of the Sages monorepo. In another checkout they either do
		// not exist or belong to a different toolchain.
		expect(systemMd).not.toMatch(/orchestrator:(?:typecheck|test)/);
	});

	it("states that it applies to every project", () => {
		expect(systemMd).toMatch(/every project/i);
		expect(systemMd).toMatch(/~\/\.pi\/agent\/SYSTEM\.md/);
	});

	it("does not tell the agent to call a tool the runtime does not register", () => {
		expect(systemMd).not.toMatch(UNREGISTERED_TOOL_PREFIX);
	});
});

describe("SYSTEM.md — the policy reaches the model exactly once", () => {
	/** Minimal stand-in for the pi extension API. */
	function mockPi() {
		const beforeAgentStart: Array<(event: unknown) => unknown> = [];
		return {
			beforeAgentStart,
			api: {
				setActiveTools() {
					/* noop */
				},
				setStatus() {
					/* noop */
				},
				registerTool() {
					/* noop */
				},
				appendEntry() {
					/* noop */
				},
				on(event: string, handler: (event: unknown) => unknown) {
					if (event === "before_agent_start") beforeAgentStart.push(handler);
				},
			},
		};
	}

	it("prepends the policy when the base system prompt does not carry it", async () => {
		// A project with its own `.pi/SYSTEM.md` replaces the global file
		// (`discoverSystemPromptFile` prefers the project path), so the
		// extension hook is the only delivery path left.
		const pi = mockPi();
		const ext = await import("../src/extension.js");
		ext.default(pi.api as never);
		const result = pi.beforeAgentStart[0]!({ systemPrompt: "PROJECT_PROMPT" }) as
			| { systemPrompt: string }
			| undefined;
		expect(result?.systemPrompt).toContain("PROJECT_PROMPT");
		expect(result?.systemPrompt).toContain(systemMd.trim());
	});

	it("does not prepend the policy a second time when the base prompt already carries it", async () => {
		// The global install path: `~/.pi/agent/SYSTEM.md` is the base
		// system prompt AND the extension prepends the same template.
		const pi = mockPi();
		const ext = await import("../src/extension.js");
		ext.default(pi.api as never);
		const result = pi.beforeAgentStart[0]!({ systemPrompt: systemMd }) as
			| { systemPrompt: string }
			| undefined;
		// A hook that returns undefined leaves the base prompt untouched.
		const finalPrompt = result?.systemPrompt ?? systemMd;
		const occurrences = finalPrompt.split(systemMd.trim()).length - 1;
		expect(occurrences).toBe(1);
	});

	it("delivers the current policy when the installed copy is out of date", async () => {
		// A machine that installed the policy before this release still
		// carries the old text as its base prompt. The current policy must
		// still reach the model — the stale copy must not suppress it.
		const stale = "# Sages — Orchestrator Operating Policy\n\n## 16. Red Lines\n";
		const pi = mockPi();
		const ext = await import("../src/extension.js");
		ext.default(pi.api as never);
		const result = pi.beforeAgentStart[0]!({ systemPrompt: stale }) as
			| { systemPrompt: string }
			| undefined;
		expect(result?.systemPrompt).toContain(systemMd.trim());
	});
});
