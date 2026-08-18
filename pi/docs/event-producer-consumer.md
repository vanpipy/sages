# Event producer / consumer matrix

> **Maintained by:** manual (regenerate when `observability/events.ts` changes).
> **Source:** [`pi/src/observability/events.ts`](../../src/observability/events.ts)
> **Emitters:** [`runner.ts`](../../src/observability/runner.ts), [`step.ts`](../../src/observability/step.ts), [`seam.ts`](../../src/observability/seam.ts)
> **Catalog:** [`catalogs/event.json`](../../catalogs/event.json)

The three event domains (GC-2026-050) keep the producer / consumer
contract honest by routing every event through one of three emitters,
each with its own durability profile. This document is the human-facing
matrix; the catalog is the machine-facing snapshot.

## Conventions

- **`run/*`** — durable workflow milestones. Each event is appended to
  `.pi/orchestrator/audit-state-{dag_id}.yaml` under the `events:`
  array. Records survive process restarts and are read by the orchestrator
  audit pass + postmortem tooling. Producer: `emitRunEvent(dagId, event, payload?)`
  (in `runner.ts`).
- **`step/*`** — live pipeline signals. Written to the active logger
  (`console.log` by default). Ephemeral by design — the audit trail
  captures `run/*` milestones, not every step. Producer: `emitStepEvent(event, payload?)`
  (in `step.ts`).
- **`seam/*`** — extension-hook boundaries. Dispatched to a per-process
  callback registry; callbacks receive the payload and return a
  Promise<void>; the dispatcher awaits them in registration order.
  Producer: `onSeam(event, callback)` registers a callback,
  `emitSeamEvent(event, payload?)` fires the event (in `seam.ts`).

The domain prefix (`run/` / `step/` / `seam/`) is part of the value, not
a separate field. This makes events round-trippable through string-only
channels (logs, JSON wire formats) and lets `domainOf(event)` route any
event back to its domain without re-parsing.

## Cross-domain guards

- Each emitter asserts the event's domain via `domainOf()` and throws
  on mismatch (see `runner.ts:63`, `step.ts:30`, `seam.ts:46`, `seam.ts:67`).
- A `run/*` event MUST NOT be fired through `emitStepEvent` /
  `emitSeamEvent`; vice versa.
- Tests at `pi/test/event-domains.test.ts` pin these invariants.

## Matrix

| Event ID | Domain | Producer (file:line) | Consumer (file:line) | Audience |
| --- | --- | --- | --- | --- |
| `run/goal_created` | run | `src/observability/events.ts:50` | `src/observability/runner.ts:58` (`emitRunEvent`) | durable audit-state |
| `run/dag_synthesized` | run | `src/observability/events.ts:53` | `src/observability/runner.ts:58` (`emitRunEvent`) | durable audit-state |
| `run/dispatch_started` | run | `src/observability/events.ts:56` | `src/observability/runner.ts:58` (`emitRunEvent`) | durable audit-state |
| `run/audit_completed` | run | `src/observability/events.ts:59` | `src/observability/runner.ts:58` (`emitRunEvent`) | durable audit-state |
| `run/merged` | run | `src/observability/events.ts:62` | `src/observability/runner.ts:58` (`emitRunEvent`) | durable audit-state |
| `step/preflight` | step | `src/observability/events.ts:81` | `src/observability/step.ts:29` (`emitStepEvent`) | ephemeral console.log |
| `step/spawn` | step | `src/observability/events.ts:84` | `src/observability/step.ts:29` (`emitStepEvent`) | ephemeral console.log |
| `step/artifact_received` | step | `src/observability/events.ts:87` | `src/observability/step.ts:29` (`emitStepEvent`) | ephemeral console.log |
| `step/merge_start` | step | `src/observability/events.ts:90` | `src/observability/step.ts:29` (`emitStepEvent`) | ephemeral console.log |
| `step/merge_complete` | step | `src/observability/events.ts:93` | `src/observability/step.ts:29` (`emitStepEvent`) | ephemeral console.log |
| `step/retry` | step | `src/observability/events.ts:96` | `src/observability/step.ts:29` (`emitStepEvent`) | ephemeral console.log |
| `step/cancel` | step | `src/observability/events.ts:99` | `src/observability/step.ts:29` (`emitStepEvent`) | ephemeral console.log |
| `seam/preflight` | seam | `src/observability/events.ts:118` | `src/observability/seam.ts:45` (`onSeam`) / `seam.ts:63` (`emitSeamEvent`) | registered callbacks (per-process FIFO) |
| `seam/pre_merge` | seam | `src/observability/events.ts:121` | `src/observability/seam.ts:45` (`onSeam`) / `seam.ts:63` (`emitSeamEvent`) | registered callbacks (per-process FIFO) |
| `seam/notify` | seam | `src/observability/events.ts:124` | `src/observability/seam.ts:45` (`onSeam`) / `seam.ts:63` (`emitSeamEvent`) | registered callbacks (per-process FIFO) |

## When this matrix goes stale

Add or rename an enum member in `events.ts` and re-run
`bun run gen:catalog` from `pi/` — the catalog snapshot is the canonical
event list. Then update the table above with the new producer line
number and (if the emitter file moves) the new consumer line number.
Verify with `bun run verify:catalog` (which fails on hash drift between
`events.ts` and `catalogs/event.json`).