/**
 * Experiment 01: tool_result Detection
 *
 * Goal: Verify that we can intercept AFTER every tool execution
 *       and use the actual result as completion evidence.
 *
 * Key API: pi.on("tool_result", handler)
 *   - Fires after every tool call (write, edit, bash, etc.)
 *   - handler receives: toolName, toolCallId, input, content, details, isError
 *   - handler can MODIFY the result by returning {content?, details?, isError?}
 *
 * Source verification:
 *   pi-mono src/core/extensions/runner.ts:812-852 (emitToolResult)
 *   pi-mono src/core/agent-session.ts:438-444 (called from agent.afterToolCall)
 *   pi-mono examples/extensions/git-checkpoint.ts (real-world usage)
 *
 * Status: VERIFIED via source code reading. Type checks against @mariozechner/pi-coding-agent.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	console.log("[exp01] tool_result detection extension loaded");

	// ────────────────────────────────────────────────────────────
	// Test 1: Listen for write/edit completion
	// ────────────────────────────────────────────────────────────
	pi.on("tool_result", async (event, ctx) => {
		// Only track file mutations
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const path = (event.input as any).path as string;
		const isError = event.isError;

		console.log(
			`[exp01] ${event.toolName} completed: ${path} ` +
			`(isError=${isError}, content_len=${event.content?.length || 0})`,
		);

		// ────────────────────────────────────────────────────────
		// DEMO 1: Use file creation as state machine completion evidence
		// ────────────────────────────────────────────────────────
		if (!isError && path?.endsWith("draft.md")) {
			console.log(`[exp01] 🎯 STAGE COMPLETE EVIDENCE: draft.md written`);
			console.log(`[exp01]    → could transition FSM: design → review`);
			console.log(`[exp01]    → could inject: pi.sendUserMessage('review')`);
		}

		// ────────────────────────────────────────────────────────
		// DEMO 2: Modify the result content (add annotation to LLM)
		// ────────────────────────────────────────────────────────
		if (!isError && event.toolName === "edit") {
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: "\n[exp01 annotation: edit recorded at " + new Date().toISOString() + "]",
					},
				],
			};
		}

		return undefined;
	});

	// ────────────────────────────────────────────────────────────
	// Test 2: Track ALL tool completions for audit trail
	// ────────────────────────────────────────────────────────────
	pi.on("tool_result", async (event) => {
		console.log(
			`[exp01:audit] tool=${event.toolName} ` +
			`callId=${event.toolCallId.slice(0, 8)} ` +
			`isError=${event.isError}`,
		);
	});

	// ────────────────────────────────────────────────────────────
	// Test 3: Show the full event payload for a write
	// ────────────────────────────────────────────────────────────
	pi.on("tool_call", async (event) => {
		if (event.toolName === "write") {
			console.log(`[exp01:pre-tool] write to: ${(event.input as any).path}`);
		}
	});
}