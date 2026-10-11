/**
 * demo-task-feeding.ts — manual driver for the Task Feeding loop.
 *
 * Walks the orchestrator's sole-creator / sole-consumer role end-to-end
 * on a real `TaskStore`, simulating the executor step in-process so you
 * can see the loop work without pi's RPC stack. Run with:
 *
 *   cd pi-orchestrator && bun run scripts/demo-task-feeding.ts
 *
 * What it shows:
 *   1. The orchestrator materializes a 2-phase plan (Implement + Review)
 *      with `blockedBy` wired in both directions.
 *   2. A simulated Developer executor runs Implement and "completes"
 *      with a result; the orchestrator consumes it (no verdict — Developer
 *      contract).
 *   3. A simulated Reviewer executor runs Review and "completes" with
 *      `verdict: CLEAN`; the orchestrator consumes it and the parsed
 *      verdict + verdict-tailored follow-up suggestion are printed.
 *   4. The audit trail — `metadata.consumed = true`,
 *    `metadata.consumed_at = <ts>` — is recorded on the store.
 *
 * The tempdir under `$TMPDIR/pi-orch-demo-<rand>` is the same path the
 * orchestrator's `orchestratorProjectTaskFile(cwd)` resolver would
 * produce in production, so the layout is the real one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard } from "../src/task-board.js";
import { TaskStore } from "@sages/pi-tasks/task-store";

const cwd = mkdtempSync(join(tmpdir(), "pi-orch-demo-"));
try {
	const board = new TaskBoard({ cwd });
	// We use the same store the board composes so the simulation can
	// write directly. The board doesn't expose its store; in production
	// the executor's `subagents:completed` event would write via the
	// cross-extension RPC. Here we go through the file path so the
	// demo is self-contained.
	const store = new TaskStore(
		join(cwd, ".pi", "orchestrator", "tasks", "tasks.json"),
	);
	// Re-create the board with the explicit store so we can drive both
	// sides through the same TaskStore instance.
	const board2 = new TaskBoard({ cwd, store });

	console.log("=== Task Feeding demo ===");
	console.log("cwd:", cwd);
	console.log("");

	console.log("--- 1. CREATE — board.materializePlan ---");
	const plan = board2.materializePlan({
		intent: "Demo: add a /login endpoint",
		phases: [
			{ subject: "Implement", agentType: "Developer" },
			{
				subject: "Review",
				agentType: "Reviewer",
				blockedBy: ["Implement"],
			},
		],
	});
	console.log(JSON.stringify(plan, null, 2));
	console.log("");

	const implement = plan.tasks.find((t) => t.subject === "Implement")!;
	const review = plan.tasks.find((t) => t.subject === "Review")!;

	console.log("--- 2. SIMULATE Implement executor ---");
	store.update(implement.id, {
		status: "completed",
		metadata: {
			result:
				"Added POST /login with bcrypt + JWT. All unit tests pass.",
		},
	});
	console.log("Implement completed.\n");

	console.log("--- 3. CONSUME Implement (Developer, no verdict) ---");
	const implOut = board2.consume(implement.id);
	console.log(JSON.stringify(implOut, null, 2));
	console.log("");

	console.log("--- 4. SIMULATE Review executor ---");
	store.update(review.id, {
		status: "completed",
		metadata: {
			result: [
				"Read every file. The implementation is solid.",
				"",
				"verdict: CLEAN",
			].join("\n"),
		},
	});
	console.log("Review completed with verdict: CLEAN.\n");

	console.log("--- 5. CONSUME Review (Reviewer, verdict + follow-up) ---");
	const reviewOut = board2.consume(review.id);
	console.log(JSON.stringify(reviewOut, null, 2));
	console.log("");

	console.log("--- 6. AUDIT TRAIL — board.list() ---");
	const all = board2.list();
	for (const t of all) {
		console.log(
			`#${t.id} ${t.subject} [${t.status}] agentType=${t.metadata?.agentType ?? "?"}` +
				` consumed=${t.metadata?.consumed ?? false}` +
				` consumed_at=${t.metadata?.consumed_at ?? "-"}`,
		);
	}
} finally {
	rmSync(cwd, { recursive: true, force: true });
}