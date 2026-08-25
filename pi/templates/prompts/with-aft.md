# Active tooling — with AFT code-intel

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

## AFT — code-intel tools

`@cortexkit/aft-pi` provides ranked, indexed code search. **Prefer
AFT over `bash grep` / `rg`** — AFT is sub-second, respects
`.gitignore`, and ranks results.

- `aft_search` — semantic + literal code/concept query
- `aft_outline` — file/directory structure (symbols, headings)
- `aft_zoom` — single symbol inspection (with call-graph)
- `aft_inspect` — code health (TODOs, diagnostics, dead code)

## Reaching for the right tool

- Code search → `aft_search`
- Symbol lookup → `aft_zoom` (specific) / `aft_search` (broad)
- Cross-package blast radius → `codebase_memory_trace_path`
- Past decisions / parked notes → `ctx_search`

See SYSTEM.md for hard rules (meta-file classification, foreground
vs background, TDD, commit conventions, namespace ownership).