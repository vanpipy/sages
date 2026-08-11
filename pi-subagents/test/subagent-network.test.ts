/**
 * subagent-network.test.ts — GC-2026-037 T3
 *
 * Network gating: agent-runner wraps `pi.exec()` to reject network-bearing
 * commands when `network_allowed: false`. The default for all built-in
 * agent types is `false` (offline-first). The test exercises:
 *
 *   T-NET-01: `isNetworkCommand` detects `git fetch`, `git pull`, `git clone`,
 *             `git ls-remote`, `git push`, `git remote`, `curl`, `wget`,
 *             `npm install`, `npm add`, `bun install`, etc.
 *   T-NET-02: `isNetworkCommand` does NOT flag local ops: `git status`,
 *             `git diff`, `git log`, `git commit`, `git branch`,
 *             `git checkout`, `git add`, `git reset`, etc.
 *   T-NET-03: `enforceNetworkGate(allowed: false)` throws NetworkNotAllowedError
 *             for a network command.
 *   T-NET-04: `enforceNetworkGate(allowed: true)` is a no-op.
 *   T-NET-05: `getNetworkAllowedDefault(type)` returns false for built-in
 *             types; can be overridden via setNetworkAllowedDefault.
 *   T-NET-06: `wrapPiForNetworkGate(pi, false).exec(...)` calls
 *             `enforceNetworkGate` before the underlying exec. A local
 *             command passes through.
 */

import { describe, expect, it, vi } from "vitest";

import {
	enforceNetworkGate,
	isNetworkCommand,
	NetworkNotAllowedError,
	wrapPiForNetworkGate,
} from "../src/agent-runner.js";
import {
	getNetworkAllowedDefault,
	setNetworkAllowedDefault,
} from "../src/settings.js";

describe("subagent network gate: command detection (GC-2026-037 T3)", () => {
	it("T-NET-01: detects network-bearing git subcommands and direct network tools", () => {
		// git network subcommands
		expect(isNetworkCommand("git", ["fetch"])).toBe(true);
		expect(isNetworkCommand("git", ["pull"])).toBe(true);
		expect(isNetworkCommand("git", ["clone", "https://..."])).toBe(true);
		expect(isNetworkCommand("git", ["ls-remote"])).toBe(true);
		expect(isNetworkCommand("git", ["push", "origin", "main"])).toBe(true);
		expect(isNetworkCommand("git", ["remote", "add", "origin", "..."])).toBe(
			true,
		);
		// direct network tools
		expect(isNetworkCommand("curl", ["-s", "https://..."])).toBe(true);
		expect(isNetworkCommand("wget", ["https://..."])).toBe(true);
		expect(isNetworkCommand("ssh", ["user@host"])).toBe(true);
		// package managers
		expect(isNetworkCommand("npm", ["install"])).toBe(true);
		expect(isNetworkCommand("npm", ["add", "foo"])).toBe(true);
		expect(isNetworkCommand("bun", ["install"])).toBe(true);
		expect(isNetworkCommand("pip", ["install", "foo"])).toBe(true);
	});

	it("T-NET-02: does NOT flag local git operations", () => {
		expect(isNetworkCommand("git", ["status"])).toBe(false);
		expect(isNetworkCommand("git", ["diff"])).toBe(false);
		expect(isNetworkCommand("git", ["log"])).toBe(false);
		expect(isNetworkCommand("git", ["commit", "-m", "..."])).toBe(false);
		expect(isNetworkCommand("git", ["branch"])).toBe(false);
		expect(isNetworkCommand("git", ["checkout", "main"])).toBe(false);
		expect(isNetworkCommand("git", ["add", "."])).toBe(false);
		expect(isNetworkCommand("git", ["reset"])).toBe(false);
		expect(isNetworkCommand("git", ["merge", "feature"])).toBe(false);
		expect(isNetworkCommand("git", ["rebase", "main"])).toBe(false);
		// package manager local subcommands
		expect(isNetworkCommand("npm", ["ls"])).toBe(false);
		expect(isNetworkCommand("npm", ["config", "get", "registry"])).toBe(false);
		expect(isNetworkCommand("npm", ["--version"])).toBe(false);
		// other tools that look network-y but are local
		expect(isNetworkCommand("node", ["script.js"])).toBe(false);
		expect(isNetworkCommand("python", ["script.py"])).toBe(false);
	});

	it("T-NET-03: enforceNetworkGate(allowed: false) throws NetworkNotAllowedError for a network command", () => {
		expect(() => enforceNetworkGate("git", ["fetch"], false)).toThrow(
			NetworkNotAllowedError,
		);
		expect(() => enforceNetworkGate("curl", ["https://..."], false)).toThrow(
			NetworkNotAllowedError,
		);
	});

	it("T-NET-04: enforceNetworkGate(allowed: true) is a no-op even for network commands", () => {
		expect(() => enforceNetworkGate("git", ["fetch"], true)).not.toThrow();
		expect(() =>
			enforceNetworkGate("curl", ["https://..."], true),
		).not.toThrow();
	});

	it("T-NET-04b: enforceNetworkGate(allowed: false) is a no-op for local commands", () => {
		expect(() => enforceNetworkGate("git", ["status"], false)).not.toThrow();
		expect(() =>
			enforceNetworkGate("git", ["commit", "-m", "..."], false),
		).not.toThrow();
	});
});

describe("subagent network gate: settings (GC-2026-037 T3)", () => {
	it("T-NET-05: getNetworkAllowedDefault returns false for built-in types by default", () => {
		expect(getNetworkAllowedDefault("developer")).toBe(false);
		expect(getNetworkAllowedDefault("auditor")).toBe(false);
		expect(getNetworkAllowedDefault("Explore")).toBe(false);
		expect(getNetworkAllowedDefault("Plan")).toBe(false);
		expect(getNetworkAllowedDefault("not-a-real-type")).toBe(false);
	});

	it("T-NET-05b: setNetworkAllowedDefault overrides the per-type default", () => {
		setNetworkAllowedDefault("developer", true);
		expect(getNetworkAllowedDefault("developer")).toBe(true);
		// Other types still default to false.
		expect(getNetworkAllowedDefault("auditor")).toBe(false);
		// Reset for downstream tests.
		setNetworkAllowedDefault("developer", false);
	});
});

describe("subagent network gate: pi.exec wrapper (GC-2026-037 T3)", () => {
	it("T-NET-06: wrapPiForNetworkGate(pi, false).exec throws for network commands and passes local commands through", async () => {
		const realExec = vi.fn(async () => ({
			stdout: "ok",
			stderr: "",
			code: 0,
			killed: false,
		}));
		const pi = { exec: realExec } as unknown as { exec: typeof realExec };
		const wrapped = wrapPiForNetworkGate(pi, false);

		// Network call → throws synchronously, realExec never called.
		// The proxy's exec throws NetworkNotAllowedError before the
		// underlying pi.exec is called, so the throw is sync.
		expect(() =>
			// @ts-expect-error — proxy exec return type
			(wrapped.exec as (cmd: string, args: string[]) => Promise<unknown>)(
				"git",
				["fetch"],
			),
		).toThrow(/network access disabled/);
		expect(realExec).not.toHaveBeenCalled();

		// Local call → passes through to realExec.
		// @ts-expect-error — proxy exec return type
		return (wrapped.exec as (cmd: string, args: string[]) => Promise<unknown>)(
			"git",
			["status"],
		).then(() => {
			expect(realExec).toHaveBeenCalledTimes(1);
			expect(realExec).toHaveBeenCalledWith("git", ["status"], undefined);
		});
	});

	it("T-NET-06b: wrapPiForNetworkGate(pi, true) is a no-op (returns pi directly)", () => {
		const pi = { exec: vi.fn() } as unknown as {
			exec: ReturnType<typeof vi.fn>;
		};
		const wrapped = wrapPiForNetworkGate(pi, true);
		// Should be the same object reference, not a proxy.
		expect(wrapped).toBe(pi);
	});

	it("T-NET-06c: NetworkNotAllowedError preserves the command and args for downstream reporting", () => {
		try {
			enforceNetworkGate("git", ["fetch", "origin", "main"], false);
		} catch (e) {
			expect(e).toBeInstanceOf(NetworkNotAllowedError);
			const err = e as NetworkNotAllowedError;
			expect(err.command).toBe("git");
			expect(err.args).toEqual(["fetch", "origin", "main"]);
			expect(err.message).toContain("git fetch origin main");
		}
	});
});
