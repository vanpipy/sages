/**
 * sages_reminder Tool — GC-2026-053
 *
 * Lightweight LLM-callable tool that bridges the gap between LLM contexts
 * (which can only call LLM-registered tools) and the pi extension API
 * (which exposes `pi.appendEntry("system", ...)` for system reminders).
 *
 * Why this tool exists:
 *
 *   pi's routine subsystem (pi-routines) fires routine prompts as user
 *   messages via `pi.sendUserMessage`. Each fire is a normal LLM turn.
 *   The LLM can call any LLM-registered tool — which includes the four
 *   existing orchestrator tools plus any third-party tools — but NOT
 *   extension API methods. `pi.appendEntry` is an extension API method,
 *   not an LLM tool, so routines (and any LLM context) had no way to
 *   inject system reminders.
 *
 *   This tool solves that by exposing a single LLM-callable tool that
 *   wraps `pi.appendEntry("system", reminderPayload)`. Routines (and any
 *   LLM that wants to surface a system-level reminder to the user) call
 *   `sages_reminder({ type, dag_id, message })` and the tool does the
 *   rest. The reminder appears in the conversation as a `[sages reminder:
 *   {TYPE}] {message}` block with structured metadata.
 *
 * Six reminder types, each with a default template:
 *
 *   - STALE_DAG         — fingerprinted DAG hasn't progressed in N minutes
 *   - MERGE_GATE        — user is about to merge despite an audit REVISE
 *   - COMPLETION_GATE   — LLM declared "done" but verification_cmd not PASS
 *   - GOAL_DRIFT        — current decision references out-of-scope paths
 *   - RESUME_REQUIRED   — session_start showed in-progress DAGs
 *   - GENERIC           — fallthrough; uses caller's message verbatim
 *
 * Output:
 *
 *   Appends a structured system entry. The reminder text is rendered via
 *   `formatReminderText({type, dag_id, message, defaultTemplate})` so the
 *   LLM sees a recognizable `[sages reminder: TYPE]` prefix.
 */

import { Type, type Static } from "typebox";

/**
 * Closed enum of reminder types. Adding a new type requires updating both
 * the schema (TypeBox) and the default templates (DEFAULT_REMINDER_TEMPLATES).
 */
export const SAGES_REMINDER_TYPES = [
  "STALE_DAG",
  "MERGE_GATE",
  "COMPLETION_GATE",
  "GOAL_DRIFT",
  "RESUME_REQUIRED",
  "GENERIC",
] as const;

export type SagesReminderType = (typeof SAGES_REMINDER_TYPES)[number];

/** Tool input schema. */
export const SagesReminderParams = Type.Object({
  type: Type.Union(
    [
      Type.Literal("STALE_DAG"),
      Type.Literal("MERGE_GATE"),
      Type.Literal("COMPLETION_GATE"),
      Type.Literal("GOAL_DRIFT"),
      Type.Literal("RESUME_REQUIRED"),
      Type.Literal("GENERIC"),
    ],
    {
      description:
        "Reminder category. One of: STALE_DAG, MERGE_GATE, COMPLETION_GATE, " +
        "GOAL_DRIFT, RESUME_REQUIRED, GENERIC.",
    },
  ),
  dag_id: Type.Optional(
    Type.String({
      description: "Optional DAG / goal id this reminder is about (e.g. 'GC-2026-053').",
      pattern: "^[A-Za-z0-9_-]+$",
    }),
  ),
  message: Type.Optional(
    Type.String({
      description:
        "Optional message override. When omitted, the type's default template is used.",
      minLength: 1,
      maxLength: 2000,
    }),
  ),
});

export type SagesReminderInput = Static<typeof SagesReminderParams>;

const DEFAULT_REMINDER_TEMPLATES: Record<SagesReminderType, string> = {
  STALE_DAG:
    "DAG has not progressed in 15+ minutes. Review last audit verdict and " +
    "either intervene or escalate. No automatic remediation; the orchestrator " +
    "decides next steps.",
  MERGE_GATE:
    "Audit verdict was REVISE. Confirm you intend to merge anyway — " +
    "RECOMMENDED: re-run the failing task, not merge around the audit.",
  COMPLETION_GATE:
    "Verification command has not PASSED. Re-run the goal's " +
    "verification_cmd before declaring done; silent PASS is not a PASS.",
  GOAL_DRIFT:
    "Current decision references paths outside the active goal's scope. " +
    "Either update the goal contract (scope.include) or stay within scope.",
  RESUME_REQUIRED:
    "In-progress DAGs detected in .pi/orchestrator/. Pick one to resume or " +
    "close out the stale ones before starting new work.",
  GENERIC: "Reminder from Sages orchestrator.",
};

/**
 * Per-type actionable fix directives (GC-2026-055). Mirrors L2's
 * `RULE_FIX_DIRECTIVES` (pi-subagents/src/agent-runner.ts:2225). When the
 * reminder is injected without a `message` override, the call site can
 * prefer the fixdirective over the generic default template — the
 * directive is a concrete shell command the LLM can run, not a generic
 * "we found a problem" message.
 *
 * Keep these to single-line shell invocations where possible. Tokens
 * are capped by the same 200-token limit as L2's advisories.
 */
export const SAGES_REMINDER_FIXDIRECTIVES: Record<SagesReminderType, string> = {
  STALE_DAG:
    "run `ls -lt .pi/orchestrator/audit-state-*.yaml | head -1` to see the most-recently-modified " +
    "audit state; if its mtime is > 15 min old, the DAG is genuinely stale. " +
    "Then `git log --oneline -10 -- .pi/orchestrator/` to see what moved.",
  MERGE_GATE:
    "before merging, run `cd pi && bun test ./src ./test` to re-run the failing task — " +
    "the audit's REVISE verdict is the source of truth, not a stale local view.",
  COMPLETION_GATE:
    "before declaring done, run the goal's `verification_cmd` exactly as written — " +
    "find it via `grep verification_cmd .pi/orchestrator/goal-*.yaml` and execute the command.",
  GOAL_DRIFT:
    "run `cat .pi/orchestrator/goal-*.yaml | grep -A 10 scope:` to see the include/exclude lists; " +
    "either update the goal contract (goal_contract_create with revision) or stay within scope.",
  RESUME_REQUIRED:
    "run `ls -la .pi/orchestrator/audit-state-*.yaml` to see active DAGs; " +
    "then `cat` the most recent one to inspect in-progress tasks before resuming.",
  GENERIC:
    "no specific fixdirective — re-read the surrounding context (L1 advisory, recent audit) " +
    "for actionable next steps.",
};

/**
 * Render the reminder text. The result is what the LLM sees in the
 * conversation transcript; the structured payload is what observers can
 * read on the session entry.
 */
export function formatReminderText(input: SagesReminderInput): string {
  // Prefer the per-type fixdirective over the default template when no
  // message override is provided. The fixdirective is actionable shell
  // commands; the template is a generic prose description. The LLM can
  // run the directive verbatim.
  const directive = SAGES_REMINDER_FIXDIRECTIVES[input.type];
  const fallback = DEFAULT_REMINDER_TEMPLATES[input.type];
  const body = input.message?.trim() || directive || fallback;
  const dagSuffix = input.dag_id ? ` (${input.dag_id})` : "";
  return `[sages reminder: ${input.type}${dagSuffix}] ${body}`;
}

/**
 * Build the structured payload that goes into `pi.appendEntry("system", ...)`.
 * The payload is observable to extension listeners and to code that reads
 * the session JSONL.
 */
export function buildReminderPayload(input: SagesReminderInput): {
  type: SagesReminderType;
  dag_id?: string;
  message: string;
  timestamp: string;
  tool: "sages_reminder";
} {
  return {
    type: input.type,
    dag_id: input.dag_id,
    message: input.message?.trim() || DEFAULT_REMINDER_TEMPLATES[input.type],
    timestamp: new Date().toISOString(),
    tool: "sages_reminder",
  };
}

/**
 * Register the `sages_reminder` tool on the pi extension API.
 * Called from `registerOrchestratorTools` in `index.ts`.
 *
 * Behavior:
 *   - Validates `type` against SAGES_REMINDER_TYPES (engine-level via TypeBox)
 *   - On valid call: invokes `pi.appendEntry("system", payload)` and returns
 *     a structured success response with the rendered text
 *   - On invalid call: returns an error content block (LLM-readable) — does
 *     NOT throw, so the LLM can correct and retry
 */
export function registerSagesReminderTool(pi: any): void {
  pi.registerTool({
    name: "sages_reminder",
    label: "Sages Reminder",
    description:
      "Inject a system-level reminder into the current Sages session. " +
      "Use this to surface orchestrator-level signals (stale DAGs, merge " +
      "gates, completion gates, goal drift, resume prompts) that need to be " +
      "known to the conversation. The reminder is appended as a system " +
      "entry and is visible to the LLM. type must be one of: " +
      SAGES_REMINDER_TYPES.join(", ") +
      ". dag_id is optional. message overrides the default template when set.",
    parameters: SagesReminderParams,

    async execute(
      _toolCallId: string,
      params: any,
      _signal: any,
      _onUpdate: any,
      _ctx: any,
    ) {
      // Validate type. TypeBox already enforces this at the schema level,
      // but defense-in-depth: if a future caller bypasses the schema,
      // catch the unknown type and return a structured error.
      if (!SAGES_REMINDER_TYPES.includes(params?.type)) {
        const knownTypes = SAGES_REMINDER_TYPES.join(", ");
        return {
          content: [
            {
              type: "text",
              text:
                `sages_reminder error: unknown type ${JSON.stringify(params?.type)}. ` +
                `Valid types: ${knownTypes}.`,
            },
          ],
          details: {
            status: "error",
            code: "INVALID_TYPE",
            received: params?.type,
            valid: SAGES_REMINDER_TYPES,
          },
        };
      }

      const input: SagesReminderInput = {
        type: params.type,
        dag_id: params.dag_id,
        message: params.message,
      };

      const payload = buildReminderPayload(input);
      const text = formatReminderText(input);

      // Inject as a system entry. The text is human-readable; the payload
      // is structured for observers.
      try {
        pi.appendEntry("system", { ...payload, text });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text:
                `sages_reminder error: appendEntry failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
            },
          ],
          details: {
            status: "error",
            code: "APPEND_ENTRY_FAILED",
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }

      return {
        content: [{ type: "text", text: `Reminder injected: ${text}` }],
        details: {
          status: "ok",
          payload,
          text,
        },
      };
    },
  });
}
