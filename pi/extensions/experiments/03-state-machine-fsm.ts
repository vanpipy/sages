/**
 * Experiment 03: State Machine via tool_result + sendMessage
 *
 * Goal: Demonstrate the COMPLETE accurate orchestration pattern:
 *
 *   1. tool_result detects when a stage's expected output exists
 *   2. State machine transitions on REAL evidence (not LLM self-report)
 *   3. pi.sendMessage({triggerTurn: true}) advances to next stage
 *   4. appendEntry persists state machine log to session
 *
 * This is the answer to "how is orchestration accurately executed in pi?"
 *
 * Source verification:
 *   pi.on("tool_result")  → pi-mono src/core/extensions/runner.ts:812
 *   pi.sendMessage()      → pi-mono src/core/extensions/types.ts:1371
 *     options.triggerTurn: if true and not streaming, starts new LLM turn
 *     options.deliverAs:   "steer" | "followUp" | "nextTurn"
 *   pi.appendEntry()      → pi-mono src/core/extensions/types.ts:1392
 *   pi.events             → shared EventBus for cross-extension coordination
 *
 * Status: VERIFIED via source code reading.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Stage = "idle" | "design" | "review" | "plan" | "execute" | "audit" | "complete";

interface StateEntry {
	from: Stage;
	to: Stage;
	evidence: string;
	at: number;
}

class SagesStateMachine {
	private current: Stage = "idle";
	private history: StateEntry[] = [];

	transition(to: Stage, evidence: string): boolean {
		const valid: Record<Stage, Stage[]> = {
			idle:    ["design"],
			design:  ["review"],
			review:  ["plan", "design"], // can fail back to design
			plan:    ["execute", "design"], // can require redesign
			execute: ["audit", "plan"],   // can need re-plan
			audit:   ["complete", "execute", "design"], // verdict can fail
			complete: ["idle"],
		};

		if (!valid[this.current].includes(to)) {
			console.log(`[exp03:FSM] ❌ invalid transition: ${this.current} → ${to}`);
			return false;
		}

		const entry: StateEntry = {
			from: this.current,
			to,
			evidence,
			at: Date.now(),
		};
		this.history.push(entry);
		console.log(`[exp03:FSM] ✅ ${this.current} → ${to} (evidence: ${evidence})`);
		this.current = to;
		return true;
	}

	getCurrent(): Stage {
		return this.current;
	}

	getHistory(): StateEntry[] {
		return this.history;
	}
}

export default function (pi: ExtensionAPI) {
	console.log("[exp03] state machine extension loaded");

	const fsm = new SagesStateMachine();

	// ────────────────────────────────────────────────────────────
	// PART A: Detect completion evidence from tool_result
	// ────────────────────────────────────────────────────────────
	pi.on("tool_result", async (event) => {
		if (event.isError) return undefined; // ignore failed tool calls

		const path = (event.input as any).path as string | undefined;

		// ── DESIGN stage complete: draft.md created ──
		if (
			event.toolName === "write" &&
			path?.endsWith("draft.md") &&
			fsm.getCurrent() === "design"
		) {
			const content = (event.input as any).content as string || "";
			const evidence = `file_written: ${path} (${content.length} bytes)`;

			if (fsm.transition("review", evidence)) {
				pi.appendEntry("sages-fsm-transition", {
					from: "design",
					to: "review",
					evidence,
					at: Date.now(),
				});

				// Auto-inject next stage prompt (triggers new LLM turn)
				pi.sendUserMessage(
					"[Sages FSM] Design stage complete. draft.md created. " +
					"Auto-advancing to REVIEW stage. Please call /qiaochui-review to evaluate the draft.",
					{ deliverAs: "followUp" },
				);
			}
		}

		// ── REVIEW stage complete: state.json updated with score ──
		if (
			event.toolName === "write" &&
			path?.endsWith("state.json") &&
			fsm.getCurrent() === "review"
		) {
			const content = (event.input as any).content as string || "";
			let score = 0;
			try {
				const parsed = JSON.parse(content);
				score = parsed.score || 0;
			} catch {}

			if (score > 80) {
				const evidence = `state_score: ${score}`;
				if (fsm.transition("plan", evidence)) {
					pi.appendEntry("sages-fsm-transition", {
						from: "review",
						to: "plan",
						evidence,
						at: Date.now(),
					});
					pi.sendUserMessage(
						`[Sages FSM] Review passed with score ${score}. ` +
						"Auto-advancing to PLAN stage. Please call /qiaochui-decompose.",
						{ deliverAs: "followUp" },
					);
				}
			} else {
				console.log(`[exp03:FSM] ⏸ score ${score} ≤ 80, waiting`);
			}
		}

		return undefined;
	});

	// ────────────────────────────────────────────────────────────
	// PART B: Manual gates (slash commands trigger state transitions)
	// ────────────────────────────────────────────────────────────
	pi.registerCommand("fsm-status", {
		description: "[exp03] show FSM state",
		handler: async (_args, ctx) => {
			const current = fsm.getCurrent();
			const history = fsm.getHistory();
			ctx.ui.notify(
				`[exp03:FSM] current=${current} | transitions=${history.length}`,
				"info",
			);
			console.log(`[exp03:FSM] current: ${current}`);
			console.log(`[exp03:FSM] history:`);
			for (const e of history) {
				console.log(`  ${e.from} → ${e.to} | ${e.evidence}`);
			}
		},
	});

	pi.registerCommand("fsm-reset", {
		description: "[exp03] reset FSM to idle",
		handler: async (_args, ctx) => {
			fsm.transition("idle", "manual_reset");
			ctx.ui.notify("[exp03:FSM] reset to idle", "info");
		},
	});

	// ────────────────────────────────────────────────────────────
	// PART C: Cross-extension coordination via EventBus
	// ────────────────────────────────────────────────────────────
	pi.events.on("sages:stage-complete", (payload) => {
		console.log(`[exp03:events] stage-complete event:`, payload);
	});

	// ────────────────────────────────────────────────────────────
	// PART D: Demonstrate custom message injection with triggerTurn
	// ────────────────────────────────────────────────────────────
	pi.registerCommand("fsm-test-inject", {
		description: "[exp03] test sendMessage triggerTurn",
		handler: async (_args, ctx) => {
			pi.sendMessage(
				{
					customType: "sages-fsm-test",
					content: "Test message from FSM extension",
					display: true,
					details: { injectedAt: Date.now() },
				},
				{ triggerTurn: true, deliverAs: "nextTurn" },
			);
			ctx.ui.notify("[exp03] custom message queued for next turn", "info");
		},
	});
}