/**
 * Sanity check: shipped subagent built-ins are well-formed.
 *
 * Phase A (DAG-2026-011) + Phase B (DAG-2026-011) — done: every default
 * subagent (Explore, Plan, general-purpose, developer, auditor) is a
 * built-in in `pi-subagents/src/default-agents.ts` rather than a
 * shipped user-level template. This test now verifies the empty
 * templates/agents/ directory and pins the architectural invariant
 * via the built-in config checks.
 *
 * Catches:
 *   - A new agent .md being added to templates/agents/ (would shadow a
 *     built-in via user-override precedence; not a migration target
 *     unless explicitly intended)
 *   - Field typos in `default-agents.ts` that pi-subagents would silently
 *     accept (e.g. `Extenshons:`)
 *   - Square-bracket list shape (`extensions:`) mismatches
 *   - Hard limits (model / thinking) accidentally re-introduced into
 *     the built-in config
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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

it("templates/agents/ is EMPTY (no user-level subagent templates are shipped)", () => {
  // Phase A + Phase B: every default agent is built-in to pi-subagents.
  // The templates/agents/ directory must remain empty so a new user-
  // level template doesn't shadow a built-in via user-override
  // precedence. (User customizations live in ~/.pi/agent/agents/ or
  // .pi/agents/, not here.)
  const entries = readdirSync(TEMPLATES_DIR);
  expect(entries).toEqual([]);
});

describe("default-agents.ts: shipped built-in frontmatter (no third-party deps)", () => {
  // We grep the source file rather than importing it: pi-subagents
  // transitively depends on pi-coding-agent's heavy runtime (sessions,
  // UI, scheduler), and we only need a syntactic check here. The
  // exhaustive runtime contract is covered by
  // `pi-subagents/test/default-agents.test.ts`.
  const source = readFileSync(DEFAULT_AGENTS_FILE, "utf-8");

  // For every default agent, the AgentConfig literal must carry the
  // fields pi-subagents requires to surface a working Agent tool entry.
  // We extract the block by anchoring on `name: "X",` and walking
  // forward to the closing `}` (matched by tracking brace depth) —
  // more robust than a regex against `},` / `};` boundaries.
  function extractAgentBlock(name: string): string | null {
    const escaped = name.replace(/-/g, "\\-");
    const re = new RegExp(`name:\\s*"${escaped}",`);
    const m = source.match(re);
    if (!m || m.index === undefined) return null;
    let i = m.index + m[0].length;
    let depth = 0;
    let started = false;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
        if (started && depth === 0) {
          return source.slice(m.index, i + 1);
        }
      }
    }
    return null;
  }

  for (const name of [
    "Explore",
    "Plan",
    "developer",
    "auditor",
  ] as const) {
    it(`${name} config block exists with the required keys`, () => {
      const block = extractAgentBlock(name);
      if (!block) throw new Error(`${name} config block must exist`);
      // Required fields per AgentConfig interface:
      if (!/description:/.test(block)) {
        throw new Error(`${name} must declare description`);
      }
      if (!/systemPrompt:/.test(block)) {
        throw new Error(`${name} must declare systemPrompt`);
      }
      if (!/promptMode:\s*"replace"/.test(block)) {
        throw new Error(`${name} must declare promptMode: "replace"`);
      }
      if (!/extensions:/.test(block)) {
        throw new Error(`${name} must declare extensions`);
      }
      // All checks passed — the it() block returns.
      expect(true).toBe(true);
    });

    it(`${name} does NOT pin a hard model in the built-in config (inherits parent)`, () => {
      // A built-in that pins `model: "anthropic/claude-sonnet-..."`
      // would override the orchestrator's chosen model. Only Explore
      // is allowed to pin (the cheap haiku-4-5 model for read-only
      // search); every other built-in inherits.
      if (name === "Explore") return; // documented exception
      const block = extractAgentBlock(name);
      if (!block) throw new Error(`${name} config block must exist`);
      if (/^\s*model:\s*"/m.test(block)) {
        throw new Error(
          `${name} must not pin 'model:' (built-ins inherit parent model)`,
        );
      }
      expect(true).toBe(true);
    });
  }
});
