import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import { registerRpcHandlers } from "../src/cross-extension-rpc.js";

interface EventBusStub {
	handlers: Map<string, ((data: unknown) => void)[]>;
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

function makeEventBus(): EventBusStub {
	const handlers = new Map<string, ((data: unknown) => void)[]>();
	return {
		handlers,
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {
				const current = handlers.get(event) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) current.splice(index, 1);
			};
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) handler(data);
		},
	};
}

async function spawnReply(
	bus: EventBusStub,
	requestId: string,
	request: Record<string, unknown>,
): Promise<any> {
	return new Promise((resolve) => {
		bus.on(`subagents:rpc:spawn:reply:${requestId}`, resolve);
		bus.emit("subagents:rpc:spawn", { requestId, ...request });
	});
}

describe("cross-extension spawn RPC bounds", () => {
	beforeEach(() => {
		setDefaultsDisabled(false);
		registerAgents(new Map());
	});

	it("rejects unknown agent types before spawning", async () => {
		const bus = makeEventBus();
		const spawn = vi.fn(() => "agent-id");
		registerRpcHandlers({
			events: bus,
			pi: {},
			getCtx: () => ({}),
			manager: { spawn, abort: () => false },
		});

		const reply = await spawnReply(bus, "unknown-type", {
			type: "not-registered",
			prompt: "inspect",
		});

		expect(reply).toMatchObject({ success: false });
		expect(reply.error).toMatch(/unknown.*agent type/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("rejects prompts larger than 256 KiB in UTF-8 bytes", async () => {
		const bus = makeEventBus();
		const spawn = vi.fn(() => "agent-id");
		registerRpcHandlers({
			events: bus,
			pi: {},
			getCtx: () => ({}),
			manager: { spawn, abort: () => false },
		});

		const reply = await spawnReply(bus, "large-prompt", {
			type: "Explore",
			prompt: "你".repeat(87_382),
		});

		expect(reply).toMatchObject({ success: false });
		expect(reply.error).toMatch(/prompt.*256 KiB/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("rejects unknown spawn option keys", async () => {
		const bus = makeEventBus();
		const spawn = vi.fn(() => "agent-id");
		registerRpcHandlers({
			events: bus,
			pi: {},
			getCtx: () => ({}),
			manager: { spawn, abort: () => false },
		});

		const reply = await spawnReply(bus, "unknown-option", {
			type: "Explore",
			prompt: "inspect",
			options: { description: "bounded", shell: true },
		});

		expect(reply).toMatchObject({ success: false });
		expect(reply.error).toMatch(/unknown spawn option.*shell/i);
		expect(spawn).not.toHaveBeenCalled();
	});
});
