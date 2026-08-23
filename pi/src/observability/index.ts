/**
 * observability — public surface for the run/* event domain.
 *
 * Re-exports the run enum + emitter so consumers can depend on a
 * single entry point. Callers should import from
 * `"@/observability/index.js"` (or the relative equivalent), not from
 * individual files in this directory.
 *
 * The split across events.ts / runner.ts is intentional:
 *   - events.ts is pure data (no runtime side effects beyond the
 *     domainOf helper).
 *   - runner.ts handles durable storage and depends on node:fs +
 *     js-yaml.
 *
 * Splitting the surfaces keeps each emitter's dependency graph
 * minimal — typecheck-only consumers (e.g. an enum-side
 * documentation generator) can import events.ts without pulling in
 * the fs + yaml dependencies.
 */

export {
  RunEvent,
  domainOf,
  type EventDomain,
} from "./events.js";

export {
  emitRunEvent,
  type AuditEvent,
} from "./runner.js";
