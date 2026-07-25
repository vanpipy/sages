/**
 * pi-evaluator/test/lib/jsonl-reader.test.ts
 *
 * Tests for src/lib/jsonl-reader.ts (P1.b).
 *
 * Strategy: exercise readSession + readSessionIter against
 * fixtures/workflow-good/.pi/orchestrator/sessions/session.jsonl (positive path),
 * verify both pi-format and legacy-format messages parse, verify malformed lines
 * are tolerated with error_count > 0, and verify readSessionIter yields the same
 * results. At least 6 test cases.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import {
	readSession,
	readSessionIter,
} from "../../src/lib/jsonl-reader.ts";
import type { SessionEntry } from "../../src/types.ts";

const SESSION_FIXTURE = `${import.meta.dir}/../../fixtures/workflow-good/.pi/orchestrator/sessions/session.jsonl`;

describe("jsonl-reader", () => {
	let fixtureEntries: SessionEntry[];
	let fixtureErrorCount: number;

	beforeAll(async () => {
		const result = await readSession(SESSION_FIXTURE);
		fixtureEntries = result.entries;
		fixtureErrorCount = result.error_count;
	});

	test("readSession returns N entries from the fixture (14 lines)", async () => {
		expect(fixtureEntries.length).toBe(14);
		expect(fixtureErrorCount).toBe(0);
	});

	test("readSession parses session_start and session_end entries", () => {
		const start = fixtureEntries.find((e) => e.type === "session_start");
		const end = fixtureEntries.find((e) => e.type === "session_end");
		expect(start).toBeDefined();
		expect(end).toBeDefined();
		expect(start?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("readSession parses pi-format message with nested toolCall", () => {
		// Find the message that contains a goal_contract_create toolCall.
		const goalCreate = fixtureEntries.find(
			(e) =>
				e.type === "message" &&
				e.message?.content.some(
					(b) => b.type === "toolCall" && b.name === "goal_contract_create",
				),
		);
		expect(goalCreate).toBeDefined();
		expect(goalCreate?.type).toBe("message");
		if (goalCreate?.type === "message" && goalCreate.message) {
			expect(goalCreate.message.role).toBe("assistant");
			const toolCall = goalCreate.message.content.find(
				(b) => b.type === "toolCall",
			);
			expect(toolCall).toBeDefined();
			if (toolCall && toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("goal_contract_create");
				expect(toolCall.arguments).toBeDefined();
			}
		}
	});

	test("readSession parses legacy-format message with top-level content field", () => {
		// The fixture's last message line has no nested `message` field — only
		// a top-level `content` string. That is the legacy format.
		let found = false;
		for (const e of fixtureEntries) {
			if (e.type !== "message" || !e.message) continue;
			if (e.message.role !== "user") continue;
			for (const b of e.message.content) {
				if (
					b.type === "text" &&
					typeof b.content === "string" &&
					b.content.includes("legacy format")
				) {
					found = true;
					break;
				}
			}
			if (found) break;
		}
		expect(found).toBe(true);
	});

	test("readSession parses model_change entries", () => {
		const modelChange = fixtureEntries.find((e) => e.type === "model_change");
		expect(modelChange).toBeDefined();
		if (modelChange?.type === "model_change") {
			expect(modelChange.provider).toBe("deepseek");
			expect(modelChange.model_id).toBe("deepseek-chat");
		}
	});

	test("readSession tolerates malformed lines (error_count > 0)", async () => {
		// Write a temp session.jsonl with one valid line + one malformed line.
		const tmpPath = `/tmp/pi-eval-test-bad-jsonl-${Date.now()}.jsonl`;
		await Bun.write(
			tmpPath,
			[
				JSON.stringify({
					type: "message",
					timestamp: "2026-07-25T12:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "hi" }] },
				}),
				"{this is not valid json at all",
				JSON.stringify({
					type: "message",
					timestamp: "2026-07-25T12:00:05.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
					},
				}),
			].join("\n"),
		);
		const result = await readSession(tmpPath);
		expect(result.entries).toHaveLength(2);
		expect(result.error_count).toBe(1);
		expect(result.line_count).toBe(3);
		await Bun.write(tmpPath, ""); // cleanup
	});

	test("readSessionIter yields the same entries as readSession", async () => {
		const iterEntries: SessionEntry[] = [];
		let iterErrors = 0;
		let lastLineCount = 0;
		for await (const item of readSessionIter(SESSION_FIXTURE)) {
			if (item.kind === "entry") {
				iterEntries.push(item.entry);
				lastLineCount = item.line_count;
			} else {
				iterErrors += 1;
				lastLineCount = item.line_count;
			}
		}
		expect(iterEntries.length).toBe(fixtureEntries.length);
		expect(iterErrors).toBe(0);
		expect(lastLineCount).toBe(fixtureEntries.length);
	});

	test("readSession throws when the file does not exist", async () => {
		await expect(readSession("/tmp/no-such-session-jsonl.jsonl")).rejects.toThrow(
			/session\.jsonl/,
		);
	});

	test("readSession parses toolCall arguments from the pi-format entry", () => {
		const goalCreate = fixtureEntries.find(
			(e) =>
				e.type === "message" &&
				e.message?.content.some(
					(b) => b.type === "toolCall" && b.name === "goal_contract_create",
				),
		);
		expect(goalCreate).toBeDefined();
		if (goalCreate?.type !== "message" || !goalCreate.message) return;
		const tc = goalCreate.message.content.find(
			(b) => b.type === "toolCall",
		);
		if (tc?.type !== "toolCall") return;
		expect(tc.arguments).toBeDefined();
		const args = tc.arguments as Record<string, unknown>;
		expect(args["id"]).toBe("GC-good");
		expect(args["success_criteria_count"]).toBe(3);
	});

	test("readSession parses toolResult entries with is_error=false", () => {
		const audit = fixtureEntries.find(
			(e) =>
				e.type === "message" &&
				e.message?.content.some(
					(b) => b.type === "toolResult" && b.name === "orchestrator_audit",
				),
		);
		expect(audit).toBeDefined();
		if (audit?.type !== "message" || !audit.message) return;
		const tr = audit.message.content.find(
			(b) => b.type === "toolResult",
		);
		if (tr?.type !== "toolResult") return;
		expect(tr.name).toBe("orchestrator_audit");
		expect(tr.is_error).toBe(false);
		expect(String(tr.content)).toContain("CERTIFIED");
	});
});