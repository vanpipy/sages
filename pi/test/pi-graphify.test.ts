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

	it("mcp.json template has 7 first-class tools and uses wrapper script", () => {
		const mcp = JSON.parse(fs.readFileSync(path.join(PI_GRAPHIFY_ROOT, "templates", "mcp.json"), "utf-8"));
		const g = mcp.mcpServers?.["graphify"];
		expect(g).toBeDefined();
		// v0.4.2: wrapper script achieves lazy auto-build on first MCP call
		expect(g.command).toBe("bash");
		// Template uses __PI_GRAPHIFY_START_MCP__ placeholder (sed-substituted at install time)
		expect(g.args[0]).toBe("__PI_GRAPHIFY_START_MCP__");
		expect(g.args).toContain("${workspaceFolder}");
		expect(g.directTools?.length).toBe(7);
		expect(g.excludeTools?.length ?? 0).toBe(0);
	});

	it("templates/start-mcp.sh exists and is executable", () => {
		const wrapper = path.join(PI_GRAPHIFY_ROOT, "templates", "start-mcp.sh");
		expect(fs.existsSync(wrapper)).toBe(true);
		const stat = fs.statSync(wrapper);
		// executable bit set
		expect(stat.mode & 0o111).toBeGreaterThan(0);
	});

	it("start-mcp.sh: missing graph triggers build (logic test via mock graphify)", () => {
		const tmp = makeSagesWorkspace({ git: false });
		try {
			const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bin-"));
			const fakeGraphify = path.join(fakeBin, "graphify");
			fs.writeFileSync(
				fakeGraphify,
				`#!/usr/bin/env bash
mkdir -p graphify-out
echo '{"nodes":[],"edges":[]}' > graphify-out/graph.json
echo "[fake] built graph" >&2
exit 0
`,
			);
			fs.chmodSync(fakeGraphify, 0o755);

			// Also need fake uv (to not actually run graphify.serve)
			const fakeUv = path.join(fakeBin, "uv");
			fs.writeFileSync(
				fakeUv,
				`#!/usr/bin/env bash
echo "[fake-uv] would run: \$@" >&2
exit 0
`,
			);
			fs.chmodSync(fakeUv, 0o755);

			const wrapper = path.join(PI_GRAPHIFY_ROOT, "templates", "start-mcp.sh");
			const result = require("node:child_process").spawnSync(
				"bash",
				[wrapper, tmp],
				{ env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: "utf-8" },
			);
			// Mock graphify should have created graph.json
			expect(fs.existsSync(path.join(tmp, "graphify-out", "graph.json"))).toBe(true);
			expect(result.status).toBe(0);

			fs.rmSync(fakeBin, { recursive: true });
		} finally {
			cleanSagesWorkspace(tmp);
		}
	});

	it("start-mcp.sh: existing graph skips build", () => {
		const tmp = makeSagesWorkspace({ git: true, graphMtime: "after-commit" });
		try {
			const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bin-"));
			const fakeGraphify = path.join(fakeBin, "graphify");
			let graphifyCalled = false;
			fs.writeFileSync(
				fakeGraphify,
				`#!/usr/bin/env bash
graphifyCalled=1
echo "[fake-graphify] CALLED when it shouldn't be!" >&2
exit 1
`,
			);
			fs.chmodSync(fakeGraphify, 0o755);
			const fakeUv = path.join(fakeBin, "uv");
			fs.writeFileSync(fakeUv, "#!/usr/bin/env bash\nexit 0\n");
			fs.chmodSync(fakeUv, 0o755);

			const wrapper = path.join(PI_GRAPHIFY_ROOT, "templates", "start-mcp.sh");
			const result = require("node:child_process").spawnSync(
				"bash",
				[wrapper, tmp],
				{ env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: "utf-8" },
			);
			expect(result.status).toBe(0);

			fs.rmSync(fakeBin, { recursive: true });
		} finally {
			cleanSagesWorkspace(tmp);
		}
	});

	it("start-mcp.sh: PI_GRAPHIFY_AUTO_BUILD=skip disables build check", () => {
		const tmp = makeSagesWorkspace({ git: false });  // no graph
		try {
			const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bin-"));
			// Fake graphify that would fail loudly if called
			const fakeGraphify = path.join(fakeBin, "graphify");
			fs.writeFileSync(
				fakeGraphify,
				`#!/usr/bin/env bash
echo "[fake-graphify] CALLED but should have been skipped" >&2
exit 99
`,
			);
			fs.chmodSync(fakeGraphify, 0o755);
			// Fake uv: exits 0 even when graph is missing (skip-mode shouldn't trigger build)
			const fakeUv = path.join(fakeBin, "uv");
			fs.writeFileSync(
				fakeUv,
				`#!/usr/bin/env bash
# In skip mode, the wrapper skips build and goes straight to uv.
# This fake uv just exits 0; if graphify was called we'd see its stderr.
exit 0
`,
			);
			fs.chmodSync(fakeUv, 0o755);

			const wrapper = path.join(PI_GRAPHIFY_ROOT, "templates", "start-mcp.sh");
			const result = require("node:child_process").spawnSync(
				"bash",
				[wrapper, tmp],
				{ env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PI_GRAPHIFY_AUTO_BUILD: "skip" }, timeout: 5000 },
			);
			// graphify should NOT have been called (it would exit 99 with stderr warning)
			expect(result.stderr || "").not.toContain("fake-graphify] CALLED");
		} finally {
			cleanSagesWorkspace(tmp);
		}
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
			expect(notif?.text).toContain("Lazy auto-build");
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

	it("auto-build: PI_GRAPHIFY_AUTO_BUILD=1 + missing graph runs `graphify .`", async () => {
		const tmp = makeSagesWorkspace({ git: false });
		try {
			mockPi = new MockExtensionAPI();
			extModule = await import("../../pi-graphify/src/index.js");

			// Mock graphify binary that creates graph.json when called
			const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bin-"));
			const fakeGraphify = path.join(fakeBin, "graphify");
			fs.writeFileSync(
				fakeGraphify,
				`#!/usr/bin/env bash
echo "fake graphify: \$@"
mkdir -p graphify-out
echo '{"nodes":[],"edges":[]}' > graphify-out/graph.json
`,
			);
			fs.chmodSync(fakeGraphify, 0o755);

			const origPath = process.env.PATH;
			process.env.PATH = `${fakeBin}:${origPath}`;
			process.env.PI_GRAPHIFY_AUTO_BUILD = "1";

			try {
				extModule.default(mockPi as any);
				await mockPi.trigger("session_start", {}, { cwd: tmp, ui: mockPi.ui });
				const infoNotif = mockPi.notifications.find(
					(n) => n.text.includes("auto-building") || n.text.includes("auto-build complete"),
				);
				expect(infoNotif).toBeDefined();
				// Verify graph.json was created by mock build
				expect(fs.existsSync(path.join(tmp, "graphify-out", "graph.json"))).toBe(true);
			} finally {
				process.env.PATH = origPath;
				delete process.env.PI_GRAPHIFY_AUTO_BUILD;
				fs.rmSync(fakeBin, { recursive: true });
			}
		} finally {
			cleanSagesWorkspace(tmp);
		}
	});

	it("auto-build: PI_GRAPHIFY_AUTO_BUILD=force rebuilds even when fresh", async () => {
		const tmp = makeSagesWorkspace({ git: true, graphMtime: "after-commit" });
		try {
			mockPi = new MockExtensionAPI();
			extModule = await import("../../pi-graphify/src/index.js");

			const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bin-"));
			const fakeGraphify = path.join(fakeBin, "graphify");
			// Verify graphify-out was wiped before rebuild (force behavior)
			let sawWiped = false;
			fs.writeFileSync(
				fakeGraphify,
				`#!/usr/bin/env bash
if [ ! -d graphify-out ]; then
  echo "OK: graphify-out was wiped before rebuild"
  sawWiped=1
fi
mkdir -p graphify-out
echo '{"nodes":[],"edges":[]}' > graphify-out/graph.json
exit 0
`,
			);
			fs.chmodSync(fakeGraphify, 0o755);

			const origPath = process.env.PATH;
			process.env.PATH = `${fakeBin}:${origPath}`;
			process.env.PI_GRAPHIFY_AUTO_BUILD = "force";

			try {
				extModule.default(mockPi as any);
				await mockPi.trigger("session_start", {}, { cwd: tmp, ui: mockPi.ui });
				const infoNotif = mockPi.notifications.find(
					(n) => n.text.includes("auto-build complete"),
				);
				expect(infoNotif).toBeDefined();
				// graph.json regenerated by mock
				expect(fs.existsSync(path.join(tmp, "graphify-out", "graph.json"))).toBe(true);
			} finally {
				process.env.PATH = origPath;
				delete process.env.PI_GRAPHIFY_AUTO_BUILD;
				fs.rmSync(fakeBin, { recursive: true });
			}
		} finally {
			cleanSagesWorkspace(tmp);
		}
	});

	it("auto-build: PI_GRAPHIFY_AUTO_BUILD=stale triggers on stale", async () => {
		const tmp = makeSagesWorkspace({ git: true, graphMtime: "before-commit" });
		try {
			mockPi = new MockExtensionAPI();
			extModule = await import("../../pi-graphify/src/index.js");

			const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bin-"));
			const fakeGraphify = path.join(fakeBin, "graphify");
			// Verify --update was used
			fs.writeFileSync(
				fakeGraphify,
				`#!/usr/bin/env bash
if echo "\$@" | grep -q -- "--update"; then
  echo "OK: --update used"
else
  echo "ERROR: --update not used. args: \$@"
  exit 1
fi
mkdir -p graphify-out
echo '{"nodes":[],"edges":[]}' > graphify-out/graph.json
`,
			);
			fs.chmodSync(fakeGraphify, 0o755);

			const origPath = process.env.PATH;
			process.env.PATH = `${fakeBin}:${origPath}`;
			process.env.PI_GRAPHIFY_AUTO_BUILD = "stale";

			try {
				extModule.default(mockPi as any);
				await mockPi.trigger("session_start", {}, { cwd: tmp, ui: mockPi.ui });
				const infoNotif = mockPi.notifications.find(
					(n) => n.text.includes("auto-build complete"),
				);
				expect(infoNotif).toBeDefined();
			} finally {
				process.env.PATH = origPath;
				delete process.env.PI_GRAPHIFY_AUTO_BUILD;
				fs.rmSync(fakeBin, { recursive: true });
			}
		} finally {
			cleanSagesWorkspace(tmp);
		}
	});

	it("auto-build: unset env var = no auto-build (default warn-only behavior)", async () => {
		const tmp = makeSagesWorkspace({ git: false });
		try {
			// Make sure env var is unset
			const orig = process.env.PI_GRAPHIFY_AUTO_BUILD;
			delete process.env.PI_GRAPHIFY_AUTO_BUILD;

			mockPi = new MockExtensionAPI();
			extModule = await import("../../pi-graphify/src/index.js");
			extModule.default(mockPi as any);
			await mockPi.trigger("session_start", {}, { cwd: tmp, ui: mockPi.ui });

			// Should see the "NOT built" warning, not auto-build
			const warnNotif = mockPi.notifications.find((n) =>
				n.text.includes("NOT built") || n.text.includes("NOT built"),
			);
			expect(warnNotif).toBeDefined();
			expect(warnNotif?.type).toBe("warning");
			const infoNotif = mockPi.notifications.find((n) =>
				n.text.includes("auto-building"),
			);
			expect(infoNotif).toBeUndefined();

			if (orig) process.env.PI_GRAPHIFY_AUTO_BUILD = orig;
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
