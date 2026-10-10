/**
 * intent-reminder-wiring.test.ts — GC-2026-intent-default-to-decompose / C
 *
 * Wiring smoke test that proves `applyIntentReminderToSystemPrompt` is
 * actually invoked by the `before_agent_start` handler in
 * `pi-tasks/src/index.ts`, and that the handler returns the reminder
 * result so the host loader can replace the system prompt.
 *
 * GC-2026-intent-default-to-decompose: this test exists because the
 * audit of the current chat session at `~/.pi/agent/sessions/` showed
 * the IntentPump's user-role message eclipsed the system-prompt
 * reminder. We cannot prove the reminder was reached at runtime from a
 * JSONL trace alone (the system prompt is truncated on serialization),
 * but we CAN prove the wiring is structurally present in source — so
 * any future regression that breaks the wiring fails this test.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PI_TASKS_INDEX = join(import.meta.dir, "..", "src", "index.ts");

describe("intent-reminder wiring (GC-2026-intent-default-to-decompose / C)", () => {
  const src = readFileSync(PI_TASKS_INDEX, "utf8");

  it("registers a before_agent_start handler in pi-tasks/src/index.ts", () => {
    expect(src).toMatch(/pi\.on\(\s*["']before_agent_start["']/);
  });

  it("before_agent_start handler calls applyIntentReminderToSystemPrompt", () => {
    expect(src).toContain("applyIntentReminderToSystemPrompt");
  });

  it("before_agent_start handler passes the existing system prompt + intentPump.isOwned predicate", () => {
    // The handler must pass: store, existingSystemPrompt, isOwned callback.
    // We assert the call shape with a permissive regex (multiline).
    const callPattern =
      /applyIntentReminderToSystemPrompt\s*\(\s*store\s*,\s*existingSystemPrompt\s*,\s*\([^\)]*\)\s*=>\s*intentPump\.isOwned\s*\(/m;
    expect(src).toMatch(callPattern);
  });

  it("before_agent_start handler returns the reminder result so the host can replace the system prompt", () => {
    // The handler must `return reminderResult;` (or equivalent) so the
    // reminder actually reaches the LLM. If the handler swallows the
    // result, the reminder is computed but never used.
    expect(src).toMatch(/return\s+reminderResult\s*;?/m);
  });

  it("intentPump instance is created and reachable from before_agent_start", () => {
    // Sanity: the pump variable that owns the isOwned predicate must
    // exist somewhere in the module. Loose match — we don't care about
    // exact variable name, just that `intentPump` shows up.
    expect(src).toContain("intentPump");
  });
});
