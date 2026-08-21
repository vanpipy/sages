/**
 * Cross-cap alignment — AgentManager.
 *
 * Locks down the three pieces of the Sages-wide concurrency story that
 * previously drifted:
 *
 *   (a) The default global cap must match the value documented in
 *       `task-dispatcher.ts` (tool schema), the registry, and the
 *       Plan/Explore cap comments — i.e. 6, not 4. Regressing this back
 *       to 4 silently re-introduces the gap surfaced by GC-2026-064.
 *
 *   (b) Per-type cap resolution at spawn time still wins over the global
 *       cap. The AgentConfig hook (`getAgentMaxConcurrent`) is the
 *       tightest binding; settings.maxConcurrentByType is the middle
 *       layer; the global cap is the floor. These three are mutually
 *       consistent — a regression on (a) doesn't relax (b).
 *
 *   (c) Foreground spawns (isBackground:false) must NOT consume the
 *       global background cap. The PoC-level change is restricted to
 *       the constant; we pin the existing foreground-bypass contract
 *       here so a future refactor can't quietly route foreground through
 *       the background counter.
 *
 * Together these three cases close SC1 + SC2 of GC-2026-064.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";

describe("AgentManager cross-cap alignment (GC-2026-064)", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("(a) default global cap is 6 (not 4) — matches docs / schema / registry", () => {
		const manager = new AgentManager();
		expect(manager.getMaxConcurrent()).toBe(6);
		manager.dispose();
	});

	it("(b) per-type AgentConfig hook overrides the global cap when lower", () => {
		// Real Sages shape: getAgentMaxConcurrent returns 1 for developer (a
		// synthetic low cap to verify the hook wins) and undefined for everything
		// else. Global is 6. effectiveMaxFor("developer") must resolve to 1 (the
		// hook's value), not to 6 (the global floor).
		const manager = new AgentManager(
			undefined,
			6,
			undefined,
			undefined,
			(type) => (type === "developer" ? 1 : undefined),
		);
		expect((manager as any).effectiveMaxFor("developer")).toBe(1);
		// Sanity: a type without a hook falls through to the global cap.
		expect((manager as any).effectiveMaxFor("auditor")).toBe(6);
		manager.dispose();
	});

	it("(c) foreground spawn (isBackground:false) does not consume the global cap", () => {
		const manager = new AgentManager();

		// Spawn 6 foreground agents back-to-back. The placeholder pi makes
		// runAgent fail downstream, but the foreground contract is that
		// `incRunning` is a no-op — runningBackground must stay at zero
		// regardless of whether the throw happens before or after that line.
		for (let i = 0; i < 6; i++) {
			try {
				manager.spawn(
					{} as never,
					{ cwd: process.cwd() } as never,
					"developer",
					`foreground-${i}`,
					{
						description: `fg-${i}`,
						isBackground: false,
						isolation: "current-workspace",
					} as never,
				);
			} catch {
				// startAgent may throw downstream because pi is a placeholder.
				// The assertion below is the contract, not the throw.
			}
		}

		expect((manager as any).runningBackground).toBe(0);
		expect(
			(manager as any).runningBackgroundByType.get("developer") ?? 0,
		).toBe(0);
		// Also: no agent should have landed in the queue — foreground skips it.
		expect(
			manager.listAgents().filter((a: any) => a.status === "queued").length,
		).toBe(0);
		manager.dispose();
	});
});