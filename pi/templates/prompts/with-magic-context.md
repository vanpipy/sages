# Active tooling — with Magic Context

The Sages conductor loaded the following extensions for this session.
Workflow rules (DAG mechanics, subagent dispatch, TDD, commit
conventions, namespace ownership) live in SYSTEM.md.

## Loaded extensions

{{#if loaded."@sages/pi-orchestrator"}}
- **`@sages/pi-orchestrator`** — workflow governance
{{/if}}

{{#if loaded."@sages/pi-subagents"}}
- **`@sages/pi-subagents`** — subagent lifecycle
{{/if}}

{{#if loaded."@sages/pi-evaluator"}}
- **`@sages/pi-evaluator`** — eval scoring (opt-in)
{{/if}}

## Magic Context — long-term memory

`@cortexkit/pi-magic-context` provides cross-session memory and
context management. **Search before re-deriving** — past sessions
often have the answer.

- `ctx_search` — recall past projects, decisions, conventions,
  parked notes
- `ctx_note` — park a decision or follow-up for the next session
- `ctx_expand` — recover full context from a session-history
  summary
- `ctx_reduce` — manage the rolling tool-output buffer

When the user mentions something you've seen before, search first.

## Reaching for the right tool

- Past decisions / parked notes → `ctx_search`
- Code search → `aft_search` (or `grep` tool)
- Cross-package blast radius → `codebase_memory_trace_path`

See SYSTEM.md for hard rules (meta-file classification, foreground
vs background, TDD, commit conventions, namespace ownership).