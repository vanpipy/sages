/**
 * sages-routines-install.ts — GC-2026-055
 *
 * Auto-install the 3 Sages routine templates (sages-session-wrap,
 * sages-resume, sages-watchdog) into the pi-routines store at session_start.
 *
 * Background: routes 042 → 044 added the 3 routine JSON files in
 * `pi/templates/routines/`, but they required manual `/routine-install`.
 * This module makes them install-on-session-start so the user doesn't
 * have to know they exist.
 *
 * Mechanism: read each JSON template, transform it into the Routine
 * schema that pi-routines stores in `state.json`, and merge into the
 * routines map. Idempotent — existing routines (by name) are not
 * overwritten, so users can `/routine-edit` after install and we
 * won't trample.
 *
 * The state file lives at `${HOME}/.pi/agent/extensions/routines/state.json`.
 * Direct file access is the contract; we don't go through LLM tokens
 * for what's a deterministic copy operation.
 *
 * Notes:
 *  - The template JSON uses a simpler schema than the persisted Routine
 *    (e.g. `interval: "5m"` instead of `intervalMs` + `intervalHuman`).
 *    We parse the interval here.
 *  - We assign a stable id derived from the routine name (slugified).
 *    pi-routines uses nanoid; our stable id makes the routine idempotent
 *    across sessions.
 *  - If a routine with the same name exists in the store with a different
 *    id (e.g., user manually installed it), we leave it alone.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const TEMPLATES_DIR = join(PROJECT_ROOT, "templates", "routines");
const STATE_PATH = join(homedir(), ".pi", "agent", "extensions", "routines", "state.json");

// ─── Schema types (subset of pi-routines types) ────────────────────────────

type HookTrigger = { kind: "hook"; event: "session_start" | "agent_end" | "session_shutdown"; once?: "daily" | "per_session" };
type PulseTrigger = { kind: "pulse"; intervalMs: number; intervalHuman: string };
type CronTrigger = { kind: "cron"; expr: string; timezone?: string };
type OneOffTrigger = { kind: "oneoff"; fireAtIso: string; timezone?: string; fired?: boolean };
type RoutineTrigger = HookTrigger | PulseTrigger | CronTrigger | OneOffTrigger;

interface Routine {
  id: string;
  name: string;
  prompt: string;
  triggers: RoutineTrigger[];
  context: "session";
  quiet: boolean;
  maxTicks?: number;
  maxRunsPerDay?: number;
  paused?: boolean;
  createdAt: number;
}

interface StoreShape {
  schemaVersion: number;
  routines: Record<string, Routine>;
  tickState: Record<string, unknown>;
  deferredHooks: unknown[];
}

// ─── Interval parsing (mirror of pi-routines/src/parser.ts) ──────────────

const MIN_MS = 30_000;
const MAX_MS = 24 * 60 * 60 * 1000;
const UNIT_MS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};

const SEGMENT_RE = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;

export function parseInterval(input: string): { ms: number } {
  const original = input;
  let s = input.trim().toLowerCase();
  if (s.startsWith("every ")) s = s.slice("every ".length).trim();
  if (s.length === 0) {
    throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
  }
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    throw new Error("Specify a unit: 5s, 5m, or 5h");
  }
  const matches = Array.from(s.matchAll(SEGMENT_RE));
  if (matches.length === 0) {
    throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
  }
  let ms = 0;
  for (const m of matches) {
    const n = Number(m[1]);
    const unit = m[2];
    const factor = UNIT_MS[unit];
    if (factor === undefined) {
      throw new Error(`Could not parse interval: '${original}'. Examples: 5m, 1h, 90s`);
    }
    ms += n * factor;
  }
  if (ms < MIN_MS) throw new Error("Interval must be at least 30 seconds");
  if (ms > MAX_MS) throw new Error("Intervals over 24h should use a cron trigger instead");
  return { ms };
}

// ─── Template → Routine transformer ────────────────────────────────────────

interface Template {
  name: string;
  description?: string;
  trigger:
    | { kind: "hook"; event: "session_start" | "agent_end" | "session_shutdown"; once?: "daily" | "per_session" }
    | { kind: "pulse"; interval: string }
    | { kind: "cron"; expr: string; timezone?: string }
    | { kind: "oneoff"; fireAtIso: string; timezone?: string };
  prompt: string;
  quiet: boolean;
  maxTicks?: number;
  maxRunsPerDay?: number;
  requiredTools?: string[];
}

export function transformTemplate(template: Template): Routine {
  const triggers: RoutineTrigger[] = [];
  if (template.trigger.kind === "hook") {
    triggers.push({
      kind: "hook",
      event: template.trigger.event,
      once: template.trigger.once,
    });
  } else if (template.trigger.kind === "pulse") {
    const { ms } = parseInterval(template.trigger.interval);
    triggers.push({
      kind: "pulse",
      intervalMs: ms,
      intervalHuman: template.trigger.interval,
    });
  } else if (template.trigger.kind === "cron") {
    triggers.push({
      kind: "cron",
      expr: template.trigger.expr,
      timezone: template.trigger.timezone,
    });
  } else if (template.trigger.kind === "oneoff") {
    triggers.push({
      kind: "oneoff",
      fireAtIso: template.trigger.fireAtIso,
      timezone: template.trigger.timezone,
    });
  }

  // Stable id derived from the routine name. pi-routines uses nanoid for
  // /routine-create, but a deterministic id is fine for our install
  // and lets us avoid collisions across reinstalls.
  const id = `sages_${template.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return {
    id,
    name: template.name,
    prompt: template.prompt,
    triggers,
    context: "session",
    quiet: template.quiet,
    maxTicks: template.maxTicks,
    maxRunsPerDay: template.maxRunsPerDay,
    paused: false,
    createdAt: Date.now(),
  };
}

// ─── Store I/O ─────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 3;

export function loadStore(): StoreShape {
  if (!existsSync(STATE_PATH)) {
    return {
      schemaVersion: SCHEMA_VERSION,
      routines: {},
      tickState: {},
      deferredHooks: [],
    };
  }
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    return JSON.parse(raw) as StoreShape;
  } catch {
    return {
      schemaVersion: SCHEMA_VERSION,
      routines: {},
      tickState: {},
      deferredHooks: [],
    };
  }
}

export function saveStore(store: StoreShape): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmp, STATE_PATH);
}

// ─── Public install API ────────────────────────────────────────────────────

export interface InstallResult {
  installed: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

export function installSagesRoutines(
  templatesDir: string = TEMPLATES_DIR,
  statePath: string = STATE_PATH,
): InstallResult {
  if (!existsSync(templatesDir)) {
    return { installed: [], skipped: [], errors: [{ name: "<dir>", error: `templates dir not found: ${templatesDir}` }] };
  }

  const result: InstallResult = { installed: [], skipped: [], errors: [] };
  const files = readdirSync(templatesDir).filter((f) => f.endsWith(".json"));

  // Load existing store (if any).
  const store = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf-8")) as StoreShape)
    : { schemaVersion: SCHEMA_VERSION, routines: {}, tickState: {}, deferredHooks: [] };

  for (const file of files) {
    const path = join(templatesDir, file);
    try {
      const template = JSON.parse(readFileSync(path, "utf-8")) as Template;
      const routine = transformTemplate(template);

      // Idempotency: skip if a routine with the same name already exists.
      const existing = Object.values(store.routines).find((r) => r.name === routine.name);
      if (existing) {
        result.skipped.push(routine.name);
        continue;
      }

      // Insert.
      store.routines[routine.id] = routine;
      result.installed.push(routine.name);
    } catch (err) {
      result.errors.push({
        name: file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Persist.
  if (result.installed.length > 0) {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = statePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
      renameSync(tmp, statePath);
    } catch (err) {
      result.errors.push({
        name: "<write>",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// Re-export for downstream callers (extension.ts, tests).
export { STATE_PATH, TEMPLATES_DIR };
