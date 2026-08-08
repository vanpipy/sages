/**
 * test/abort-propagation.test.ts — GC-2026-043 T3 (Phase 6 integration)
 *
 * Proves that an aborted parent RunController propagates abort through
 * composed signals to child RunControllers within a single tick. This
 * is the runtime equivalent of `mergedSignal` and is the mechanism that
 * lets a parent agent's deadline kill a child sub-agent mid-turn.
 *
 * Pinned invariants (goal-GC-2026-043.yaml SC10, SC11):
 *   - SC10: when `parent.abortController.abort(reason)` fires, the
 *     composed `child.signal` becomes aborted within 1 turn (~100ms in
 *     test). No polling, no SDK loop required.
 *   - SC11: an A→B→C chain (each child constructed with the previous
 *     one's signal) aborts end-to-end. Deep signal inheritance works
 *     through `AbortSignal.any` composition.
 *   - Already-aborted parent signals cause the child constructor to
 *     short-circuit to an aborted state with the parent's reason
 *     preserved (run-controller.ts line ~190 — pre-aborted fast path).
 *
 * Anti-rule: no new npm dependencies (Node built-ins + vitest only).
 */

import { afterEach, describe, expect, it } from "vitest";
import { RunController, resolveRunConfig } from "../src/run-controller.js";

const created: RunController[] = [];
function track(rc: RunController): RunController {
	created.push(rc);
	return rc;
}

afterEach(() => {
	for (const rc of created) rc.cleanup();
	created.length = 0;
});

describe("abort propagation (Phase 6 / SC10, SC11)", () => {
	it("parent abort propagates to child via composed signal within 1 turn (SC10)", async () => {
		const parent = track(
			new RunController(undefined, resolveRunConfig("developer", {}, {})),
		);
		const child = track(
			new RunController(parent.signal, resolveRunConfig("explorer", {}, {})),
		);

		let childAbortFired = false;
		let childAbortReason: unknown;
		child.signal.addEventListener("abort", () => {
			childAbortFired = true;
			childAbortReason = child.signal.reason;
		});

		// Sanity: not aborted before trigger.
		expect(child.signal.aborted).toBe(false);

		// Trigger parent abort.
		parent.abortController.abort(new Error("parent deadline"));

		// Give the composed signal one microtask + one macrotask to fire.
		await new Promise((r) => setTimeout(r, 50));

		expect(child.signal.aborted).toBe(true);
		expect(childAbortFired).toBe(true);
		// Reason must flow from parent through AbortSignal.any.
		expect(childAbortReason).toBeInstanceOf(Error);
		if (childAbortReason instanceof Error) {
			expect(childAbortReason.message).toBe("parent deadline");
		}
	});

	it("A→B→C abort propagates through 3-level signal chain (SC11)", async () => {
		const A = track(
			new RunController(undefined, resolveRunConfig("developer", {}, {})),
		);
		const B = track(
			new RunController(A.signal, resolveRunConfig("explorer", {}, {})),
		);
		const C = track(
			new RunController(B.signal, resolveRunConfig("explorer", {}, {})),
		);

		let cAbortFired = false;
		C.signal.addEventListener("abort", () => {
			cAbortFired = true;
		});

		// Sanity: nothing aborted yet.
		expect(B.signal.aborted).toBe(false);
		expect(C.signal.aborted).toBe(false);

		// Abort at the top of the chain.
		A.abortController.abort(new Error("A deadline"));

		// One macrotask is enough — AbortSignal.any is synchronous on
		// upstream abort, so listeners on C should fire inside the same
		// tick. We give 100ms for absolute safety.
		await new Promise((r) => setTimeout(r, 100));

		expect(B.signal.aborted).toBe(true);
		expect(C.signal.aborted).toBe(true);
		expect(cAbortFired).toBe(true);
	});

	it("already-aborted parent causes child to short-circuit to aborted (constructor fast path)", async () => {
		const parentAc = new AbortController();
		parentAc.abort(new Error("pre-aborted parent"));

		const child = track(
			new RunController(parentAc.signal, resolveRunConfig("developer", {}, {})),
		);

		// No setTimeout — the constructor must abort the child synchronously
		// when the parent is already aborted (run-controller.ts line ~190).
		expect(child.signal.aborted).toBe(true);
		expect(child.signal.reason).toBeInstanceOf(Error);
		if (child.signal.reason instanceof Error) {
			expect(child.signal.reason.message).toBe("pre-aborted parent");
		}
	});

	it("signalForTool inherits run signal so a long-running tool sees the parent abort", async () => {
		// Confirms the tool-level signal composition: the bucket timer
		// signal is AbortSignal.any([runSignal, bucketTimer]), so when
		// the parent aborts, the tool signal aborts even if the bucket
		// timer hasn't fired yet.
		const parent = track(
			new RunController(undefined, resolveRunConfig("developer", {}, {})),
		);
		const child = track(
			new RunController(parent.signal, resolveRunConfig("explorer", {}, {})),
		);

		// 60s bucket so the timer does NOT fire — only run signal can.
		const toolSignal = child.signalForTool("other");
		expect(toolSignal.aborted).toBe(false);

		parent.abortController.abort(new Error("parent killed tool"));

		await new Promise((r) => setTimeout(r, 50));

		expect(toolSignal.aborted).toBe(true);
		// Reason flows through the AbortSignal.any chain.
		expect(toolSignal.reason).toBeInstanceOf(Error);
		if (toolSignal.reason instanceof Error) {
			expect(toolSignal.reason.message).toBe("parent killed tool");
		}
	});
});
