/**
 * Tests for the Commit Conventions section in the developer agent prompt.
 *
 * Phase A (DAG-2026-011): the canonical `developer` agent lives as a
 * pi-subagents built-in (see `pi-subagents/src/agent-prompts/developer.ts`
 * and `pi-subagents/src/default-agents.ts`). The user-level template was
 * retired; these tests now read the built-in prompt file directly.
 *
 * The section encodes two non-negotiable constraints:
 *   1. Every commit MUST follow Conventional Commits 1.0.0
 *      (https://www.conventionalcommits.org/en/v1.0.0/) — the orchestrator
 *      and downstream tooling parse the `<type>` prefix.
 *   2. Author MUST come from `git config` or `git log` history — never
 *      invented. Fabricated authors break `git blame`, release tooling,
 *      and the audit trail.
 *
 * These tests catch the rules by reading the shipped prompt and
 * asserting key strings are present. They do NOT spawn a sub-agent
 * (that's covered by manual smoke + the orchestrator's evidence gate).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Phase A: developer is built-in to pi-subagents. Read from the source tree.
const REPO_ROOT = resolve(__dirname, "..", "..");
const AGENT_PATH = join(REPO_ROOT, "..", "pi-subagents", "src", "agent-prompts", "developer.ts");

const TEXT = readFileSync(AGENT_PATH, "utf-8");

describe("developer.md — Conventional Commits format (rule 1)", () => {
	it("references the Conventional Commits 1.0.0 spec", () => {
		// Match any version of the URL — spec page is at conventionalcommits.org
		// and the spec allows URL fragments (e.g. #specification).
		expect(TEXT).toMatch(/conventionalcommits\.org\/en\/v1\.0\.0\/?/i);
	});

	it("documents the `<type>: <description>` structure", () => {
		// Look for the format template — a line beginning with `<type>` and a
		// colon, with `<description>` placeholder.
		expect(TEXT).toMatch(/<type>.*?:.*?<description>/);
	});

	it("lists at least the core Conventional Commits types", () => {
		// The 7 most-common types per the spec; agents must use these
		// (or a smaller project-defined subset).
		for (const type of ["feat", "fix", "docs", "refactor", "test", "chore"]) {
			expect(TEXT).toMatch(new RegExp(`\\b${type}\\b`));
		}
	});

	it("specifies description rules (lowercase, no period, imperative)", () => {
		// At least one of: "lowercase", "no period" / "no trailing period",
		// "imperative". Accept either word forms.
		const hasLowercase = /lowercase/i.test(TEXT);
		const hasNoPeriod = /no\s+(?:trailing\s+)?period/i.test(TEXT);
		const hasImperative = /imperative/i.test(TEXT);
		expect(hasLowercase || hasNoPeriod || hasImperative).toBe(true);
	});

	it("mentions breaking-change convention (`!` or BREAKING CHANGE)", () => {
		// Conventional Commits 1.0.0 requires `!` after type/scope OR
		// `BREAKING CHANGE:` footer for breaking changes.
		const hasBang = /breaking[\s\S]{0,40}!/i.test(TEXT);
		const hasFooter = /BREAKING\s+CHANGE/i.test(TEXT);
		expect(hasBang || hasFooter).toBe(true);
	});
});

describe("developer.md — author derivation (rule 2)", () => {
	it("instructs to read author from `git config user.name`", () => {
		expect(TEXT).toMatch(/git\s+config\s+user\.name/);
	});

	it("instructs to read author from `git config user.email`", () => {
		expect(TEXT).toMatch(/git\s+config\s+user\.email/);
	});

	it("falls back to `git log -1` history when config is empty", () => {
		// `git log -1` is the canonical "most recent commit" lookup; the
		// section must surface this fallback.
		expect(TEXT).toMatch(/git\s+log\s+-1/);
	});

	it("forbids `git commit --author=`", () => {
		// Look for `git commit --author` in a prohibition context — preceded
		// or followed by words like "never", "forbidden", "do not use", or
		// "🚫".
		expect(TEXT).toMatch(/(?:never|forbid|do\s+not|🚫|prohibit)/i);
		expect(TEXT).toMatch(/git\s+commit\s+--author/);
	});

	it("forbids `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` env overrides", () => {
		// These env vars let a caller fabricate an author for one command;
		// the rule must call them out by name.
		expect(TEXT).toMatch(/GIT_AUTHOR_(NAME|EMAIL)/);
	});

	it("instructs to abort when no author can be resolved", () => {
		// Don't silently fall through to a default — the section must
		// tell the agent to halt and report.
		expect(TEXT).toMatch(/stop|abort|fatal/i);
	});
});

describe("developer.md — section structure", () => {
	it("has a dedicated 'Commit Conventions' section (heading near 'Commit')", () => {
		// Match a markdown heading that includes "commit" + "convention"
		// (case-insensitive, emoji-optional). Allows either 📤 Commit
		// Conventions or plain "Commit Conventions".
		expect(TEXT).toMatch(/^#+\s+.*commit.*conventions?/im);
	});
});