import { beforeEach, describe, expect, it } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";

describe("AgentManager unknown-type spawn boundary", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("throws before creating an agent record", () => {
		const manager = new AgentManager();
		try {
			expect(() =>
				manager.spawn(
					{} as never,
					{ cwd: process.cwd() } as never,
					"not-registered",
					"inspect",
					{ description: "unknown type" } as never,
				),
			).toThrow(/unknown.*agent type.*not-registered/i);
			expect(manager.listAgents()).toEqual([]);
		} finally {
			manager.dispose();
		}
	});
});
