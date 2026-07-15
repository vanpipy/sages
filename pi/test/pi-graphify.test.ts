/**
 * pi-graphify tests (v0.3.0)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_GRAPHIFY_ROOT = path.resolve(__dirname, "..", "..", "pi-graphify");

class MockExtensionAPI {
	notifications: Array<{ text: string; type: string }> = [];
	private handlers = new Map<string, Function[]>();
	messages: any[] = [];
	ui = { notify: (text: string, type: string = "info") => { this.notifications.push({ text, type }); } };
	registerTool = () => {};
	registerCommand = () => {};
	registerShortcut = () => {};
	registerFlag = () => {};
	getFlag = () => undefined;
	registerMessageRenderer = () => {};
	sendMessage = () => {};
	sendUserMessage = () => {};
	appendEntry = () => {};
	setSessionName = () => {};
	getSessionName = () => undefined;
	setLabel = () => {};
	exec = async () => ({ stdout: "", stderr: "", exitCode: 0, code: 0, killed: false });
	getActiveTools = () => [];
	getAllTools = () => [];
	setActiveTools = () => {};
	getCommands = () => [];
	setModel = async () => true;
	getThinkingLevel = () => "off" as const;
	setThinkingLevel = () => {};
	registerProvider = () => {};
	unregisterProvider = () => {};
	events = { listeners: new Map(), on: () => () => {}, off: () => {}, emit: () => {} };
	on(event: string, handler: Function) { const a = this.handlers.get(event) || []; a.push(handler); this.handlers.set(event, a); }
	async trigger(event: string, payload: unknown, ctx: unknown) { const a = this.handlers.get(event) || []; for (const h of a) await h(payload, ctx); }
}

/** Create a sage workspace in tmpDir with optional git repo + graph state. */
function makeSagesWorkspace(opts: {
	git?: boolean;
	graphMtime?: "before-commit" | "after-commit" | "none";
	dirtyFile?: boolean;
}): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-graphify-test-"));
	fs.mkdirSync(path.join(tmp, ".sages", "workspace"), { recursive: true });
	fs.writeFileSync(path.join(tmp, ".sages", "workspace", "state.json"), "{}");

	if (opts.git) {
		execFileSync("git", ["init", "-q"], { cwd: tmp });
		fs.writeFileSync(path.join(tmp, "README.md"), "init");
		execFileSync("git", ["add", "-A"], { cwd: tmp });
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
			{ cwd: tmp },
		);
	}

	if (opts.graphMtime && opts.graphMtime !== "none") {
		fs.mkdirSync(path.join(tmp, "graphify-out"), { recursive: true });
		fs.writeFileSync(path.join(tmp, "graphify-out", "graph.json"), "{}");

		if (opts.git && opts.graphMtime === "after-commit") {
			// Commit the graph first so working tree is clean
			execFileSync("git", ["add", "-A"], { cwd: tmp });
			execFileSync(
				"git",
				["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add graph"],
				{ cwd: tmp },
			);
			// Now set graph mtime = commit_ts + 60s (fresh: newer than HEAD)
			const commitTs = parseInt(
				execFileSync("git", ["log", "-1", "--format=%ct"], {
					cwd: tmp,
					encoding: "utf-8",
				}).trim(),
				10,
			);
			const graphTs = commitTs + 60;
			fs.utimesSync(path.join(tmp, "graphify-out", "graph.json"), graphTs, graphTs);
		}
		if (opts.git && opts.graphMtime === "before-commit") {
			// Commit graph first so it's not "dirty"
			execFileSync("git", ["add", "-A"], { cwd: tmp });
			execFileSync(
				"git",
				["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add graph"],
				{ cwd: tmp },
			);
			// Set graph mtime = commit_ts - 3600s (stale: 1 hour older than HEAD)
			const commitTs = parseInt(
				execFileSync("git", ["log", "-1", "--format=%ct"], {
					cwd: tmp,
					encoding: "utf-8",
				}).trim(),
				10,
			);
			const graphTs = commitTs - 3600;
			fs.utimesSync(path.join(tmp, "graphify-out", "graph.json"), graphTs, graphTs);
		}
	}

	if (opts.dirtyFile) {
		fs.writeFileSync(path.join(tmp, "new-file.txt"), "uncommitted change");
	}

	return tmp;
}

function cleanSagesWorkspace(tmp: string) {
	fs.rmSync(tmp, { recursive: true, force: true });
}

describe("pi-graphify: package structure (v0.3.0 canonical skill)", () => {
	it("package.json declares pi.extensions and pi.skills", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(PI_GRAPHIFY_ROOT, "package.json"), "utf-8"));
		expect(pkg.pi?.extensions).toContain("./src/index.ts");
		expect(pkg.pi?.skills).toContain("./skills");
	});

	it("ships skills/graphify/ (canonical, no collision)", () => {
		const dir = path.join(PI_GRAPHIFY_ROOT, "skills", "graphify");
		expect(fs.existsSync(dir)).toBe(true);
		expect(fs.existsSync(path.join(dir, "SKILL.md"))).toBe(true);
		const refs = fs.readdirSync(path.join(dir, "references"));
		expect(refs.length).toBeGreaterThanOrEqual(8);
	});

	it("SKILL.md frontmatter has name: graphify (canonical, >20K chars)", () => {
		const content = fs.readFileSync(path.join(PI_GRAPHIFY_ROOT, "skills", "graphify", "SKILL.md"), "utf-8");
		expect(content).toMatch(/^name: graphify$/m);
		expect(content.length).toBeGreaterThan(20000);
	});

	it("SKILL.md covers both CLI usage AND MCP integration", () => {
		const content = fs.readFileSync(path.join(PI_GRAPHIFY_ROOT, "skills", "graphify", "SKILL.md"), "utf-8");
		expect(content).toContain("/graphify");
		expect(content).toContain("graphify .");
		expect(content).toContain("pi / MCP integration");
		for (const t of ["mcp_graph_query", "mcp_graph_shortest_path", "mcp_graph_god_nodes"]) {
			expect(content).toContain(t);
		}
	});

	it("does NOT ship skills/graphify-mcp/ (merged into canonical)", () => {
		expect(fs.existsSync(path.join(PI_GRAPHIFY_ROOT, "skills", "graphify-mcp"))).toBe(false);
	});

	it("mcp.json template has 7 first-class tools and uses uv-based MCP launch", () => {
		const mcp = JSON.parse(fs.readFileSync(path.join(PI_GRAPHIFY_ROOT, "templates", "mcp.json"), "utf-8"));
		const g = mcp.mcpServers?.["graphify"];
		expect(g).toBeDefined();
		// v0.8.33+: MCP server launched via `uv run --with graphifyy --with mcp -m graphify.serve`
		expect(g.command).toBe("uv");
		expect(g.args).toContain("run");
		expect(g.args).toContain("--with");
		expect(g.args).toContain("graphify.serve");
		expect(g.directTools?.length).toBe(7);
		expect(g.excludeTools?.length ?? 0).toBe(0);
	});
});

describe("pi-graphify: lifecycle hooks", () => {
	let mockPi: MockExtensionAPI;
	let extModule: { default: (pi: MockExtensionAPI) => void };

	beforeEach(async () => {
		mockPi = new MockExtensionAPI();
		extModule = await import("../../pi-graphify/src/index.js");
	});

	it("extension loads without throwing", () => {
		expect(() => extModule.default(mockPi as any)).not.toThrow();
	});

	it("session_start in non-sage workspace is silent", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-graphify-test-"));
		extModule.default(mockPi as any);
		await mockPi.trigger("session_start", {}, { cwd: tmpDir, ui: mockPi.ui });
		const notif = mockPi.notifications.find((n) => n.text.includes("pi-graphify"));
		expect(notif).toBeUndefined();
		fs.rmSync(tmpDir, { recursive: true });
	});

	it("session_start in sage workspace WITHOUT binary emits install warning", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-graphify-test-"));
		fs.mkdirSync(path.join(tmpDir, ".sages", "workspace"), { recursive: true });
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
		const origHome = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			extModule.default(mockPi as any);
			await mockPi.trigger("session_start", {}, { cwd: tmpDir, ui: mockPi.ui });
			const notif = mockPi.notifications.find((n) => n.text.includes("pi-graphify"));
			expect(notif).toBeDefined();
			expect(notif?.type).toBe("warning");
		} finally {
			process.env.HOME = origHome;
			fs.rmSync(tmpDir, { recursive: true });
			fs.rmSync(fakeHome, { recursive: true });
		}
	});

	it("session_start: missing graph (no git) emits 'NOT built' warning with action", async () => {
		const tmp = makeSagesWorkspace({ git: false });
		try {
			mockPi = new MockExtensionAPI();
			extModule = await import("../../pi-graphify/src/index.js");
			extModule.default(mockPi as any);
			await mockPi.trigger("session_start", {}, { cwd: tmp, ui: mockPi.ui });
			const notif = mockPi.notifications.find((n) => n.text.includes("NOT built"));
			expect(notif).toBeDefined();
			expect(notif?.type).toBe("warning");
			expect(notif?.text).toContain("graphify .");
			expect(notif?.text).toContain("bash");
		} finally {
			cleanSagesWorkspace(tmp);
		}
	});

	it("session_start: stale graph (repo dirty) emits STALE warning with --update hint", async () => {
		const tmp = makeSagesWorkspace({ git: true, graphMtime: "after-commit", dirtyFile: true });
		try {
			mockPi = new MockExtensionAPI();
			extModule = await import("../../pi-graphify/src/index.js");
			extModule.default(mockPi as any);
			await mockPi.trigger("session_start", {}, { cwd: tmp, ui: mockPi.ui });
			const notif = mockPi.notifications.find((n) => n.text.includes("STALE"));
			expect(notif).toBeDefined();
			expect(notif?.type).toBe("warning");
			expect(notif?.text).toContain("uncommitted change");
			expect(notif?.text).toContain("--update");
		} finally {
			cleanSagesWorkspace(tmp);
		}
	});

	it("session_start: stale graph (graph older than last commit) emits STALE warning", async () => {
		const tmp = makeSagesWorkspace({ git: true, graphMtime: "before-commit" });
		try {
			mockPi = new MockExtensionAPI();
			extModule = await import("../../pi-graphify/src/index.js");
			extModule.default(mockPi as any);
			await mockPi.trigger("session_start", {}, { cwd: tmp, ui: mockPi.ui });
			const notif = mockPi.notifications.find((n) => n.text.includes("STALE"));
			expect(notif).toBeDefined();
			expect(notif?.text).toContain("new commits since last build");
		} finally {
			cleanSagesWorkspace(tmp);
		}
	});

	it("session_start: fresh graph is silent (no notification)", async () => {
		const tmp = makeSagesWorkspace({ git: true, graphMtime: "after-commit" });
		try {
			mockPi = new MockExtensionAPI();
			extModule = await import("../../pi-graphify/src/index.js");
			extModule.default(mockPi as any);
			await mockPi.trigger("session_start", {}, { cwd: tmp, ui: mockPi.ui });
			const notif = mockPi.notifications.find((n) => n.text.includes("pi-graphify"));
			expect(notif).toBeUndefined();
		} finally {
			cleanSagesWorkspace(tmp);
		}
	});

	it("session_shutdown is a no-op", async () => {
		extModule.default(mockPi as any);
		let threw = false;
		try { await mockPi.trigger("session_shutdown", {}, { cwd: "/tmp", ui: mockPi.ui }); } catch { threw = true; }
		expect(threw).toBe(false);
	});
});
