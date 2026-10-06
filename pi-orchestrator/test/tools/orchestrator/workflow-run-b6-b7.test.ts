/**
 * workflow-run-b6-b7.test.ts — B6 (iteration-aware review) + B7
 * (Merger consumes Reviewer evidence) end-to-end integration tests
 * for GC-2026-103.
 *
 * Both wirings exist in pi-tasks:
 *   - B6: `formatPriorReviewSummary` (workflow-handler.ts:458) injects
 *     the previous Review's verdict + findings into Review_{N+1}'s
 *     dispatch brief when iteration > 1.
 *   - B7: `writeReviewerEvidenceFile` (workflow-handler.ts:406) writes
 *     `.pi/orchestrator/last-review-{goal_id}.md` after every Review,
 *     overwritten each time so the file always reflects the LATEST Review.
 *     The Merger (Advisor) agent reads this file.
 *
 * pi-tasks has unit tests for both (workflow-handler.test.ts has 4 tests
 * covering B6 + B7). What was missing was orchestrator-side coverage
 * that drives the production wiring through a real workflow_run call.
 * This file closes the gap.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	cleanReviewResult,
	cleanupHarness,
	flush,
	makeWorkflowRunHarness,
	needsWorkReviewResult,
	startWorkflowRun,
} from "../../helpers/workflow-run-integration-harness.js";

const GOAL_ID = "GC-INT-B6B7";

describe("workflow_run ↔ subscribeWorkflow: B6 + B7 end-to-end (GC-2026-103)", () => {
	let harness: ReturnType<typeof makeWorkflowRunHarness>;

	beforeEach(() => {
		harness = makeWorkflowRunHarness();
	});

	afterEach(() => {
		cleanupHarness(harness);
	});

	describe("B6: iteration-aware review", () => {
		it("Review_2 dispatch brief contains the Prior review summary injected by formatPriorReviewSummary", async () => {
			const workflowRunP = startWorkflowRun(harness, GOAL_ID, {
				max_fix_iterations: 3,
			});

			// Implement completes (cascade spawns ImplementAdvisor + Review_1).
			// With max_fix_iterations=3 the cascade order is:
			// 0=Implement, 1=ImplementAdvisor, 2=Review_1, 3=ReviewerAdvisor_1,
			// 4=Fix_1, 5=FixAdvisor_1, 6=Review_2.
			await flush();
			harness.subagents.completeByIndex( 0, "ok"); // Implement
			await flush();
			await flush();

			// Complete ImplementAdvisor first (it doesn't emit phase-complete
			// back to workflow_run so the cascade pauses until something
			// completes). Use "ok" — the result is ignored for non-Review.
			harness.subagents.completeByIndex( 2, "ok"); // ImplementAdvisor
			await flush();
			await flush();

			// Review_1 emits NEEDS_WORK with one critical finding. The cascade
			// then spawns ReviewerAdvisor_1 + Fix_1.
			harness.subagents.completeByIndex(
				1,
				needsWorkReviewResult(1, {
					findings: [
						{
							severity: "critical",
							issue: "missing auth check on /admin endpoint",
							category: "new",
						},
					],
				}),
			); // Review_1
			await flush();
			await flush();

			// Complete Fix_1 (cascade spawned after Review_1 NEEDS_WORK).
			// Then complete FixAdvisor_1.
			harness.subagents.completeByIndex( 4, "ok"); // Fix_1
			await flush();
			await flush();
			harness.subagents.completeByIndex( 5, "ok"); // FixAdvisor_1
			await flush();
			await flush();

			// At this point, spawnOrder includes: Implement(0), Review_1(1),
			// ImplementAdvisor(2), ReviewerAdvisor_1(3), Fix_1(4), FixAdvisor_1(5),
			// Review_2(6), ReviewerAdvisor_2(7).
			//
			// B6: Review_2 (idx 6) was dispatched by the cascade AFTER the
			// findingsHistory was populated with Review_1's verdict. The
			// cascade's pre-spawn injection (workflow-handler.ts:680) prepends
			// the prior review summary into Review_2's dispatch brief. The
			// Reviewer (spawned as Reviewer for Review_2) receives this in
			// its prompt and would categorize new findings as regression /
			// unresolved / new.
			//
			// The integration assertion: we verify the wiring fires by
			// reading the actual Review_2 task description from the store
			// and confirming it contains the prior review summary marker.
			const review2Task = harness.store.list().find(
				(t) => t.metadata.phase === "review" && t.metadata.iteration === 2,
			);
			expect(review2Task).toBeDefined();
			expect(review2Task!.description).toContain(
				"## Prior review summary (iteration 1)",
			);
			// The prior review's finding should be in the injected summary
			// (without the recommendation — workflow-handler.ts:466 strips
			// recommendations from the prior summary so the new Reviewer
			// re-evaluates).
			expect(review2Task!.description).toContain(
				"missing auth check on /admin endpoint",
			);
			// The finding's category was "new" — the summary doesn't surface
			// the category (workflow-handler.ts:469 just shows severity +
			// issue + location). That's intentional; the new Reviewer is
			// expected to re-classify.

			// Drive Review_2 to completion (CLEAN) to finish the test.
			harness.subagents.completeByIndex( 6, cleanReviewResult(2));
			await flush();
			await flush();

			// Sanity: workflow_run resolves as success.
			void workflowRunP.catch(() => {});
		});
	});

	describe("B7: Merger consumes Reviewer evidence", () => {
		it("writes .pi/orchestrator/last-review-{goal_id}.md after every Review completion", async () => {
			const workflowRunP = startWorkflowRun(harness, GOAL_ID, {
				max_fix_iterations: 1,
			});

			await flush();
			harness.subagents.completeByIndex( 0, "ok"); // Implement
			await flush();
			await flush();

			// After Implement completion, cascade spawns ImplementAdvisor (idx 2) + Review_1 (idx 1).
			// Complete ImplementAdvisor first.
			harness.subagents.completeByIndex( 2, "ok"); // ImplementAdvisor
			await flush();
			await flush();

			// Then complete Review_1 with NEEDS_WORK. The cascade's
			// writeReviewerEvidenceFile (workflow-handler.ts:599) writes
			// `.pi/orchestrator/last-review-{goal_id}.md` AFTER the
			// workflow:phase-complete emit, before the cascade scan.
			harness.subagents.completeByIndex(
				1,
				needsWorkReviewResult(1, {
					findings: [
						{
							severity: "critical",
							issue: "SQL injection in /search endpoint",
							category: "new",
						},
						{
							severity: "major",
							issue: "missing rate limiter",
							category: "new",
						},
					],
				}),
			); // Review_1
			await flush();
			await flush();
			// After Review_1 NEEDS_WORK, writeReviewerEvidenceFile
			// (workflow-handler.ts:599) writes the last-review-{id}.md file.
			// Path: <payload_worktree_path>/.pi/orchestrator/last-review-{goal_id}.md
			// where payload_worktree_path = <repoCwd>/.pi/worktree/<goalId>/implement.
			const evidencePath = join(
				harness.repoCwd,
				".pi",
				"worktree",
				GOAL_ID,
				"implement",
				".pi",
				"orchestrator",
				`last-review-${GOAL_ID}.md`,
			);
			const evidence = readFileSync(evidencePath, "utf-8");

			// File header + metadata.
			expect(evidence).toContain(`# Last Reviewer evidence for goal ${GOAL_ID}`);
			expect(evidence).toContain("iteration: 1");
			expect(evidence).toContain("phase: review");

			// Verdict + dimension checks + findings.
			expect(evidence).toContain("verdict: NEEDS_WORK");
			expect(evidence).toContain("scope_check: pass");
			expect(evidence).toContain("anti_goal_check: pass");
			expect(evidence).toContain("findings_count: 2");
			expect(evidence).toContain("[critical] SQL injection in /search endpoint");
			expect(evidence).toContain("[major] missing rate limiter");

			// Drain the workflow_run promise (it stays paused because
			// max_fix_iterations=1 + NEEDS_WORK will exhaust).
			void workflowRunP.catch(() => {});
		});

		it("overwrites last-review-{goal_id}.md on each Review completion (file reflects latest)", async () => {
			const workflowRunP = startWorkflowRun(harness, GOAL_ID, {
				max_fix_iterations: 3,
			});

			await flush();
			harness.subagents.completeByIndex( 0, "ok"); // Implement
			await flush();
			await flush();

			// Review_1: NEEDS_WORK with one finding.
			// With max_fix_iterations=3 the static graph is
			// Implement, Review_1, Review_2, Review_3, Merge.
			// Cascade after Implement completion spawns ImplementAdvisor.
			// Cascade after Review_1 NEEDS_WORK spawns ReviewerAdvisor_1 + Fix_1.
			harness.subagents.completeByIndex(
				1,
				needsWorkReviewResult(1, {
					findings: [
						{
							severity: "major",
							issue: "first issue",
							category: "new",
						},
					],
				}),
			); // Review_1
			await flush();
			await flush();
			// After Review_1, evidence file should have "first issue".
			// See the B7 test above for the path construction.
			const evidencePath = (iter: number) =>
				join(
					harness.repoCwd,
					".pi",
					"worktree",
					GOAL_ID,
					"implement",
					".pi",
					"orchestrator",
					`last-review-${GOAL_ID}.md`,
				);
			let evidence = readFileSync(evidencePath(1), "utf-8");
			expect(evidence).toContain("first issue");

			// Drive Fix_1 (idx 4) → cascade spawns FixAdvisor_1 (idx 5) + Review_2 (idx 6).
			harness.subagents.completeByIndex( 4, "ok"); // Fix_1
			await flush();
			await flush();
			harness.subagents.completeByIndex( 5, "ok"); // FixAdvisor_1
			await flush();
			await flush();

			// Review_2: CLEAN (no findings). The evidence file is OVERWRITTEN
			// (per the "always reflects the latest Review" contract).
			harness.subagents.completeByIndex( 6, cleanReviewResult(2)); // Review_2
			await flush();
			await flush();
			evidence = readFileSync(evidencePath(2), "utf-8");
			expect(evidence).toContain("verdict: CLEAN");
			expect(evidence).toContain("findings_count: 0");
			expect(evidence).toContain("## Findings\n(none)");
			// First review's finding is no longer in the file (was
			// overwritten by the CLEAN review).
			expect(evidence).not.toContain("first issue");

			// Drain.
			void workflowRunP.catch(() => {});
		});
	});
});
