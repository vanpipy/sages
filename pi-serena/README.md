# pi-serena

Serena (LSP-based semantic code retrieval/editing) integration for [pi](https://github.com/badlogic/pi-mono/), shipped as a peer extension of [sages](https://github.com/vanpipy/sages).

> ⚠️ **v0.2.0**: now includes `SKILL.md` so the LLM knows when to use serena tools. The 6 first-class tools below are registered automatically; the `mcp` proxy tool covers the long tail.

## What is this?

`pi-serena` is a thin local pi extension that:

1. Registers a curated `.mcp.json` template for [serena](https://github.com/oraios/serena)
2. Enforces a sage-approved security/UX policy:
   - **Silent mode** (no browser pop-ups, no GUI log window)
   - **directTools whitelist** (6 high-frequency tools only)
   - **excludeTools** (no `execute_shell_command`)
3. Ships `skills/serena/SKILL.md` so the LLM knows when to use serena
4. Adds lifecycle hooks (`session_start`) to surface mcp status in sage workspaces

It does **not** register any sage-prefixed tools. The `mcp` proxy tool comes from [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), which is a separate global peer extension.

## Install

`pi-serena` is not installed directly. It is shipped alongside `sages` and installed by `pi/scripts/install.sh`:

```bash
./pi/scripts/install.sh   # installs sages + pi-memory + pi-codebase-memory + pi-serena
```

The install will:

1. Copy `pi-serena/` to `~/.pi/packages/pi-serena/`
2. Run `pi install file:$HOME/.pi/packages/pi-serena` to register the extension
3. Write `~/.pi/agent/mcp.json` from `templates/mcp.json` (only if absent)

After install, restart pi and run `/mcp` to verify serena appears in the list.

## What gets registered

After install, you should see these tools in your pi tool list:

### First-class tools (6, registered directly)

| Tool | Purpose |
|------|---------|
| `mcp_find_symbol` | Find a symbol (function/class/variable) by name path |
| `mcp_get_symbols_overview` | High-level map of a file/module's structure |
| `mcp_find_referencing_symbols` | Find all references to a symbol (use before refactoring) |
| `mcp_read_file` | Read a file or a range of lines |
| `mcp_replace_symbol_body` | Precisely replace a function body (no string surgery) |
| `mcp_insert_after_symbol` | Insert code after a given symbol (no manual line counting) |

These are promoted to first-class so the LLM sees them in the system prompt without needing to call `mcp({search: ...})` first. Cost: ~150-300 tokens each.

### Proxy tool (1, for the long tail)

| Tool | Purpose |
|------|---------|
| `mcp` | Universal gateway to all 27 serena tools + any other MCP servers |

Use this for the other 21 serena tools not in the whitelist (`mcp_rename_symbol`, `mcp_safe_delete_symbol`, `mcp_search_for_pattern`, etc.):

```js
mcp({ tool: "serena_rename_symbol", args: '{"name_path":"Foo","new_name":"Bar"}' })
mcp({ search: "rename" })              // fuzzy search tool name
mcp({ describe: "serena_rename_symbol" }) // see parameter schema
mcp({ connect: "serena" })             // pre-warm (lazy by default)
mcp({})                                // see all server status
```

## Why a separate package?

`pi-serena` is decoupled from `pi/` (sages core) to:

- Keep serena-specific config isolated from the four-sages workflow
- Allow independent versioning (serena upgrades don't touch sages)
- Be reusable by any pi extension, not just sages
- Match the existing peer-extension pattern (`pi-memory`, `pi-codebase-memory`, `pi-yunxiao`)

## Integration with four sages

| Sage stage | Recommended serena usage |
|------------|-------------------------|
| **Fuxi (design)** | `mcp_get_symbols_overview` + `mcp_find_symbol` to map module boundaries before designing |
| **QiaoChui (decompose)** | `mcp_find_referencing_symbols` to identify impact surface of a change |
| **LuBan (execute)** | `mcp_replace_symbol_body` / `mcp_insert_after_symbol` for precise edits (not string surgery) |
| **GaoYao (audit)** | `mcp_find_referencing_symbols` to verify a commit actually changed the intended references |

> 💡 For LLM: read `skills/serena/SKILL.md` (auto-injected into system prompt) for the full decision tree.

## Project layout

```
pi-serena/
├── package.json              # pi extension + skills manifest
├── tsconfig.json
├── README.md
├── src/
│   └── index.ts              # extension entry + lifecycle hooks
├── skills/
│   └── serena/
│       └── SKILL.md          # LLM-facing skill (auto-injected)
└── templates/
    └── mcp.json              # sage-curated serena config
```

## Security constraints (non-negotiable)

| Constraint | Reason |
|------------|--------|
| `execute_shell_command` **excluded** | Prevents LLM from bypassing sage bash sandbox |
| Silent mode forced on | No browser pop-ups / GUI log windows during dev |
| 6-tool whitelist | 27 tools would burn ~8k context; we use the 6 most common |
| `outputGuard: 50KB / 2000 lines` | One huge response won't blow up context |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `mcp` tool not in tool list | `pi-mcp-adapter` not installed | `pi install npm:pi-mcp-adapter` |
| `mcp({connect: "serena"})` hangs 30s+ | First-time `uvx` pulling deps (one-time) | Wait; subsequent calls are fast |
| `Tool not found: mcp_xxx` | Wrong direct-tool name | Use `mcp({search: "xxx"})` to find the actual name |
| `mcp.json exists at ~/.pi/agent/mcp.json (use --force to overwrite)` | Changed template, didn't take effect | `pi/scripts/install.sh --force` |
| Serena opens Chrome browser | Silent mode not enforced | Re-run `pi install file:./pi-serena`; check `--enable-web-dashboard false` in `~/.pi/agent/mcp.json` |
| `[pi-serena] sage workspace detected. serena MCP NOT configured` on session start | mcp.json missing | Run `./pi/scripts/install.sh` |

## Testing

```bash
cd pi-serena
bun install
bun run typecheck
```

End-to-end smoke test:

```bash
# After installing, in a sages workspace:
pi --print --tools mcp "Call mcp({}) and report server status verbatim"
# Should show: "serena (27 tools)"
```

## License

MIT
