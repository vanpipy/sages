/**
 * Experiment 02: tool_call Mutation
 *
 * Goal: Verify that we can intercept BEFORE tool execution
 *       and MUTATE the input arguments in place.
 *
 * Key API: pi.on("tool_call", handler)
 *   - Fires BEFORE every tool call
 *   - handler receives mutable `event.input`
 *   - Mutate event.input IN PLACE to patch args (per pi docs)
 *   - Return {block: true, reason: "..."} to PREVENT execution
 *
 * Source verification:
 *   pi-mono src/core/extensions/types.ts:980-984 (ToolCallEventResult)
 *     "event.input is mutable. Mutate it in place to patch tool arguments
 *      before execution. Later tool_call handlers see earlier mutations."
 *   pi-mono src/core/extensions/runner.ts:854-872 (emitToolCall)
 *   pi-mono examples/extensions/protected-paths.ts (block pattern)
 *
 * Status: VERIFIED via source code reading.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	console.log("[exp02] tool_call mutation extension loaded");

	// ────────────────────────────────────────────────────────────
	// Test 1: Force all writes under .sages/ to go to workspace
	// ────────────────────────────────────────────────────────────
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const input = event.input as { path?: string; content?: string };

		// DEMO: Path normalization — force .sages/* → .sages/workspace/*
		if (input.path?.startsWith(".sages/") && !input.path.startsWith(".sages/workspace/") && !input.path.startsWith(".sages/archive/")) {
			const newPath = input.path.replace(/^\.sages\//, ".sages/workspace/");
			console.log(`[exp02] 🔧 path normalization: ${input.path} → ${newPath}`);
			input.path = newPath; // ← in-place mutation
		}

		return undefined;
	});

	// ────────────────────────────────────────────────────────────
	// Test 2: Block dangerous commands (read-only mode for audit phase)
	// ────────────────────────────────────────────────────────────
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") {
			return undefined;
		}

		const command = (event.input as any).command as string;

		// DEMO: Block force-push even if LLM tries
		if (command.includes("git push --force") || command.includes("git push -f")) {
			console.log(`[exp02] 🚫 BLOCKED dangerous command: ${command}`);
			return {
				block: true,
				reason: "[exp02] Force push blocked by safety policy",
			};
		}

		return undefined;
	});

	// ────────────────────────────────────────────────────────────
	// Test 3: Inject helpful context into edit calls
	// ────────────────────────────────────────────────────────────
	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit") {
			const input = event.input as { path?: string; oldText?: string; newText?: string };
			// DEMO: Could enforce conventions like "every edit must include a comment"
			// For now, just log
			console.log(`[exp02:edit] path=${input.path} oldText_len=${input.oldText?.length || 0}`);
		}
		return undefined;
	});
}