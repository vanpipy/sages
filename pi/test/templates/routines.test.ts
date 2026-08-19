/**
 * Routine template tests — GC-2026-053
 *
 * Validates that the 3 routine templates in pi/templates/routines/
 * (sages-session-wrap, sages-resume, sages-watchdog) are well-formed
 * pi-routine definitions:
 *
 *  - JSON parses
 *  - Required fields present (name, description, trigger, prompt, quiet)
 *  - Trigger kinds are valid (hook | pulse)
 *  - When trigger is hook, `event` is set (session_start | session_shutdown | agent_end)
 *  - When trigger is pulse, `interval` is set and is "30s" or longer
 *  - `name` matches the filename stem (so /routine-install <name> resolves)
 *  - `prompt` is non-empty and contains a numbered step list
 *  - `quiet` is `true` (these are monitors — never chatty)
 *  - `requiredTools` entries (when present) are string-array
 *  - `maxTicks` (when present) is a positive integer
 *  - `once` policy (when present) is "daily" | "per_session"
 *
 * The templates are USER-INSTALLED via /routine-install <name>. The
 * parent extension (pi-routines) reads them from its own template
 * directory; these schema checks are the only Sages-side assertions.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, "..", "..", "templates", "routines");

const EXPECTED_TEMPLATES = [
  "sages-session-wrap",
  "sages-resume",
  "sages-watchdog",
] as const;

const HOOK_EVENTS = ["session_start", "session_shutdown", "agent_end"] as const;
const ONCE_POLICIES = ["daily", "per_session"] as const;

function loadTemplate(name: string): any {
  return JSON.parse(
    readFileSync(join(TEMPLATES_DIR, `${name}.json`), "utf-8"),
  );
}

function hasNumberedSteps(prompt: string): boolean {
  // Cheap heuristic: contains at least one numbered step ("1. " or "Step 1")
  return /\n\s*\d+\.\s+/.test(prompt) || /^Step \d+/im.test(prompt);
}

describe("routine templates: directory contents (GC-2026-053 T3)", () => {
  it("T-RT-01: templates/routines/ directory exists", () => {
    const files = readdirSync(TEMPLATES_DIR);
    expect(files.length).toBeGreaterThan(0);
  });

  it("T-RT-02: all 3 expected templates exist as JSON files", () => {
    const files = readdirSync(TEMPLATES_DIR);
    for (const name of EXPECTED_TEMPLATES) {
      expect(files).toContain(`${name}.json`);
    }
  });

  it("T-RT-03: no rogue .md files (must be JSON for pi-routines)", () => {
    const files = readdirSync(TEMPLATES_DIR);
    const md = files.filter((f) => f.endsWith(".md"));
    expect(md).toEqual([]);
  });
});

describe("routine templates: each template validates (GC-2026-053 T3)", () => {
  for (const name of EXPECTED_TEMPLATES) {
    const template = loadTemplate(name);

    it(`T-RT-V01[${name}]: JSON parses (no throw in loadTemplate)`, () => {
      expect(template).toBeDefined();
    });

    it(`T-RT-V02[${name}]: name === filename stem`, () => {
      expect(template.name).toBe(name);
    });

    it(`T-RT-V03[${name}]: top-level required fields present`, () => {
      expect(typeof template.name).toBe("string");
      expect(template.name.length).toBeGreaterThan(0);
      expect(typeof template.description).toBe("string");
      expect(template.description.length).toBeGreaterThan(10);
      expect(typeof template.trigger).toBe("object");
      expect(typeof template.prompt).toBe("string");
      expect(template.prompt.length).toBeGreaterThan(50);
      expect(typeof template.quiet).toBe("boolean");
    });

    it(`T-RT-V04[${name}]: trigger.kind is one of hook|pulse|cron|oneoff|api|github`, () => {
      expect(["hook", "pulse", "cron", "oneoff", "api", "github"]).toContain(
        template.trigger.kind,
      );
    });

    it(`T-RT-V05[${name}]: hook trigger has valid event`, () => {
      if (template.trigger.kind === "hook") {
        expect(HOOK_EVENTS).toContain(template.trigger.event);
      }
    });

    it(`T-RT-V06[${name}]: pulse trigger has interval >= 30s`, () => {
      if (template.trigger.kind === "pulse") {
        const interval = template.trigger.interval;
        expect(typeof interval).toBe("string");
        // Parse "5m" / "30s" / "1h" — anything >= 30s
        const match = /^(\d+)(s|m|h)$/.exec(interval);
        expect(match).not.toBeNull();
        const n = parseInt(match![1], 10);
        const unit = match![2];
        const seconds = n * (unit === "s" ? 1 : unit === "m" ? 60 : 3600);
        expect(seconds).toBeGreaterThanOrEqual(30);
      }
    });

    it(`T-RT-V07[${name}]: quiet is true (monitors, not chatty)`, () => {
      expect(template.quiet).toBe(true);
    });

    it(`T-RT-V08[${name}]: prompt has numbered steps`, () => {
      expect(hasNumberedSteps(template.prompt)).toBe(true);
    });

    it(`T-RT-V09[${name}]: prompt mentions GC- and .pi/orchestrator/`, () => {
      expect(template.prompt).toContain("GC-");
      expect(template.prompt).toContain(".pi/orchestrator");
    });

    it(`T-RT-V10[${name}]: requiredTools is string array (when present)`, () => {
      if (template.requiredTools !== undefined) {
        expect(Array.isArray(template.requiredTools)).toBe(true);
        for (const t of template.requiredTools) {
          expect(typeof t).toBe("string");
          expect(t.length).toBeGreaterThan(0);
        }
      }
    });

    it(`T-RT-V11[${name}]: maxTicks is positive integer (when present)`, () => {
      if (template.maxTicks !== undefined) {
        expect(Number.isInteger(template.maxTicks)).toBe(true);
        expect(template.maxTicks).toBeGreaterThan(0);
      }
    });

    it(`T-RT-V12[${name}]: once policy is daily|per_session (when present)`, () => {
      if (template.trigger.once !== undefined) {
        expect(ONCE_POLICIES).toContain(template.trigger.once);
      }
    });
  }
});

describe("routine templates: cross-cutting invariants (GC-2026-053 T3)", () => {
  it("T-RT-X01: all 3 templates have unique names (no collision)", () => {
    const names = EXPECTED_TEMPLATES.map((n) => loadTemplate(n).name);
    const unique = new Set(names);
    expect(unique.size).toBe(EXPECTED_TEMPLATES.length);
  });

  it("T-RT-X02: all hook triggers set once=per_session or once=daily (not bare)", () => {
    for (const name of EXPECTED_TEMPLATES) {
      const t = loadTemplate(name);
      if (t.trigger.kind === "hook") {
        // session_shutdown should pair with per_session; session_start with daily
        // We assert the once field is present at minimum so /reload doesn't re-fire.
        expect(t.trigger.once).toBeDefined();
      }
    }
  });

  it("T-RT-X03: every prompt references sages_reminder (the new LLM tool)", () => {
    for (const name of EXPECTED_TEMPLATES) {
      const t = loadTemplate(name);
      expect(t.prompt).toContain("sages_reminder");
    }
  });

  it("T-RT-X04: every prompt has a [~] fallback (quiet-mode contract)", () => {
    for (const name of EXPECTED_TEMPLATES) {
      const t = loadTemplate(name);
      expect(t.prompt).toMatch(/\[~]/);
    }
  });

  it("T-RT-X05: filenames have no special characters", () => {
    const files = readdirSync(TEMPLATES_DIR);
    for (const f of files) {
      expect(f).toMatch(/^[a-z0-9-]+\.json$/);
    }
  });

  it("T-RT-X06: filename stem matches the routine's `name` field", () => {
    const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const stem = basename(f, ".json");
      const t = loadTemplate(stem);
      expect(t.name).toBe(stem);
    }
  });
});

describe("routine templates: specific contract assertions (GC-2026-053 T3)", () => {
  it("T-RT-S01: sages-session-wrap uses session_shutdown + per_session", () => {
    const t = loadTemplate("sages-session-wrap");
    expect(t.trigger.kind).toBe("hook");
    expect(t.trigger.event).toBe("session_shutdown");
    expect(t.trigger.once).toBe("per_session");
  });

  it("T-RT-S02: sages-resume uses session_start + daily", () => {
    const t = loadTemplate("sages-resume");
    expect(t.trigger.kind).toBe("hook");
    expect(t.trigger.event).toBe("session_start");
    expect(t.trigger.once).toBe("daily");
  });

  it("T-RT-S03: sages-watchdog uses pulse 5m", () => {
    const t = loadTemplate("sages-watchdog");
    expect(t.trigger.kind).toBe("pulse");
    expect(t.trigger.interval).toBe("5m");
    expect(t.maxTicks).toBe(14400);
  });

  it("T-RT-S04: sages-watchdog self-cleans via RoutineDelete", () => {
    const t = loadTemplate("sages-watchdog");
    expect(t.prompt).toContain("RoutineDelete");
  });

  it("T-RT-S05: sages-resume surfaces in-progress summaries as user messages", () => {
    const t = loadTemplate("sages-resume");
    expect(t.prompt).toContain("resuming previous work");
  });
});
