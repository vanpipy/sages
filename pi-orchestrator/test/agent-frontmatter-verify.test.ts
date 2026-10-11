/**
 * Sanity check: shipped subagent built-ins are well-formed.
 *
 * Phase A (DAG-2026-011) + Phase B (DAG-2026-011) + DAG-2026-011
 * Phase C — done: every default subagent (Explore, Plan, Developer,
 * Auditor) is a built-in in `pi-subagents/src/default-agents.ts`
 * rather than a shipped user-level template. This test now verifies
 * the empty templates/agents/ directory and pins the architectural
 * invariant via the built-in config checks.
 *
 * Catches:
 *   - A new agent .md being added to templates/agents/ (would shadow a
 *     built-in via user-override precedence; not a migration target
 *     unless explicitly intended)
 *   - Field typos in `default-agents.ts` that pi-subagents would silently
 *     accept (e.g. `Extenshons:`)
 *   - Square-bracket list shape (`extensions:`) mismatches
 *   - Hard limits (model / thinking) accidentally re-introduced into
 *     the built-in config for agents that should inherit the parent
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// tsconfig only includes `@types/bun` types; `import.meta.dir` is bun runtime
// sugar that's incomplete in the TS lib. Reconstruct it.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, "..", "templates", "agents");
const DEFAULT_AGENTS_FILE = join(
  __dirname,
  "..",
  "..",
  "pi-subagents",
  "src",
  "default-agents.ts",
);

// Built-ins that intentionally pin a model in the shipped config.
// Explore pins anthropic/claude-haiku-4-5 for cheap read-only search;
// PlanCompiler (formerly Plan) pins the same model with `thinking: "minimal"` so
// the main agent's chosen reasoning model never bleeds into the plan compiler
// (DAG-2026-017-plan-compiler). Developer and Auditor pin
// minimax-cn/MiniMax-M3 (Sages house model for implement/audit) with
// silent fallback to the parent session's model when the registry
// doesn't have it — see resolveDefaultModel in agent-runner.ts. Every
// other built-in (Merger) inherits the parent model —
// pinning a Sonnet-class model on those would override the
// orchestrator's choice and is a regression. (GC-2026-091: git-expert
// removed; canonical names are PascalCase throughout.)
//
// GC-2026-093: `PlanCompiler` is the new canonical name for the plan
// compiler (the agent that was called `Plan`). The literal `name:
// "Plan",` is no longer in `default-agents.ts` — the dual-key Map entry
// `["Plan", PLAN_AGENT]` points to the same constant whose `name` field
// is `"PlanCompiler"`. The test extracts by the canonical name.
const PINNED_MODEL_EXCEPTIONS = new Set([
	"Explore",
	"PlanCompiler",
	"Developer",
	"Reviewer",
]);

it("templates/agents/ is EMPTY (no user-level subagent templates are shipped)", () => {
  // Phase A + Phase B + Phase C: every default agent is built-in to
  // pi-subagents. The templates/agents/ directory must remain empty
  // (or absent) so a new user-level template doesn't shadow a built-in
  // via user-override precedence. A missing directory is treated as
  // equivalent to an empty one — the retired template directory was
  // removed in DAG-2026-011 Phase C and the canonical home is the
  // built-in config. We do NOT create the directory here; we only
  // assert the invariant. (User customizations live in
  // ~/.pi/agent/agents/ or .pi/agents/, not here.)
  if (!existsSync(TEMPLATES_DIR)) {
    // No directory is fine: the retired location is intentionally
    // gone, and creating it would be a production-behavior change.
    expect(true).toBe(true);
    return;
  }
  const entries = readdirSync(TEMPLATES_DIR);
  expect(entries).toEqual([]);
});

describe("default-agents.ts: shipped built-in frontmatter (no third-party deps)", () => {
	// Post chore/only-developer-and-reviewer the shipped default agents are
	// Developer + Reviewer. Their configs are minimal (no `model:` pin, no
	// special promptMode, no per-agent READ_ONLY_TOOLS gate). The original
	// frontmatter-verification loop targeted Explore + PlanCompiler's
	// model-pinning + read-only restrictions — none of those concerns
	// apply to the new minimal defaults, so the parameterized loop was
	// removed. The substantive assertion lives below.
	it("lists exactly Developer + Reviewer (no third-party deps)", () => {
		const source = readFileSync(DEFAULT_AGENTS_FILE, "utf-8");
		expect(source).toMatch(/^export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map\(\[$/m);
		expect(source).toMatch(/^\s*"Developer",$/m);
		expect(source).toMatch(/^\s*"Reviewer",$/m);
		expect(source).not.toMatch(/^\s*"Explore",$/m);
		expect(source).not.toMatch(/^\s*"Plan",$/m);
		expect(source).not.toMatch(/^\s*"PlanCompiler",$/m);
		expect(source).not.toMatch(/^\s*"general-purpose",$/m);
	});
});

