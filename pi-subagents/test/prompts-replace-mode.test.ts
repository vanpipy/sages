/**
 * prompts-replace-mode.test.ts — Regression tests for subagent identity isolation.
 *
 * Problem: subagents were acting as if they were the main agent despite having
 * promptMode: "replace". The root cause was that the parent main-agent system
 * prompt was being passed into buildAgentPrompt even in replace mode, and while
 * the function technically didn't use it, the session's effective system prompt
 * still carried parent identity markers through other channels (AGENTS.md,
 * CLAUDE.md, appendSystemPromptOverride from upstream).
 *
 * The fix (GC-2026-SUBAGENT-IDENTITY/P2) does two things:
 *   1. In replace mode, buildAgentPrompt passes `undefined` as parentSystemPrompt
 *      to make the intent explicit and prevent accidental leakage through future
 *      code changes.
 *   2. runAgent suppresses upstream's AGENTS.md / CLAUDE.md / APPEND_SYSTEM.md
 *      via noContextFiles: true and appendSystemPromptOverride: () => [] — so
 *      the only system-prompt content is exactly what buildAgentPrompt produces.
 *
 * These tests prove:
 *   - Replace mode NEVER includes parent system prompt content.
 *   - Append mode DOES include parent system prompt when provided.
 *   - The <active_agent name> tag is present in both modes.
 *   - The role-specific prompt (GENERAL_PURPOSE_PROMPT etc.) is present in replace mode.
 *   - GenericBase is NOT used in replace mode.
 *   - In replace mode, the sub_agent_context block is NOT present.
 *   - A parent prompt that contains main-agent identity markers is excluded in replace mode.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildAgentPrompt } from "../src/prompts.js";
import type { AgentConfig, EnvInfo } from "../src/types.js";
import { GENERAL_PURPOSE_PROMPT } from "../src/agent-prompts/general-purpose.js";
import { EXPLORE_PROMPT } from "../src/agent-prompts/explore.js";
import { PLAN_PROMPT } from "../src/agent-prompts/plan.js";
import { DEVELOPER_PROMPT } from "../src/agent-prompts/developer.js";

// Minimal reproducible env for deterministic output
const MINIMAL_ENV: EnvInfo = {
	isGitRepo: false,
	branch: "",
	platform: "linux",
};

const MINIMAL_CWD = "/home/user/project";

/**
 * A parent system prompt that contains main-agent identity markers.
 *
 * IMPORTANT: Phrasing here must NOT overlap with any role-prompt content.
 * The GENERAL_PURPOSE_PROMPT says "dispatched by the L3 orchestrator" — that
 * is the role's OWN description and must remain. This parent prompt uses
 * completely different phrasing so the test can distinguish role identity
 * from parent identity.
 */
const MAIN_AGENT_PARENT_PROMPT = `# Sages Orchestrator

You are the primary coordinator managing the overall workflow...

<active_agent name="main"/>

## Your Responsibilities
- Coordinate all agents and manage task delegation
- Synthesize results from child processes
- Maintain system state in the .pi/orchestrator/ directory
- Write implementation code directly when appropriate
- Review and audit all sub-agent work before accepting it`;

describe("buildAgentPrompt — replace mode identity isolation", () => {
	describe("replace mode never inherits parent identity", () => {
		for (const [agentName, systemPrompt] of [
			["general-purpose", GENERAL_PURPOSE_PROMPT],
			["Explore", EXPLORE_PROMPT],
			["Plan", PLAN_PROMPT],
			["developer", DEVELOPER_PROMPT],
		] as const) {
			it(`${agentName}: parent prompt content is absent in replace mode`, () => {
				const config: AgentConfig = {
					name: agentName,
					description: `Test ${agentName}`,
					systemPrompt,
					promptMode: "replace",
					extensions: true,
					skills: false,
				};
				const prompt = buildAgentPrompt(
					config,
					MINIMAL_CWD,
					MINIMAL_ENV,
					MAIN_AGENT_PARENT_PROMPT, // passed but MUST be ignored
				);

				// The parent identity MUST NOT appear in replace mode output.
				// Key phrasing from the parent prompt (distinct from role prompts):
				expect(prompt).not.toContain("primary coordinator");
				expect(prompt).not.toContain("coordinate all agents");
				expect(prompt).not.toContain("Synthesize results from child");
				expect(prompt).not.toContain("Manage the .pi/orchestrator/");
				expect(prompt).not.toContain("Write implementation code directly");
				expect(prompt).not.toContain("Review and audit all sub-agent work");
				// GenericBase fallback content must not appear
				expect(prompt).not.toContain("general-purpose coding agent for complex");
				// sub_agent_context block is append-mode only
				expect(prompt).not.toContain("sub_agent_context");
			});

			it(`${agentName}: <active_agent name="${agentName}"/> tag is present`, () => {
				const config: AgentConfig = {
					name: agentName,
					description: `Test ${agentName}`,
					systemPrompt,
					promptMode: "replace",
					extensions: true,
					skills: false,
				};
				const prompt = buildAgentPrompt(
					config,
					MINIMAL_CWD,
					MINIMAL_ENV,
					MAIN_AGENT_PARENT_PROMPT,
				);
				expect(prompt).toContain(`<active_agent name="${agentName}"/>`);
			});

			it(`${agentName}: role-specific system prompt is present`, () => {
				const config: AgentConfig = {
					name: agentName,
					description: `Test ${agentName}`,
					systemPrompt,
					promptMode: "replace",
					extensions: true,
					skills: false,
				};
				const prompt = buildAgentPrompt(
					config,
					MINIMAL_CWD,
					MINIMAL_ENV,
					MAIN_AGENT_PARENT_PROMPT,
				);
				// Spot-check a unique string from each role prompt
				const uniqueMarker: Record<string, string> = {
					"general-purpose": "NOT the main agent",
					Explore: "READ-ONLY MODE",
					Plan: "READ-ONLY MODE",
					developer: "RED → GREEN → REFACTOR",
				};
				expect(prompt).toContain(uniqueMarker[agentName]);
			});

			it(`${agentName}: "You are a pi coding agent sub-agent" header is present`, () => {
				const config: AgentConfig = {
					name: agentName,
					description: `Test ${agentName}`,
					systemPrompt,
					promptMode: "replace",
					extensions: true,
					skills: false,
				};
				const prompt = buildAgentPrompt(
					config,
					MINIMAL_CWD,
					MINIMAL_ENV,
					MAIN_AGENT_PARENT_PROMPT,
				);
				expect(prompt).toContain("You are a pi coding agent sub-agent");
			});

			it(`${agentName}: env block (cwd + platform) is present`, () => {
				const config: AgentConfig = {
					name: agentName,
					description: `Test ${agentName}`,
					systemPrompt,
					promptMode: "replace",
					extensions: true,
					skills: false,
				};
				const prompt = buildAgentPrompt(
					config,
					MINIMAL_CWD,
					MINIMAL_ENV,
					MAIN_AGENT_PARENT_PROMPT,
				);
				expect(prompt).toContain(`Working directory: ${MINIMAL_CWD}`);
				expect(prompt).toContain("Platform: linux");
			});
		}
	});

	describe("replace mode with undefined parentSystemPrompt", () => {
		for (const [agentName, systemPrompt] of [
			["general-purpose", GENERAL_PURPOSE_PROMPT],
			["Explore", EXPLORE_PROMPT],
			["Plan", PLAN_PROMPT],
			["developer", DEVELOPER_PROMPT],
		] as const) {
			it(`${agentName}: output is identical whether parentSystemPrompt is undefined or a string`, () => {
				const config: AgentConfig = {
					name: agentName,
					description: `Test ${agentName}`,
					systemPrompt,
					promptMode: "replace",
					extensions: true,
					skills: false,
				};
				const withParent = buildAgentPrompt(
					config,
					MINIMAL_CWD,
					MINIMAL_ENV,
					MAIN_AGENT_PARENT_PROMPT,
				);
				const withoutParent = buildAgentPrompt(
					config,
					MINIMAL_CWD,
					MINIMAL_ENV,
					undefined,
				);
				// In replace mode, parentSystemPrompt must have zero effect.
				// If this assertion fails, the function is leaking parent content.
				expect(withParent).toBe(withoutParent);
			});
		}
	});
});

describe("buildAgentPrompt — append mode intentional compatibility", () => {
	const CUSTOM_APPEND_PROMPT = "Custom append instructions.";

	for (const [agentName, systemPrompt] of [
		["general-purpose", GENERAL_PURPOSE_PROMPT],
		["Explore", EXPLORE_PROMPT],
		["Plan", PLAN_PROMPT],
		["developer", DEVELOPER_PROMPT],
	] as const) {
		it(`${agentName}: parent system prompt IS included in append mode`, () => {
			const config: AgentConfig = {
				name: agentName,
				description: `Test ${agentName}`,
				systemPrompt,
				promptMode: "append",
				extensions: true,
				skills: false,
			};
			const prompt = buildAgentPrompt(
				config,
				MINIMAL_CWD,
				MINIMAL_ENV,
				MAIN_AGENT_PARENT_PROMPT,
			);
			// Append mode intentionally inherits the parent — verify parent content is present.
			// Use phrasing from MAIN_AGENT_PARENT_PROMPT fixture (different from role prompts).
			expect(prompt).toContain("Sages Orchestrator");
			expect(prompt).toContain("Coordinate all agents");
		});

		it(`${agentName}: sub_agent_context block IS present in append mode`, () => {
			const config: AgentConfig = {
				name: agentName,
				description: `Test ${agentName}`,
				systemPrompt,
				promptMode: "append",
				extensions: true,
				skills: false,
			};
			const prompt = buildAgentPrompt(
				config,
				MINIMAL_CWD,
				MINIMAL_ENV,
				MAIN_AGENT_PARENT_PROMPT,
			);
			expect(prompt).toContain("sub_agent_context");
			expect(prompt).toContain("sub-agent invoked");
		});

		it(`${agentName}: <active_agent name> tag IS present in append mode`, () => {
			const config: AgentConfig = {
				name: agentName,
				description: `Test ${agentName}`,
				systemPrompt,
				promptMode: "append",
				extensions: true,
				skills: false,
			};
			const prompt = buildAgentPrompt(
				config,
				MINIMAL_CWD,
				MINIMAL_ENV,
				MAIN_AGENT_PARENT_PROMPT,
			);
			expect(prompt).toContain(`<active_agent name="${agentName}"/>`);
		});
	}

	it("append mode falls back to genericBase when parentSystemPrompt is undefined", () => {
		const config: AgentConfig = {
			name: "general-purpose",
			description: "Test",
			systemPrompt: "Custom instructions.",
			promptMode: "append",
			extensions: true,
			skills: false,
		};
		const prompt = buildAgentPrompt(config, MINIMAL_CWD, MINIMAL_ENV, undefined);
		// When no parent is available, append mode uses genericBase as fallback identity
		expect(prompt).toContain("general-purpose coding agent for complex");
	});
});

describe("buildAgentPrompt — extras (memory, skills) survive in replace mode", () => {
	it("memoryBlock is appended after the role prompt in replace mode", () => {
		const config: AgentConfig = {
			name: "general-purpose",
			description: "Test",
			systemPrompt: GENERAL_PURPOSE_PROMPT,
			promptMode: "replace",
			extensions: true,
			skills: false,
		};
		const prompt = buildAgentPrompt(
			config,
			MINIMAL_CWD,
			MINIMAL_ENV,
			MAIN_AGENT_PARENT_PROMPT,
			{ memoryBlock: "# Memory\nSome memory content." },
		);
		expect(prompt).toContain("Some memory content.");
		// Memory comes after the role prompt
		expect(prompt.indexOf("Some memory content.")).toBeGreaterThan(
			prompt.indexOf("NOT the main agent"),
		);
	});

	it("skillBlocks are appended after the role prompt in replace mode", () => {
		const config: AgentConfig = {
			name: "general-purpose",
			description: "Test",
			systemPrompt: GENERAL_PURPOSE_PROMPT,
			promptMode: "replace",
			extensions: true,
			skills: false,
		};
		const prompt = buildAgentPrompt(
			config,
			MINIMAL_CWD,
			MINIMAL_ENV,
			MAIN_AGENT_PARENT_PROMPT,
			{ skillBlocks: [{ name: "MySkill", content: "Skill body here." }] },
		);
		expect(prompt).toContain("Preloaded Skill: MySkill");
		expect(prompt).toContain("Skill body here.");
	});
});

describe("buildAgentPrompt — git repo env block in replace mode", () => {
	it("includes git repository and branch when in a git repo", () => {
		const config: AgentConfig = {
			name: "general-purpose",
			description: "Test",
			systemPrompt: GENERAL_PURPOSE_PROMPT,
			promptMode: "replace",
			extensions: true,
			skills: false,
		};
		const gitEnv: EnvInfo = {
			isGitRepo: true,
			branch: "sages/my-branch",
			platform: "linux",
		};
		const prompt = buildAgentPrompt(
			config,
			MINIMAL_CWD,
			gitEnv,
			MAIN_AGENT_PARENT_PROMPT,
		);
		expect(prompt).toContain("Git repository: yes");
		expect(prompt).toContain("Branch: sages/my-branch");
	});

	it("includes 'Not a git repository' when not in a git repo", () => {
		const config: AgentConfig = {
			name: "general-purpose",
			description: "Test",
			systemPrompt: GENERAL_PURPOSE_PROMPT,
			promptMode: "replace",
			extensions: true,
			skills: false,
		};
		const prompt = buildAgentPrompt(
			config,
			MINIMAL_CWD,
			MINIMAL_ENV,
			MAIN_AGENT_PARENT_PROMPT,
		);
		expect(prompt).toContain("Not a git repository");
	});
});

describe("prompts.ts — module-level invariants (sanity)", () => {
	it("GENERAL_PURPOSE_PROMPT declares sub-agent identity", () => {
		expect(GENERAL_PURPOSE_PROMPT).toMatch(/NOT the main agent/i);
		expect(GENERAL_PURPOSE_PROMPT).toMatch(/single-task helper/i);
	});

	it("EXPLORE_PROMPT declares read-only intent", () => {
		expect(EXPLORE_PROMPT).toMatch(/READ-ONLY/i);
	});

	it("PLAN_PROMPT declares read-only intent", () => {
		expect(PLAN_PROMPT).toMatch(/READ-ONLY/i);
	});

	it("DEVELOPER_PROMPT declares sub-agent identity", () => {
		expect(DEVELOPER_PROMPT).toMatch(/sub-agent/i);
		expect(DEVELOPER_PROMPT).toMatch(/RED.*GREEN.*REFACTOR/i);
	});
});
