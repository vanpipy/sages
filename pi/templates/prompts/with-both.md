# Active tooling — full stack (AFT + Magic Context)

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

## AFT — code-intel

`@cortexkit/aft-pi` provides ranked, indexed code search. **Prefer
AFT over `bash grep` / `rg`**.

- `aft_search` — semantic + literal code/concept query
- `aft_outline` — file/directory structure
- `aft_zoom` — single symbol inspection
- `aft_inspect` — code health

## Magic Context — long-term memory

`@cortexkit/pi-magic-context` provides cross-session memory.

- `ctx_search` — recall past projects / decisions / notes
- `ctx_note` — park a decision or follow-up
- `ctx_expand` — recover full context from a session-history summary
- `ctx_reduce` — manage the rolling tool-output buffer

## Reaching for the right tool

- Code search → `aft_search`
- Past decisions / parked notes → `ctx_search`
- Cross-package blast radius → `codebase_memory_trace_path`
- Symbol lookup → `aft_zoom` (specific) / `codebase_refs` (symbol)

See SYSTEM.md for hard rules (meta-file classification, foreground
vs background, TDD, commit conventions, namespace ownership).