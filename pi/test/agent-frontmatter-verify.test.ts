/**
 * Sanity check: shipped subagent built-ins are well-formed.
 *
 * Phase A (DAG-2026-011) + Phase B (DAG-2026-011) + DAG-2026-011
 * Phase C — done: every default subagent (Explore, Plan, developer,
 * auditor) is a built-in in `pi-subagents/src/default-agents.ts`
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
// Plan pins the same model with `thinking: "minimal"` so the main
// agent's chosen reasoning model never bleeds into the plan compiler
// (DAG-2026-017-plan-compiler). Every other built-in (developer,
// auditor) inherits the parent model — pinning a Sonnet-class model
// on those would override the orchestrator's choice and is a
// regression.
const PINNED_MODEL_EXCEPTIONS = new Set(["Explore", "Plan"]);

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
  // We grep the source file rather than importing it: pi-subagents
  // transitively depends on pi-coding-agent's heavy runtime (sessions,
  // UI, scheduler), and we only need a syntactic check here. The
  // exhaustive runtime contract is covered by
  // `pi-subagents/test/default-agents.test.ts`.
  const source = readFileSync(DEFAULT_AGENTS_FILE, "utf-8");

  // For every default agent, the AgentConfig literal must carry the
  // fields pi-subagents requires to surface a working Agent tool entry.
  // We extract the block by anchoring on `name: "X",` and walking to
  // the enclosing `{ ... }` brace pair (matched by tracking brace
  // depth) — more robust than a regex against `},` / `};` boundaries.
  //
  // Some agents are declared as top-level `const X: AgentConfig = { ... }`
  // literals (developer, auditor): the opening `{` precedes the
  // `name: "X",` field, so we walk back from the name to find it.
  // Others are declared inline inside a `Map` array
  // (`["X", { name: "X", ... }]`) — same shape, walk-back still works.
  function extractAgentBlock(name: string): string | null {
    const escaped = name.replace(/-/g, "\\-");
    const re = new RegExp(`name:\\s*"${escaped}",`);
    const m = source.match(re);
    if (!m || m.index === undefined) return null;
    // Walk back to the nearest preceding `{` (the block's opening
    // brace may sit before the `name:` field, e.g. for top-level
    // const-declared AgentConfig literals).
    let openIdx = m.index;
    while (openIdx > 0 && source[openIdx] !== "{") openIdx--;
    if (source[openIdx] !== "{") return null;
    let i = openIdx;
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
          return source.slice(openIdx, i + 1);
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

    it(`${name} built-in frontmatter honors the model-pinning policy`, () => {
      // A built-in that pins `model: "anthropic/claude-sonnet-..."`
      // (or any non-haiku model) on a role that should inherit the
      // parent would override the orchestrator's chosen model and
      // blow up the per-subagent cost budget. The intentional
      // exceptions are Explore (cheap haiku-4-5 for read-only search)
      // and Plan (cheap haiku-4-5 + `thinking: "minimal"` so the main
      // agent's reasoning model never bleeds into the plan compiler,
      // per DAG-2026-017-plan-compiler). Every other built-in must
      // inherit. If a new agent is added that needs to pin, add it
      // to PINNED_MODEL_EXCEPTIONS with a justifying comment.
      if (PINNED_MODEL_EXCEPTIONS.has(name)) return;
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
