/**
 * agent-runner-boundary-survival.test.ts — GC-2026-094 P3
 *
 * Boundary Discipline parser + steer side. When a sub-agent loop is
 * aborted at the soft/hard turn limit, the YAML verdict block in the
 * final assistant message is lost. This test file pins:
 *
 *   1. The soft-limit steer message references
 *      `.pi/orchestrator/verdict-{task_id}.md` so the agent knows to
 *      write the verdict to a durable file path before the loop aborts.
 *   2. `extractStructuredOutputFromFile(taskId, cwd)` reads that file
 *      and parses it through the same code path as
 *      `extractStructuredOutput`, returning `null` when the file is
 *      missing or malformed (so the orchestrator can fall back gracefully).
 *
 * The steer string is exported as `SOFT_LIMIT_STEER_MESSAGE` so the
 * test can pin its contents without scraping the source file. The
 * helper is a sibling of `extractStructuredOutput` — semantics of the
 * original are unchanged.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	extractStructuredOutput,
	extractStructuredOutputFromFile,
	SOFT_LIMIT_STEER_MESSAGE,
} from "../src/agent-runner.js";

const VALID_YAML = `Work summary here.

\`\`\`yaml
status: completed
deliverables:
  files_changed: ["src/foo.ts"]
  commits: ["abc1234"]
  tests_added: ["test/foo.test.ts::does the thing"]
test_results:
  pass: 3
  fail: 0
  fail_details: []
open_questions: []
handoff_for_next_task:
  - read_first: "src/foo.ts"
    context: "new public API"
\`\`\`
`;

describe("soft-limit steer message (GC-2026-094 P3)", () => {
	it("references the durable verdict file path so the agent knows to write there", () => {
		// The literal `.pi/orchestrator/verdict-{task_id}.md` MUST appear
		// verbatim so the agent's prompt template interpolation produces a
		// usable file path.
		expect(SOFT_LIMIT_STEER_MESSAGE).toContain(
			".pi/orchestrator/verdict-{task_id}.md",
		);
	});

	it("tells the agent to commit before cleanup (commit-first discipline)", () => {
		expect(SOFT_LIMIT_STEER_MESSAGE).toMatch(/commit/i);
	});

	it("forbids starting new tests / refactors / exploration after the nudge", () => {
		expect(SOFT_LIMIT_STEER_MESSAGE).toMatch(
			/(do not|don't)\s+start\s+new\s+(tests|refactors|exploration)/i,
		);
	});
});

describe("extractStructuredOutputFromFile (GC-2026-094 P3)", () => {
	let workspace: string | undefined;

	afterEach(() => {
		if (workspace) {
			rmSync(workspace, { recursive: true, force: true });
			workspace = undefined;
		}
	});

	function makeWorkspace(): string {
		const dir = join(tmpdir(), `boundary-survival-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		workspace = dir;
		return dir;
	}

	it("happy path: reads verdict-{taskId}.md and returns a parsed SubagentOutput", () => {
		const cwd = makeWorkspace();
		const taskId = "P3-happy";
		const verdictDir = join(cwd, ".pi", "orchestrator");
		mkdirSync(verdictDir, { recursive: true });
		writeFileSync(join(verdictDir, `verdict-${taskId}.md`), VALID_YAML, "utf8");

		const out = extractStructuredOutputFromFile(taskId, cwd);
		expect(out).not.toBeNull();
		expect(out!.status).toBe("completed");
		expect(out!.deliverables.filesChanged).toEqual(["src/foo.ts"]);
		expect(out!.deliverables.commits).toEqual(["abc1234"]);
		expect(out!.testResults.pass).toBe(3);
		expect(out!.testResults.fail).toBe(0);
	});

	it("file-missing: returns null when no verdict file exists at the expected path", () => {
		const cwd = makeWorkspace();
		// Note: no file written.
		const out = extractStructuredOutputFromFile("P3-missing", cwd);
		expect(out).toBeNull();
	});

	it("file-missing: returns null when the .pi/orchestrator directory itself is absent", () => {
		const cwd = makeWorkspace();
		// Workspace exists but no .pi dir at all — readFileSync throws ENOENT,
		// the helper catches and returns null.
		const out = extractStructuredOutputFromFile("P3-no-dir", cwd);
		expect(out).toBeNull();
	});

	it("malformed-file: returns null when the file's contents cannot be parsed", () => {
		const cwd = makeWorkspace();
		const verdictDir = join(cwd, ".pi", "orchestrator");
		mkdirSync(verdictDir, { recursive: true });
		writeFileSync(
			join(verdictDir, "verdict-P3-garbage.md"),
			"this is not a yaml block at all",
			"utf8",
		);

		const out = extractStructuredOutputFromFile("P3-garbage", cwd);
		expect(out).toBeNull();
	});

	it("round-trip: file helper produces the same shape as the string helper given the same YAML", () => {
		const fromString = extractStructuredOutput(VALID_YAML);
		expect(fromString).not.toBeNull();

		const cwd = makeWorkspace();
		const verdictDir = join(cwd, ".pi", "orchestrator");
		mkdirSync(verdictDir, { recursive: true });
		writeFileSync(join(verdictDir, "verdict-P3-roundtrip.md"), VALID_YAML, "utf8");

		const fromFile = extractStructuredOutputFromFile("P3-roundtrip", cwd);
		expect(fromFile).not.toBeNull();
		expect(fromFile!.status).toBe(fromString!.status);
		expect(fromFile!.deliverables).toEqual(fromString!.deliverables);
		expect(fromFile!.testResults).toEqual(fromString!.testResults);
	});
});