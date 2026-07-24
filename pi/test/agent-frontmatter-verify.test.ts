/**
 * Sanity check: shipped subagent .md files have well-formed YAML frontmatter
 * with the required structure (no third-party deps needed). pi-subagents
 * parses with @earendil-works/pi-coding-agent's parseFrontmatter; we replicate
 * the YFML shape inline because pi's package isn't in pi/node_modules.
 *
 * Catches:
 *   - Missing frontmatter delimiters
 *   - Field typos that pi-subagents would silently ignore
 *   - Square-bracket list shape (`extensions:`) mismatches
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
const FILES = ["software-auditor.md", "software-developer.md"];

// Minimal frontmatter parse matching pi's `--- YAML --- body` convention.
function extractFrontmatter(text: string): string | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  return end === -1 ? null : text.slice(4, end);
}

function field(block: string, name: string): string | null {
  // Anchor on the start of a line so we don't accidentally match `model:`
  // inside `description:` prose. Capture across continuation lines (which
  // pi's YAML-aware parser also folds by leading-whitespace indentation).
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}:`));
  if (start === -1) return null;
  let value = lines[start].slice(name.length + 1).trim();
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith(" ") || lines[i].startsWith("\t")) {
      value += " " + lines[i].trim();
    } else break;
  }
  if (value.endsWith(",")) value = value.slice(0, -1).trim();
  return value;
}

function listField(block: string, name: string): string[] | null {
  const value = field(block, name);
  if (!value) return null;
  // Strip inline trailing/leading brackets; collect by leading whitespace + comma
  const clean = value.replace(/^\[|\]$/g, "");
  return clean
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("shipped subagent frontmatter (no third-party deps)", () => {
  for (const file of FILES) {
    const fm = extractFrontmatter(
      readFileSync(join(TEMPLATES_DIR, file), "utf-8"),
    );

    it(`${file}: parseable frontmatter`, () => {
      expect(fm).not.toBeNull();
    });

    it(`${file}: required fields present (name, tools, extensions, isolation)`, () => {
      expect(field(fm!, "name")).toBeTruthy();
      expect(field(fm!, "tools")).toBeTruthy();
      expect(field(fm!, "extensions")).toBeTruthy();
      expect(field(fm!, "isolation")).toBeTruthy();
    });

    it(`${file}: no hard limits (model / thinking / max_turns must be unset)`, () => {
      // Reason: each shipped agent inherits parent model's provider + thinking,
      // plus an unlimited turn count. Removing these lines re-enables the
      // orchestrator's chosen model and lets long TDD cycles run end-to-end.
      expect(field(fm!, "model")).toBeNull();
      expect(field(fm!, "thinking")).toBeNull();
      expect(field(fm!, "max_turns")).toBeNull();
    });

    it(`${file}: tools include ext:aft/aft_search selector`, () => {
      const tools = field(fm!, "tools")!;
      expect(tools).toMatch(/ext:aft\/aft_search/);
    });
  }

  it("agents directory lists exactly the expected files", () => {
    const entries = readdirSync(TEMPLATES_DIR).sort();
    expect(entries).toEqual(["software-auditor.md", "software-developer.md"]);
  });
});
