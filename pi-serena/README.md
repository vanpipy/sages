# pi-serena

Serena (LSP-based semantic code retrieval/editing) integration for [pi](https://github.com/badlogic/pi-mono/), shipped as a peer extension of [sages](https://github.com/vanpipy/sages).

## What is this?

`pi-serena` is a thin local pi extension that:

1. Registers a curated `.mcp.json` template for [serena](https://github.com/oraios/serena)
2. Enforces a sage-approved security/UX policy:
   - **Silent mode** (no browser pop-ups, no GUI log window)
   - **directTools whitelist** (6 high-frequency tools only)
   - **excludeTools** (no `execute_shell_command`)

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

## What gets registered

After install, you should see `mcp` in your pi tool list. Calling:

```
mcp({})
```

returns the status of all MCP servers. Calling:

```
mcp({ search: "symbol" })
```

discovers serena's symbol-related tools. Calling:

```
mcp({ connect: "serena" })
```

lazily launches serena via `uvx --python 3.13 serena-agent start-mcp-server --context agent --project-from-cwd`.

## Why a separate package?

`pi-serena` is decoupled from `pi/` (sages core) to:

- Keep serena-specific config isolated from the four-sages workflow
- Allow independent versioning (serena upgrades don't touch sages)
- Be reusable by any pi extension, not just sages
- Match the existing peer-extension pattern (`pi-memory`, `pi-codebase-memory`, `pi-yunxiao`)

## Project layout

```
pi-serena/
├── package.json              # pi extension manifest
├── tsconfig.json
├── src/
│   └── index.ts              # extension entry (no-op in v0.1.0)
└── templates/
    └── mcp.json              # sage-curated serena config
```

## Testing

```bash
cd pi-serena
bun install
bun run typecheck
```

## License

MIT
