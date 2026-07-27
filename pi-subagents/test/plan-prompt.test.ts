/**
 * plan-prompt.test.ts — Contract invariants for the canonical `Plan` agent.
 *
 * DAG-2026-017: Plan is no longer a software architect. The main agent owns
 * problem understanding, repository exploration, architecture decisions,
 * trade-offs, scope, acceptance criteria, and task topology. Plan is a
 * lightweight plan compiler: it accepts an explicit `Planning Brief` from
 * the main agent and converts it into a concise ordered implementation
 * plan. If the brief is insufficient, it returns `PLAN_STATUS: BLOCKED`
 * with the missing inputs listed.
 *
 * This file pins the prompt contract. The runtime config (model,
 * thinking, maxTurns, tools, extensions, skills, runInBackground,
 * inheritContext) is pinned in `test/default-agents.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { PLAN_PROMPT } from "../src/agent-prompts/plan.js";

/**
 * Strip prose that PROHIBITS a tool from the check below: we only want to
 * catch the agent being instructed TO call the tool (i.e. a tool-call
 * invocation like `codebase_memory_get_architecture(...)` or `todowrite(`.
 * The prompt's prohibition lines are allowed to name the tools in plain
 * English — that's how it tells the agent what not to do.
 */
function promptWithoutProhibitionLines(prompt: string): string {
	return prompt
		.split("\n")
		.filter(
			(line) =>
				!/^\s*[-*]\s*(running any|calling|searching past|generating a personal|do not call)/i.test(
					line,
				),
		)
		.join("\n");
}

describe("plan-prompt: prompt contract", () => {
	it("exports a non-empty string", () => {
		expect(typeof PLAN_PROMPT).toBe("string");
		expect(PLAN_PROMPT.length).toBeGreaterThan(200);
	});

	it("identifies Plan as a plan compiler, not an architect", () => {
		// The role identity is the most important contract: Plan is a
		// compiler, not an architect. "Architect" must not describe the
		// role (architectures / architecting are fine in passing).
		expect(PLAN_PROMPT).toMatch(/plan compiler/i);
		// Title line must NOT say "software architect":
		expect(PLAN_PROMPT).not.toMatch(/^.*software architect.*$/im);
	});

	it("declares a Planning Brief as the authoritative input", () => {
		expect(PLAN_PROMPT).toContain("Planning Brief");
		expect(PLAN_PROMPT).toMatch(/authoritative/i);
	});

	it("prohibits broad repository exploration", () => {
		// The contract forbids broad scans. Match either the original
		// prose or the canonical phrasing the test expects.
		const rest = promptWithoutProhibitionLines(PLAN_PROMPT);
		expect(rest).toMatch(/broad repository exploration|architectural scan/i);
	});

	it("does not actively call graph / call-path / context-history / codebase-memory tools", () => {
		// The new PLAN_PROMPT must NOT instruct Plan to call any of the
		// heavy semantic/graph/context tools. We tolerate plain-English
		// prohibition lines (handled by promptWithoutProhibitionLines)
		// but reject any active tool-call syntax like `toolname(...)`.
		const rest = promptWithoutProhibitionLines(PLAN_PROMPT);
		expect(rest).not.toMatch(/codebase_memory_[a-z_]+\s*\(/i);
		expect(rest).not.toMatch(/ctx_search\s*\(/i);
		expect(rest).not.toMatch(/aft_(search|outline|zoom)\s*\(/i);
	});

	it("prohibits brainstorming and trade-off selection by Plan", () => {
		expect(PLAN_PROMPT).toMatch(/brainstorm/i);
		expect(PLAN_PROMPT).toMatch(/trade-?off/i);
	});

	it("does not actively call todowrite (no personal task list)", () => {
		// Plan must not generate a personal task list. Plain-English
		// prohibition lines are tolerated; active tool calls are not.
		const rest = promptWithoutProhibitionLines(PLAN_PROMPT);
		expect(rest).not.toMatch(/todowrite\s*\(/i);
		expect(PLAN_PROMPT).toMatch(/personal task list/i);
	});

	it("allows reading only explicitly named files (no broad file scanning)", () => {
		expect(PLAN_PROMPT).toMatch(/explicitly named files?|named files? only/i);
		const rest = promptWithoutProhibitionLines(PLAN_PROMPT);
		expect(rest).not.toMatch(/aft_(search|outline|zoom)\s*\(/i);
	});

	it("outputs PLAN_STATUS: READY or PLAN_STATUS: BLOCKED", () => {
		expect(PLAN_PROMPT).toContain("PLAN_STATUS: READY");
		expect(PLAN_PROMPT).toContain("PLAN_STATUS: BLOCKED");
	});

	it("READY output shape: summary + critical files + ordered steps + per-step deps + verification + risks", () => {
		expect(PLAN_PROMPT).toMatch(/Summary/i);
		expect(PLAN_PROMPT).toMatch(/Critical files/i);
		expect(PLAN_PROMPT).toMatch(/Implementation steps/i);
		// Per-step Dependencies + Verification fields. The per-step
		// template must declare both; capital-D "Dependencies" or
		// "Dependencies:" — case insensitive.
		expect(PLAN_PROMPT).toMatch(/Dependencies/i);
		expect(PLAN_PROMPT).toMatch(/Verification/i);
		expect(PLAN_PROMPT).toMatch(/Risks/i);
	});

	it("BLOCKED output shape: missing inputs listed, no invented decisions", () => {
		expect(PLAN_PROMPT).toMatch(/Missing/i);
		expect(PLAN_PROMPT).toMatch(/do not invent|do not guess/i);
	});

	it("forbids emojis", () => {
		expect(PLAN_PROMPT).toContain("Do not use emojis");
	});
});
