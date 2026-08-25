/**
 * Tests for the profile applier — the conductor's three pi hooks.
 *
 *   1. installCapabilityFilter — block tools not in profile.tools
 *   2. installPromptComposer   — prepend preset template + render {{var}} / {{#if}}
 *   3. installReminderInjector — fire soft_mode_reminder on first bash
 *
 * Uses a mock ExtensionAPI (no real pi runtime needed).
 */

import { describe, it, expect } from "bun:test";

import { applyProfile } from "@/profile/applier.js";
import { STANDARD_PROFILE, type Profile } from "@/profile/types.js";

function makeMockPi() {
	const handlers: Record<string, Array<(event: any) => any>> = {};
	const appendEntries: Array<{ type: string; data: any }> = [];
	return {
		on(event: string, handler: (e: any) => any) {
			(handlers[event] ??= []).push(handler);
		},
		appendEntry(type: string, data: any) {
			appendEntries.push({ type, data });
		},
		/**
		 * Invoke ALL registered handlers for the event. Each handler may
		 * mutate `payload` (e.g., `before_agent_start` mutates systemPrompt)
		 * or return a `block` directive. We return the (mutated) payload
		 * so tests can inspect the final state, and the FIRST non-undefined
		 * handler return is preserved as the "block" signal.
		 */
		fire(event: string, payload: any): any {
			let block: any = undefined;
			for (const h of handlers[event] ?? []) {
				const r = h(payload);
				if (r !== undefined && block === undefined) block = r;
			}
			// If a block was returned, prefer it; otherwise return the mutated payload.
			return block ?? payload;
		},
		entries() {
			return appendEntries;
		},
	};
}

describe("installCapabilityFilter (via applyProfile)", () => {
	it("blocks tools not in profile.tools", () => {
		const pi = makeMockPi();
		const profile: Profile = {
			...STANDARD_PROFILE,
			tools: { goal_contract_create: { enabled: true } },
		};
		applyProfile(pi as any, profile);
		const result = pi.fire("tool_call", { toolName: "dag_synthesize" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("dag_synthesize");
	});

	it("allows tools listed in profile.tools", () => {
		const pi = makeMockPi();
		applyProfile(pi as any, STANDARD_PROFILE);
		const result = pi.fire("tool_call", { toolName: "goal_contract_create" });
		expect(result?.block).toBeFalsy();
	});

	it("allows baseline tools regardless of profile.tools", () => {
		const pi = makeMockPi();
		const profile: Profile = {
			...STANDARD_PROFILE,
			tools: {},
		};
		applyProfile(pi as any, profile);
		for (const tool of ["bash", "read", "edit", "write", "grep", "find", "ls"]) {
			const result = pi.fire("tool_call", { toolName: tool });
			expect(result?.block).toBeFalsy();
		}
	});

	it("non-string toolName is ignored (no block)", () => {
		const pi = makeMockPi();
		applyProfile(pi as any, STANDARD_PROFILE);
		const result = pi.fire("tool_call", { toolName: undefined });
		expect(result?.block).toBeFalsy();
	});
});

describe("installPromptComposer (via applyProfile)", () => {
	it("renders with-both when both aft and magic-context are installed", () => {
		const pi = makeMockPi();
		applyProfile(pi as any, STANDARD_PROFILE);
		const result = pi.fire("before_agent_start", { systemPrompt: "" });
		expect(result.systemPrompt).toContain("AFT");
		expect(result.systemPrompt).toContain("Magic Context");
	});

	it("renders standard when neither aft nor magic-context is installed", () => {
		const pi = makeMockPi();
		const profile: Profile = {
			...STANDARD_PROFILE,
			extensions: { installed: ["@sages/pi-subagents"] },
		};
		applyProfile(pi as any, profile);
		const result = pi.fire("before_agent_start", { systemPrompt: "" });
		expect(result.systemPrompt).toContain("Subagents");
	});

	it("renders with-aft when only aft is installed", () => {
		const pi = makeMockPi();
		const profile: Profile = {
			...STANDARD_PROFILE,
			extensions: { installed: ["@cortexkit/aft-pi"] },
		};
		applyProfile(pi as any, profile);
		const result = pi.fire("before_agent_start", { systemPrompt: "" });
		expect(result.systemPrompt).toContain("AFT");
		expect(result.systemPrompt).not.toContain("Magic Context");
	});

	it("expands {{#if loaded.X}} blocks when X is installed", () => {
		const pi = makeMockPi();
		applyProfile(pi as any, STANDARD_PROFILE);
		const result = pi.fire("before_agent_start", { systemPrompt: "" });
		expect(result.systemPrompt).toContain("DAG workflow");
		// {{#if}} markers should be stripped (not remain in output)
		expect(result.systemPrompt).not.toContain("{{#if");
	});

	it("respects explicit prompts.template (overrides auto)", () => {
		const pi = makeMockPi();
		const profile: Profile = {
			...STANDARD_PROFILE,
			prompts: { template: "minimal" },
		};
		applyProfile(pi as any, profile);
		const result = pi.fire("before_agent_start", { systemPrompt: "" });
		expect(result.systemPrompt).toContain("minimal");
		expect(result.systemPrompt).not.toContain("AFT");
	});
});

describe("installReminderInjector (via applyProfile)", () => {
	it("fires once on first bash call", () => {
		const pi = makeMockPi();
		applyProfile(pi as any, STANDARD_PROFILE);
		pi.fire("tool_call", { toolName: "bash" });
		expect(pi.entries().length).toBe(1);
		expect(pi.entries()[0].data).toContain("SOFT MODE");
	});

	it("does not fire on subsequent bash calls", () => {
		const pi = makeMockPi();
		applyProfile(pi as any, STANDARD_PROFILE);
		pi.fire("tool_call", { toolName: "bash" });
		pi.fire("tool_call", { toolName: "bash" });
		pi.fire("tool_call", { toolName: "bash" });
		expect(pi.entries().length).toBe(1);
	});

	it("does not fire on non-bash tool calls", () => {
		const pi = makeMockPi();
		applyProfile(pi as any, STANDARD_PROFILE);
		pi.fire("tool_call", { toolName: "read" });
		pi.fire("tool_call", { toolName: "edit" });
		expect(pi.entries().length).toBe(0);
	});

	it("does nothing if soft_mode_reminder is empty", () => {
		const pi = makeMockPi();
		const profile: Profile = {
			...STANDARD_PROFILE,
			policies: { soft_mode_reminder: "" },
		};
		applyProfile(pi as any, profile);
		pi.fire("tool_call", { toolName: "bash" });
		// Empty reminder → no entry at all (handler is not installed)
		expect(pi.entries().length).toBe(0);
	});
});

describe("applyProfile integration", () => {
	it("installs all 3 hooks when policy has soft_mode_reminder", () => {
		const pi = makeMockPi();
		applyProfile(pi as any, STANDARD_PROFILE);
		// Trigger each hook path
		pi.fire("tool_call", { toolName: "bash" });
		pi.fire("before_agent_start", { systemPrompt: "" });
		const result = pi.fire("tool_call", { toolName: "Agent" });
		expect(result?.block).toBeFalsy(); // Agent is in STANDARD_PROFILE.tools
		expect(pi.entries().length).toBeGreaterThan(0);
	});
});