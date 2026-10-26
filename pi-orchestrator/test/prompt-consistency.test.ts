/**
 * prompt-consistency.test.ts — the prompt suite vs. the code it describes.
 *
 * The three prompt artifacts under `pi-orchestrator/` are source files,
 * not configuration. They name tools, counts, shapes and mappings that
 * live in TypeScript. When the TypeScript moves and the Markdown does
 * not, the model reads a description of a system that no longer exists.
 * That drift has already happened three times (see the prompt-refactor
 * design doc, §2.7):
 *
 *   - T1: the orchestrator's own six tools were registered but absent
 *     from the `setActiveTools` allowlist, so every call failed with
 *     "Tool <name> not found" (`a197af2`).
 *   - T2: the four `subagent_*` control tools have no registration at
 *     all; the implementation was deleted in `a36ae68`.
 *   - T3: `pi-evaluator` classifies orchestrator calls against four
 *     retired tool names (out of scope for this package).
 *
 * This file is the guard that makes the fourth recurrence a test
 * failure instead of a surprise at dispatch time.
 *
 * ── How the file is organised ────────────────────────────────────────────
 *
 * The design's P1 phase is "write the test against the TARGET contract;
 * it fails on the current prompts — that is the point". A failing test
 * cannot be committed, because the pre-commit gate (`orchestrator:test`)
 * must stay green. So the target contract is encoded here as
 * `it.skip` blocks, each carrying a `TODO(P<n>)` marker that names the
 * implementation phase that turns it on. Removing the `.skip` IS the
 * acceptance signal for that phase — the assertion then has to pass
 * against the rewritten prompt.
 *
 * Assertions that hold against the CURRENT prompts are live. They lock
 * in the facts that are already correct (the shape catalog, the
 * phase → agentType table, the tier values, the template contract) so
 * the refactor cannot break them silently.
 *
 * The final assertion audits this ledger: every `it.skip` must have a
 * `TODO(P<n>)` marker and vice versa, so the skip list cannot become a
 * graveyard of forgotten work.
 *
 * Run: cd pi-orchestrator && bun test ./test/prompt-consistency.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	AFT_TOOLS,
	BASELINE_TOOLS,
	PI_ROUTINES_TOOLS,
	PI_SUBAGENT_TOOLS,
	PI_TASKS_TOOLS,
	SUBAGENT_CONTROL_TOOLS,
} from "../src/extension.js";
import { ORCHESTRATOR_TOOL_NAMES, PHASE_AGENT_TYPE } from "../src/orchestrator-tool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM_MD = join(__dirname, "..", "templates", "SYSTEM.md");
const SKILL_MD = join(__dirname, "..", "skills", "orchestrator", "SKILL.md");
const TOOL_DESC_MD = join(__dirname, "..", "templates", "agent-tool-description.md");
const PI_TASKS_INDEX = join(__dirname, "..", "..", "pi-tasks", "src", "index.ts");
const THIS_FILE = __filename;

const systemMd = readFileSync(SYSTEM_MD, "utf-8");
const skillMd = readFileSync(SKILL_MD, "utf-8");
const toolDescMd = readFileSync(TOOL_DESC_MD, "utf-8");
const piTasksIndex = readFileSync(PI_TASKS_INDEX, "utf-8");
const promptSuite = { SYSTEM: systemMd, SKILL: skillMd, TOOL_DESC: toolDescMd };

// ── the composed allowlist ────────────────────────────────────────────────
// `extension.ts` builds the array it hands to `pi.setActiveTools`. The
// composition itself is already pinned by extension-active-tools.test.ts;
// this file only checks that the PROMPT states the same numbers.
const ALLOWLIST = [
	...ORCHESTRATOR_TOOL_NAMES,
	...PI_SUBAGENT_TOOLS,
	...SUBAGENT_CONTROL_TOOLS,
	...PI_TASKS_TOOLS,
	...AFT_TOOLS,
	...BASELINE_TOOLS,
	...PI_ROUTINES_TOOLS,
];
// The four SUBAGENT_CONTROL_TOOLS are in the allowlist but registered
// nowhere (T2) — pi drops unknown names, so they are inert.
const LIVE_ALLOWLIST = ALLOWLIST.filter((n) => !SUBAGENT_CONTROL_TOOLS.includes(n));

// ── helpers ───────────────────────────────────────────────────────────────

/** Every backticked token that looks like an identifier. */
function backticked(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) out.push(m[1]);
	return out;
}

/** The `## N.` headings of a file, in document order. */
function numberedHeadings(text: string): number[] {
	return [...text.matchAll(/^##\s+(\d+)\./gm)].map((m) => Number(m[1]));
}

/** TS template literals escape backticks; undo that before table parsing. */
function unescapeTicks(text: string): string {
	return text.replace(/\\([`\\])/g, "$1");
}

/**
 * The `max_turns` tier table as a tier → value map. Handles both the
 * prompt copies (`| **Light** | \`480\` |`) and the canonical copy in
 * pi-tasks, where the table lives inside a TS template literal
 * (`| Light | \`480\` |`).
 */
function tierTable(text: string): Map<string, string> {
	const out = new Map<string, string>();
	const src = unescapeTicks(text);
	for (const m of src.matchAll(/\|\s*\*{0,2}(Light|Standard|Heavy)\*{0,2}\s*\|\s*`(\d+)`\s*\|/g)) {
		out.set(m[1], m[2]);
	}
	return out;
}

/** The canonical table, as it appears in the TaskExecute tool description. */
function canonicalTiers(): Map<string, string> {
	return tierTable(piTasksIndex);
}

/** The orchestrator tool module, whose schema defines the intent shapes. */
function orchestratorToolSource(): string {
	return readFileSync(join(__dirname, "..", "src", "orchestrator-tool.ts"), "utf-8");
}

// ── live assertions: what is already correct ─────────────────────────────

describe("prompt suite — facts that must keep matching the code", () => {
	it("names every registered orchestrator tool somewhere in the prompt suite", () => {
		const named = new Set(
			Object.values(promptSuite).flatMap((t) => backticked(t)),
		);
		for (const name of ORCHESTRATOR_TOOL_NAMES) {
			expect(named).toContain(name);
		}
	});

	it("names exactly the registered orchestrator tools — no extras, no omissions", () => {
		const named = new Set(
			Object.values(promptSuite).flatMap((t) => backticked(t)),
		);
		const orchestratorNamed = [...named].filter((n) => n.startsWith("task_"));
		expect(orchestratorNamed.sort()).toEqual([...ORCHESTRATOR_TOOL_NAMES].sort());
	});

	it("names every intent_shape from the code in SKILL.md's shape catalog", () => {
		// The `intent_shape` union lives in the `task_convert_intent` schema.
		const shapes = [...orchestratorToolSource().matchAll(/Type\.Literal\("([a-z-]+)"\)/g)].map(
			(m) => m[1],
		);
		expect(shapes.length).toBeGreaterThan(0);
		for (const shape of shapes) {
			expect(skillMd).toContain(`\`${shape}\``);
		}
	});

	it("SKILL.md's PHASE_AGENT_TYPE table matches the code row for row", () => {
		const table = skillMd.slice(skillMd.indexOf("### Phase → agentType"));
		for (const [phase, agentType] of Object.entries(PHASE_AGENT_TYPE)) {
			const row = new RegExp(
				`^\\|\\s*\`?${phase}\`?\\s*\\|\\s*\`?${agentType}\`?\\s*\\|`,
				"m",
			);
			expect(table).toMatch(row);
		}
	});

	it("every max_turns tier table in the prompt suite matches the canonical TaskExecute description", () => {
		const canonical = canonicalTiers();
		expect(canonical.size).toBe(3);
		for (const [file, text] of Object.entries(promptSuite)) {
			const table = tierTable(text);
			if (table.size === 0) continue; // no tier table in this file
			for (const [tier, value] of canonical) {
				expect(`${file}:${tier}=${table.get(tier) ?? "<missing>"}`).toBe(
					`${file}:${tier}=${value}`,
				);
			}
		}
	});

	it("states Standard as the default tier wherever the prompt suite names a default", () => {
		for (const [file, text] of Object.entries(promptSuite)) {
			if (tierTable(text).size === 0) continue;
			expect(`${file}: ${text}`).toMatch(
				/\*\*Standard\*\* by default|Default to `960` \(Standard\)/,
			);
		}
	});

	it("keeps the agent-tool-description template contract intact", () => {
		// The runtime substitutes exactly five variables
		// (pi-subagents/src/index.ts:1536-1541). The Sages template uses
		// four of them — it deliberately omits `{{isolationGuideline}}`,
		// whose generated text recommends `isolation: "worktree"`, the
		// mode the Sages red lines forbid. See the design doc §2.4.
		expect(toolDescMd).toContain("SAGES_TEMPLATE_V1");
		for (const v of [
			"{{typeList}}",
			"{{compactTypeList}}",
			"{{agentDir}}",
			"{{scheduleGuideline}}",
		]) {
			expect(toolDescMd).toContain(v);
		}
		expect(toolDescMd).not.toContain("{{isolationGuideline}}");
	});
});

// ── target contract: assertions the refactor turns on ────────────────────

describe("prompt suite — target contract (enabled phase by phase)", () => {
	it("states no hardcoded turn ceiling in any prompt file", () => {
		// The ceiling is `max_turns + graceTurns` with `graceTurns` a user
		// setting (default 5) — pi-subagents/src/settings.ts:41. No
		// prompt may freeze the default into an invariant.
		for (const [file, text] of Object.entries(promptSuite)) {
			expect(`${file}: ${text}`).not.toMatch(/tier \+ 5|max_turns \+ 5/);
		}
	});

	it("does not restate the max_turns tier values in any prompt file", () => {
		// The TaskExecute description is the single owner of the tier
		// table (design §4.6). Currently two prompt copies restate it.
		for (const [file, text] of Object.entries(promptSuite)) {
			expect(`${file}: ${text}`).not.toMatch(/\b(?:480|960|1280)\b/);
		}
	});

	it("keeps per-tool reference tables out of SYSTEM.md", () => {
		// The manual moves to SKILL §6 (design §4.5). Today SYSTEM.md
		// carries the `### 1. File / network` style blocks.
		expect(systemMd).not.toMatch(/^###\s+\d+\.\s+/m);
	});

	it("states the allowlist size and its live subset in SYSTEM.md", () => {
		// The prompt must state the same numbers the runtime composes.
		const para = systemMd
			.split(/\n\s*\n/)
			.find((p) => new RegExp(`\\b${ALLOWLIST.length}\\b`).test(p));
		expect(para).toBeDefined();
		expect(para).toMatch(new RegExp(`\\b${LIVE_ALLOWLIST.length}\\b`));
	});

	it("numbers SYSTEM.md's sections contiguously from 1", () => {
		const headings = numberedHeadings(systemMd);
		expect(headings.length).toBeGreaterThan(0);
		expect(headings).toEqual(headings.map((_, i) => i + 1));
	});

	it("numbers SKILL.md's sections contiguously from 1", () => {
		const headings = numberedHeadings(skillMd);
		expect(headings.length).toBeGreaterThan(0);
		expect(headings).toEqual(headings.map((_, i) => i + 1));
	});

	it("SKILL.md carries the tool reference", () => {
		// Design D2 (A): the manual moves into the on-demand skill.
		expect(skillMd).toMatch(/aft_search/);
		expect(skillMd).toMatch(/TaskCreate/);
	});

	it("does not advertise the four unregistered subagent control tools", () => {
		// Design D7 (A): retire the capability. T2 — no runtime registers
		// these names; the implementation was deleted in `a36ae68`.
		for (const [file, text] of Object.entries(promptSuite)) {
			for (const name of SUBAGENT_CONTROL_TOOLS) {
				expect(`${file}: ${text}`).not.toContain(name);
			}
		}
	});

	it("does not advertise the six unregistered bash_*/ast_grep_* tools", () => {
		// The host registers a single `bash` tool; the allowlist's
		// BASELINE_TOOLS is exactly bash, read, edit, write, grep, find, ls.
		for (const [file, text] of Object.entries(promptSuite)) {
			for (const name of [
				"bash_status",
				"bash_watch",
				"bash_write",
				"bash_kill",
				"ast_grep_search",
				"ast_grep_replace",
			]) {
				expect(`${file}: ${text}`).not.toContain(name);
			}
		}
	});

	it("names no unregistered tool in any prompt file", () => {
		// The strong form of the phantom-name check. The two assertions
		// above pin the ten names that actually drifted; this one catches
		// the NEXT one. Any backticked token that looks like a tool name
		// — by prefix — must be a tool the runtime actually registers.
		//
		// The prefixes are chosen so that ordinary prose is never caught:
		// `task_` needs the underscore (so `tasks` is not a tool name),
		// and `Task` needs a following capital (so `Tasks` is not one).
		// `codebase_memory_` is in the list because no pi extension registers
		// those names — pi-codebase-memory ships an MCP server, reached
		// through the `mcp` proxy — so a prompt that names one is naming a
		// tool the model cannot call.
		const registered = new Set<string>([
			...ORCHESTRATOR_TOOL_NAMES,
			...PI_SUBAGENT_TOOLS,
			...PI_TASKS_TOOLS,
			...AFT_TOOLS,
			...BASELINE_TOOLS,
			...PI_ROUTINES_TOOLS,
		]);
		// Real exported symbols that are NOT tools and may still be named
		// in the prompts. Each entry carries the file:line that proves it
		// exists, so the exemption cannot outlive the symbol. A name may
		// be added here only when a prompt is factually right to name it
		// and the runtime registers no such tool.
		const NOT_TOOL_SYMBOLS = new Map<string, string>([
			["TaskStore", "pi-tasks/src/task-store.ts:105"],
		]);
		const TOOL_PREFIX =
			/^(?:aft_|ast_grep_|bash_|codebase_memory_|routine_|subagent_|task_|Task[A-Z])/;
		for (const [file, text] of Object.entries(promptSuite)) {
			for (const token of backticked(text)) {
				if (!TOOL_PREFIX.test(token)) continue;
				expect(`${file}:${token}: ${registered.has(token) || NOT_TOOL_SYMBOLS.has(token)}`).toBe(
					`${file}:${token}: true`,
				);
			}
		}
	});
});

// ── the skip ledger ───────────────────────────────────────────────────────

describe("prompt suite — skip ledger", () => {
	it("has a TODO(P<n>) marker for every skipped assertion, and one per marker", () => {
		const source = readFileSync(THIS_FILE, "utf-8");
		const skips = (source.match(/\bit\.skip\(/g) ?? []).length;
		const markers = (source.match(/\/\/ TODO\(P\d\):/g) ?? []).length;
		expect(skips).toBe(markers);
	});

	it("leaves no target assertion disabled", () => {
		// Every assertion in the target-contract block is enabled. The
		// phases that produce the rewritten prompts (P2 SYSTEM.md, P3
		// SKILL.md, P4 tool description) have landed, so a skipped
		// assertion here would mean the refactor stopped half way. A
		// future phase that adds a target assertion must enable it in
		// the same commit that changes the prompt.
		const source = readFileSync(THIS_FILE, "utf-8");
		expect(source).not.toMatch(/\bit\.skip\(/);
		expect(source).not.toMatch(/\/\/ TODO\(P\d\):/);
	});
});
