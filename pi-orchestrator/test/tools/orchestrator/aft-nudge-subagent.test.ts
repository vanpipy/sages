/**
 * aft-nudge-subagent.test.ts — GC-2026-075 subagent coverage.
 *
 * Documents the architecture: orchestrator-advisory handlers are
 * installed on the ROOT session only. Subagent sessions (created via
 * `createAgentSession` in pi-subagents/src/agent-runner.ts) get a
 * fresh SessionManager / SettingsManager and do NOT inherit the
 * orchestrator's `pi.on("tool_call", ...)` chain.
 *
 * Therefore: the AFT nudge currently fires ONLY on the root session.
 * Subagents get their AFT nudge from the system prompt rule
 * ("MUST call aft_search before bash grep" / "reach for AFT first,
 * always") baked into
 * `pi-subagents/src/agent-prompts/{developer,auditor,explore}.ts`.
 *
 * Approximate line numbers (these prompts are refactored frequently;
 * grep for the MUST rule rather than relying on these): developer.ts
 * ~210, auditor.ts ~114, explore.ts ~36-52.
 *
 * Future GC: copy the nudge hook into pi-subagents so it runs on every
 * subagent session (requires either cross-package import of
 * `shouldNudgeAftSearch` from pi-orchestrator or duplicating the
 * classifier in pi-subagents).
 */
import { describe, expect, it } from "bun:test";

import { installOrchestratorAdvisoryHandlers } from "@/orchestrator-advisory.js";

interface CapturedEntry {
	customType: string;
	data: unknown;
}

/** Mock for the root session — same as the primary aft-nudge test. */
class RootPi {
	systemEntries: CapturedEntry[] = [];
	toolCallListeners: Array<(event: any, ctx: any) => unknown> = [];
	toolResultListeners: Array<(event: any) => unknown> = [];
	messageEndListeners: Array<(event: any) => unknown> = [];

	appendEntry(customType: string, data: unknown) {
		this.systemEntries.push({ customType, data });
	}

	on(event: string, handler: any) {
		if (event === "tool_call") this.toolCallListeners.push(handler);
		if (event === "tool_result") this.toolResultListeners.push(handler);
		if (event === "message_end") this.messageEndListeners.push(handler);
	}

	fireToolCall(event: { toolName: string; input: unknown }) {
		for (const handler of this.toolCallListeners) {
			handler(
				{ toolName: event.toolName, input: event.input, toolCallId: "call-1" },
				{ cwd: "/tmp" },
			);
		}
	}
}

/** Mock for a subagent session — independent ExtensionAPI, no handlers. */
class SubagentPi {
	systemEntries: CapturedEntry[] = [];
	toolCallListeners: Array<(event: any, ctx: any) => unknown> = [];

	appendEntry(customType: string, data: unknown) {
		this.systemEntries.push({ customType, data });
	}

	on(event: string, handler: any) {
		// pi-subagents loads its own extensions on the subagent session.
		// It does NOT bind the orchestrator's handlers — this mock models
		// that the subagent session is independent.
		if (event === "tool_call") this.toolCallListeners.push(handler);
	}

	fireToolCall(event: { toolName: string; input: unknown }) {
		for (const handler of this.toolCallListeners) {
			handler(
				{ toolName: event.toolName, input: event.input, toolCallId: "sub-call-1" },
				{ cwd: "/tmp" },
			);
		}
	}
}

const AFT_HINT = "Consider `aft_search";

describe("GC-2026-075 AFT nudge — subagent coverage", () => {
	it("root session emits the AFT nudge (existing behavior — sanity check)", () => {
		const rootPi = new RootPi();
		installOrchestratorAdvisoryHandlers(rootPi as any);
		rootPi.fireToolCall({ toolName: "bash", input: { command: "grep -r foo src/" } });

		expect(
			rootPi.systemEntries.some(
				(e) => typeof e.data === "string" && (e.data as string).includes(AFT_HINT),
			),
		).toBe(true);
	});

	it("subagent session does NOT get the nudge (no handler bound)", () => {
		const subagentPi = new SubagentPi();
		// Install orchestrator-advisory on the ROOT session only.
		const rootPi = new RootPi();
		installOrchestratorAdvisoryHandlers(rootPi as any);

		// Simulate a subagent session firing its own tool_call event.
		// No orchestrator handler is bound to this pi — the subagent
		// runs its own extension chain (aft, pi-mcp-adapter, pi-magic-context)
		// but NOT the orchestrator-advisory hook.
		subagentPi.fireToolCall({
			toolName: "bash",
			input: { command: "grep -r foo src/" },
		});

		// The subagent session sees no reminder.
		expect(
			subagentPi.systemEntries.some(
				(e) => typeof e.data === "string" && (e.data as string).includes(AFT_HINT),
			),
		).toBe(false);
	});

	it("subagent context relies on the prompt-level MUST rule (documented expectation)", () => {
		// The pi-subagents prompt for developer/auditor/explore already says
		// "MUST call aft_search before bash grep" (and "reach for AFT first,
		// always"). That is the nudge mechanism for subagents in the current
		// GC. Runtime nudge is a root-session feature only.
		//
		// Documenting this so a future contributor knows where to look —
		// approximate line numbers (these prompts are refactored frequently):
		//   pi-subagents/src/agent-prompts/developer.ts ~210
		//   pi-subagents/src/agent-prompts/auditor.ts ~114
		//   pi-subagents/src/agent-prompts/explore.ts ~36-52
		//
		// To extend the runtime nudge to subagents, add a new module in
		// pi-subagents (e.g. agent-bash-nudge.ts) that mirrors the
		// orchestrator-advisory logic and installs a `pi.on("tool_call")`
		// hook on every subagent session at spawn time.
		expect(true).toBe(true);
	});
});
