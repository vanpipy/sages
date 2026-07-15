#!/usr/bin/env bash
#
# Four Sages Installation Script for pi
# Installs to ~/.pi/packages/sages
#
# Also installs pi-memory for persistent memory capabilities,
# pi-codebase-memory for codebase indexing/search, and
# pi-serena for LSP-based code semantic retrieval/editing via MCP.
#
# Selective install options:
#   --sages-only   only update sages (skip pi-memory, pi-codebase-memory, pi-serena and SYSTEM.md)
#   --system-only  only install/update SYSTEM.md (skip sages, pi-memory, pi-codebase-memory, pi-serena)
#
# These flags are mutually exclusive with --uninstall and each other.
#

set -euo pipefail

# Core paths
PI_DIR="${PI_DIR:-$HOME/.pi}"
PKG_NAME="sages"
PKG_DIR="$PI_DIR/packages/$PKG_NAME"
REPO_URL="https://github.com/vanpipy/sages.git"
AGENT_DIR="$PI_DIR/agent"

# pi-memory package info
PI_MEMORY_PKG="npm:@samfp/pi-memory"

# pi-codebase-memory package info
PI_CODEBASE_MEMORY_PKG="npm:pi-codebase-memory"

# pi-mcp-adapter package info (provides the `mcp` proxy tool — required for serena/lsp MCP integration)
PI_MCP_ADAPTER_PKG="npm:pi-mcp-adapter"

# pi-serena package info (local extension shipped with sages)
# pi-serena is a local package, NOT installed via `pi install`. We register it directly
# in settings.json with the absolute path — same pattern as sages and yunxiao.
PI_SERENA_SRC_REL="pi-serena"
PI_SERENA_DEST_DIR="$PI_DIR/packages/pi-serena"
PI_SERENA_PKG="$PI_SERENA_DEST_DIR"
PI_SERENA_MCP_JSON="$AGENT_DIR/mcp.json"

# Cleanup trap
TMP_DIR=""
cleanup() {
  [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT

usage() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --prefix DIR       Set pi config dir (default: ~/.pi)"
  echo "  --force            Overwrite existing files"
  echo "  --uninstall        Remove installed files"
  echo "  --sages-only       Only install/update sages (skip pi-memory, pi-codebase-memory, pi-serena, SYSTEM.md)"
  echo "  --system-only      Only install/update SYSTEM.md (skip sages, pi-memory, pi-codebase-memory)"
  echo "  --help, -h         Show this help message"
  echo ""
  echo "Modes are mutually exclusive: pick one of (default | --uninstall | --sages-only | --system-only)."
}

check_git() {
  command -v git &>/dev/null || { echo "Error: git is required"; exit 1; }
}

install_pi_if_needed() {
  if ! command -v pi &>/dev/null; then
    echo "==> Installing pi..."
    curl -fsSL https://pi.dev/install.sh | sh || {
      echo "Error: pi installation failed"
      echo "Install manually: curl -fsSL https://pi.dev/install.sh | sh"
      exit 1
    }
  fi
}

is_pi_memory_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1

  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    packages = d.get('packages', [])
    if '$PI_MEMORY_PKG' in packages or '@samfp/pi-memory' in packages:
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_memory() {
  echo "==> Installing pi-memory..."

  # Check if already installed
  if is_pi_memory_installed; then
    echo "  pi-memory already installed"
    return 0
  fi

  # Try using pi install command first
  if command -v pi &>/dev/null; then
    echo "  Installing via 'pi install $PI_MEMORY_PKG'..."
    if pi install "$PI_MEMORY_PKG"; then
      echo "  Installed pi-memory"
      return 0
    fi
    echo "  pi install failed, trying manual..."
  fi

  # Fallback: manually add to settings.json
  echo "  Adding to settings.json..."
  local settings="$PI_DIR/agent/settings.json"
  mkdir -p "$(dirname "$settings")"

  if [[ ! -f "$settings" ]]; then
    echo '{"packages": []}' > "$settings"
  fi

  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_MEMORY_PKG'
try:
    d = json.load(open(f))
except (json.JSONDecodeError, FileNotFoundError):
    d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
json.dump(d, open(f, 'w'), indent=2)
print('  Added', pkg)
"

  echo "  Installed pi-memory"
}

uninstall_pi_memory() {
  echo "==> Uninstalling pi-memory..."

  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && { echo "  No settings file"; return 0; }

  local removed=false
  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_MEMORY_PKG'
try:
    d = json.load(open(f))
    pkgs = d.get('packages', [])
    # Remove exact match or @samfp/pi-memory variant
    new_pkgs = [x for x in pkgs if x != pkg and x != 'pi-memory' and x != '@samfp/pi-memory']
    if len(new_pkgs) < len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('Removed', pkg)
    else:
        print('Not found in settings')
except Exception as e:
    print('Warning:', e, file=sys.stderr)
    sys.exit(1)
"

  # Remove package directory if exists
  local memory_dir="$PI_DIR/packages/pi-memory"
  if [[ -d "$memory_dir" ]]; then
    rm -rf "$memory_dir"
    echo "  Removed $memory_dir"
  fi

  echo "  pi-memory uninstalled"
}

is_pi_codebase_memory_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1

  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    packages = d.get('packages', [])
    if '$PI_CODEBASE_MEMORY_PKG' in packages or 'pi-codebase-memory' in packages:
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_codebase_memory() {
  echo "==> Installing pi-codebase-memory..."

  # Check if already installed
  if is_pi_codebase_memory_installed; then
    echo "  pi-codebase-memory already installed"
    return 0
  fi

  # Try using pi install command first
  if command -v pi &>/dev/null; then
    echo "  Installing via 'pi install $PI_CODEBASE_MEMORY_PKG'..."
    if pi install "$PI_CODEBASE_MEMORY_PKG"; then
      echo "  Installed pi-codebase-memory"
      return 0
    fi
    echo "  pi install failed, trying manual..."
  fi

  # Fallback: manually add to settings.json
  echo "  Adding to settings.json..."
  local settings="$PI_DIR/agent/settings.json"
  mkdir -p "$(dirname "$settings")"

  if [[ ! -f "$settings" ]]; then
    echo '{"packages": []}' > "$settings"
  fi

  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_CODEBASE_MEMORY_PKG'
try:
    d = json.load(open(f))
except (json.JSONDecodeError, FileNotFoundError):
    d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
json.dump(d, open(f, 'w'), indent=2)
print('  Added', pkg)
"

  echo "  Installed pi-codebase-memory"
}

uninstall_pi_codebase_memory() {
  echo "==> Uninstalling pi-codebase-memory..."

  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && { echo "  No settings file"; return 0; }

  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_CODEBASE_MEMORY_PKG'
try:
    d = json.load(open(f))
    pkgs = d.get('packages', [])
    # Remove exact match or pi-codebase-memory variant
    new_pkgs = [x for x in pkgs if x != pkg and x != 'pi-codebase-memory']
    if len(new_pkgs) < len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('Removed', pkg)
    else:
        print('Not found in settings')
except Exception as e:
    print('Warning:', e, file=sys.stderr)
    sys.exit(1)
"

  # Remove package directory if exists
  local memory_dir="$PI_DIR/packages/pi-codebase-memory"
  if [[ -d "$memory_dir" ]]; then
    rm -rf "$memory_dir"
    echo "  Removed $memory_dir"
  fi

  echo "  pi-codebase-memory uninstalled"
}

# ────────────────────────────────────────────────────────────
# pi-mcp-adapter: provides the `mcp` proxy tool + direct tool registration
# ────────────────────────────────────────────────────────────

is_pi_mcp_adapter_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1

  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    packages = d.get('packages', [])
    if '$PI_MCP_ADAPTER_PKG' in packages or 'pi-mcp-adapter' in packages:
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_mcp_adapter() {
  echo "==> Installing pi-mcp-adapter..."

  # Check if already installed
  if is_pi_mcp_adapter_installed; then
    echo "  pi-mcp-adapter already installed"
    return 0
  fi

  # Try using pi install command first
  if command -v pi &>/dev/null; then
    echo "  Installing via 'pi install $PI_MCP_ADAPTER_PKG'..."
    if pi install "$PI_MCP_ADAPTER_PKG"; then
      echo "  Installed pi-mcp-adapter"
      return 0
    fi
    echo "  pi install failed, trying manual..."
  fi

  # Fallback: manually add to settings.json
  echo "  Adding to settings.json..."
  local settings="$PI_DIR/agent/settings.json"
  mkdir -p "$(dirname "$settings")"

  if [[ ! -f "$settings" ]]; then
    echo '{"packages": []}' > "$settings"
  fi

  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_MCP_ADAPTER_PKG'
try:
    d = json.load(open(f))
except (json.JSONDecodeError, FileNotFoundError):
    d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Added', pkg)
"

  echo "  Installed pi-mcp-adapter (note: npm package may not be physically installed; run 'pi install npm:pi-mcp-adapter' to fetch)"
}

uninstall_pi_mcp_adapter() {
  echo "==> Uninstalling pi-mcp-adapter..."

  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && { echo "  No settings file"; return 0; }

  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_MCP_ADAPTER_PKG'
try:
    d = json.load(open(f))
    pkgs = d.get('packages', [])
    new_pkgs = [x for x in pkgs if x != pkg and x != 'pi-mcp-adapter']
    if len(new_pkgs) < len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('Removed', pkg)
    else:
        print('Not found in settings')
except Exception as e:
    print('Warning:', e, file=sys.stderr)
    sys.exit(1)
"

  # Note: npm package is in /home/leroy/.pi/agent/npm/node_modules, NOT PI_DIR/packages,
  # so we don't rm -rf any dir under PI_DIR/packages. User can manually uninstall via
  # `pi remove npm:pi-mcp-adapter` if desired.

  echo "  pi-mcp-adapter uninstalled (npm pkg left in place, run 'pi remove' to fully remove)"
}

install_system_prompt() {
  mkdir -p "$AGENT_DIR"

  if [[ -f "$AGENT_DIR/SYSTEM.md" && "${FORCE:-false}" != true ]]; then
    echo "  SYSTEM.md already exists (use --force to overwrite)"
    return 0
  fi

  cat > "$AGENT_DIR/SYSTEM.md" << 'EOF'
# Role: DevSecOps & Polyglot Systems Engineer

You are a strategic expert specializing in AI-driven DevOps (The Command Center), Security & Penetration Testing (The Primary Capability), and Multi-language Engineering (The Supporting Capability).

## 1. Context Prioritization & Constitution (First Priority)
**At the START of EVERY session, before any implementation work:**

1. **Scan for and read these files IN ORDER:**
   - `.specify/memory/constitution.md` - project constitution
   - `.pi/SYSTEM.md` or `CLAUDE.md` - project-specific overrides
   - `AGENTS.md` - agent instructions
   - `SPEC.md` or `SPECIFY.md` - project specifications

2. **Local Dominance**: Project-specific rules in these files override global directives.

3. **Store in memory**: Use `memory_remember` to persist project-specific rules, conventions, and patterns for future sessions.

4. **Execution Gate**: Before taking action, verify the specific constraints of the current environment to ensure architectural consistency.

## 2. TDD Enforcement Hook (Protocol)
**Every implementation request MUST follow this strict sequence:**
1. **Red Stage**: Write the test case first. Define edge cases and expected failure.
2. **Verification Stage**: Execute or simulate the test to confirm failure.
3. **Green Stage**: Write the minimal code necessary to pass the test.
4. **Refactor Stage**: Optimize for readability and performance.
**VIOLATION BLOCKER**: You are strictly prohibited from providing implementation code without first providing the test.

## 3. The Core: AI-DevOps & Go
- **Command Logic**: Use Go for high-performance orchestration and TUI (TEA architecture) systems.
- **Architectural Integrity**: Favor composition over inheritance. Prioritize explicit error handling and "zero-value usable" code.
- **Minimalism**: Strictly avoid over-engineering and unnecessary abstractions.

## 4. Primary Power: Security & Python
- **Offensive Mindset**: Use Python for exploit development, automation, and deep security auditing.
- **Threat Awareness**: Perform continuous threat modeling (Injection, Race Conditions, Access Control) by default.
- **Audit Standard**: Provide Technical Principle, PoC Path, and Remediation Code for all findings.

## 5. Supporting Power: Software Engineering
- **Java**: Provide type-safe backend support. Maintain clean code without framework bloat.
- **Node.js**: Handle event-driven tasks focusing on asynchronous safety and memory efficiency.
- **Context Switching**: Respect the unique philosophy of each language; do not leak design patterns across ecosystems.

## 6. Universal Protocol
- **Version Control**: Mandatory adherence to Conventional Commits.
- **Automation First**: Think in terms of Unix-pipe philosophy and state persistence.
- **Communication**: Be direct and technical. Use Markdown tables or Mermaid flowcharts for complex logic.
- **Compliance**: All activities must follow ethical guidelines within authorized scopes.

## 7. Proactive Tool Use Mandate (CRITICAL)

**Default behavior**: When a specialized tool exists for a task, USE IT FIRST. Do not fall back to `grep` / `read` / `edit` / `bash` when an LSP-semantic tool is available. Tool calls are cheap; reading the whole file to find one symbol is expensive.

> Loaded skills (e.g. `serena`, `codebase`) are auto-injected as full guidance — read the skill's `SKILL.md` once at the start of any non-trivial task.

### Decision tree (default tool per task)

| Task | ❌ Avoid (text-based) | ✅ Use (semantic tool) |
|------|----------------------|------------------------|
| Find a function/class definition | `grep -n "^function foo"` (noisy, imprecise) | `mcp_find_symbol({ name_path: "Foo" })` |
| Understand a module's structure | `read` whole file + scan for `export` | `mcp_get_symbols_overview({ relative_path: "src/..." })` |
| Replace a function body | `edit` with `old_string` (breaks on whitespace/indent) | `mcp_replace_symbol_body({ name_path, body })` |
| Insert code after a symbol | `edit` with manually-computed `old_string` | `mcp_insert_after_symbol({ name_path, body })` |
| Find all references to a symbol | `grep -rn "Foo"` (false positives) | `mcp_find_referencing_symbols({ name_path: "Foo" })` |
| Read a specific section of a file | `read` (loads whole file) | `mcp_read_file({ relative_path, start_line, end_line })` |
| Index / search the whole codebase | `bash grep` | `codebase_search` / `codebase_refs` (already-built index) |

### Trigger phrases (natural language → tool)

| User says | Tool |
|-----------|------|
| "找 X 的定义 / locate symbol X / where is X defined" | `mcp_find_symbol` |
| "X 模块长什么样 / explore module structure" | `mcp_get_symbols_overview` |
| "谁用了 X / callers of X / references to X" | `mcp_find_referencing_symbols` |
| "替换 X 函数体 / replace function body" | `mcp_replace_symbol_body` |
| "在 X 后插入 / insert after X" | `mcp_insert_after_symbol` |
| "读 X 文件 / read the file at X" | `mcp_read_file` |

### Concrete wrong-vs-right

❌ Wrong (manual, fragile):
```ts
// Finding symbol by grep — fragile and noisy
const match = await bash({ command: `grep -n "executeTask" src/tools/luban/index.ts` });
// Replacing via string match — breaks on whitespace/quote differences
await edit({ old_string: "function executeTask(t) { /* 30-line old body */ }", ... });
```

✅ Right (semantic, robust):
```ts
// Semantic symbol lookup
await mcp_find_symbol({ name_path: "executeTask", depth: 0 });
// Semantic body replacement (no string matching)
await mcp_replace_symbol_body({ name_path: "executeTask", body: "async function executeTask(t) { /* new body */ }" });
```

### Exception

For trivial single-line edits and quick file inspections, `read` + `edit` + `bash` are still appropriate. The mandate applies to **repeated, structural, or symbol-aware operations** — exactly the cases that should leverage LSP semantics.

### Auto-discovery on multi-step tasks

For any non-trivial coding task, the first 2 actions should be:

1. `mcp_get_symbols_overview` on the relevant module — pay 1 cheap call, save 5-10 back-and-forths.
2. `mcp_find_symbol` on the target identifier — locate before editing.

Skipping these steps "to save time" always costs more time than it saves.

## 8. Proactive Component Loading (CRITICAL)

**Default behavior**: Before using a tool that depends on an external component, ENSURE the component is loaded. Do not call a tool that returns "not connected" / "not initialized" / "no results" and then give up — initialize the dependency and retry. This applies to MCP servers, code indexes, LSP file opens, and skill lookups.

### What needs pre-loading

| Tool you plan to use | Component to load | Pre-load action |
|----------------------|-------------------|-----------------|
| `mcp_find_symbol`, `mcp_replace_symbol_body`, `mcp_read_file`, etc. | serena MCP server (lazy: cold-start ~3–5s on first call) | `mcp({ connect: "serena" })` |
| Any `mcp_*` tool you haven't used yet in this session | The corresponding MCP server | `mcp({})` to list servers, then `mcp({ connect: <name> })` |
| `codebase_search`, `codebase_refs` | Codebase index (built once, refreshed on file changes) | `codebase_index` (slow first time, ~5–60s depending on repo size) |
| `codebase_search` returning stale/missing results | Outdated index | `codebase_update` (re-index) |
| `mcp_*` symbol ops on a TypeScript/Python file (deep LSP features) | The target file must be "open" in the LSP server | `mcp_read_file({ relative_path })` to register the file before symbol ops |
| Any skill listed in `[Skills]` (e.g. `serena`, `codebase`, `graphify`) | Skill's full guidance | Already auto-injected — re-read if you forgot the decision tree |

### Self-healing on tool failure

When a tool returns ANY of:
- `"not connected"` / `"not initialized"` / `"not loaded"`
- Empty result with a hint that something needs initialization
- `"index not found"` / `"no such project"` / `"file not open"`
- Slow first call (cold-start)

Then **do not give up and fall back to text tools**. Instead:

1. **Read the error message carefully** — it usually names the missing component.
2. **Pre-load the component** (see table above).
3. **Retry the original tool call** up to 2 times.
4. Only THEN consider text-based fallback (and document why in the response).

### Concrete wrong-vs-right

❌ Wrong (give up after first error):
```ts
const r = await mcp_find_symbol({ name_path: "executeTask" });
// → "Error: serena MCP not connected"
// Agent: "OK, let me grep instead"
// const m = await bash({ command: `grep -rn "executeTask" src/` });
```

✅ Right (recover by initializing):
```ts
// Detect missing component from first error
await mcp({ connect: "serena" });     // ~3-5s cold start, ONE time
// Retry — now it works
const r = await mcp_find_symbol({ name_path: "executeTask", depth: 0 });
```

❌ Wrong (use unindexed codebase):
```ts
const hits = await codebase_search({ query: "executeTask" });
// → [] (index is stale or empty)
// Agent: "No results, giving up"
```

✅ Right (rebuild index first):
```ts
await codebase_index();             // ~30s on large repos, ONE time per project
const hits = await codebase_search({ query: "executeTask" });
```

### Proactive vs reactive decision matrix

| Trigger | Action |
|---------|--------|
| First `mcp_*` call in this session | Connect first (`mcp({ connect: "serena" })`) |
| `mcp_*` returns "not connected" | Connect + retry |
| `codebase_*` returns 0 results | Index + retry |
| `codebase_*` returns stale data (file changed since index) | Update + retry |
| Symbol not found at expected `name_path` | `mcp_get_symbols_overview` on parent to discover structure |
| Skill loaded but you forgot details | Re-read its `SKILL.md` (path in the [Skills] prompt section) |
| Multiple MCP servers configured but you don't know which has what | `mcp({})` first to list all servers + their tool counts |
| `mcp_*` fails with "language server not found" / "LSP not available" | See **Language-Specific LSP Initialization** below |

### Language-Specific LSP Initialization

When serena returns errors like `"language server gopls not found"`, `"no LSP for python"`, `"LSP not installed"`, or symbol ops return empty on a project that clearly has the language — the missing piece is the **per-language LSP server**, not the serena MCP itself. serena delegates semantic analysis to external LSP servers.

#### LSP server matrix

| Language | Detect via | LSP server | Install command (Linux) | Verify |
|----------|-----------|-------------|------------------------|--------|
| **Go** | `go.mod` | `gopls` | `go install golang.org/x/tools/gopls@latest` | `gopls version` |
| **TypeScript / JavaScript** | `tsconfig.json` / `package.json` | `typescript-language-server` | `npm install -g typescript-language-server typescript` | `typescript-language-server --version` |
| **Python** | `pyproject.toml` / `setup.py` | `pylsp` or `pyright` | `pip install python-lsp-server[all]` OR `pip install pyright` | `pylsp --help` OR `pyright --version` |
| **Rust** | `Cargo.toml` | `rust-analyzer` | `rustup component add rust-analyzer` | `rust-analyzer --version` |
| **Java** | `pom.xml` / `build.gradle` | `jdtls` | Manual download from `https://download.eclipse.org/jdtls/snapshots/` | `java -jar jdtls.jar` |
| **C / C++** | `compile_commands.json` / `CMakeLists.txt` | `clangd` | `apt install clangd` (Debian/Ubuntu) | `clangd --version` |
| **C#** | `*.csproj` | `csharp-ls` | `dotnet tool install -g csharp-ls` | `csharp-ls --help` |
| **PHP** | `composer.json` | `phpactor` | `composer global require phpactor/phpactor` | `phpactor --version` |
| **Ruby** | `Gemfile` | `solargraph` | `gem install solargraph` | `solargraph --version` |

#### Recovery pattern (LSP missing)

When `mcp_find_symbol` (or any symbol-level op) fails on a project with a known language:

```
1. DETECT language
   ls <project_root> for go.mod / package.json / pyproject.toml / Cargo.toml / etc.

2. CHECK if LSP exists
   which <lsp>   # e.g. which gopls, which typescript-language-server
   <lsp> --version

3. INSTALL if missing
   <install command from table above>
   If install fails (e.g., missing system deps), surface the error and ASK the user
   before falling back to text tools.

4. VERIFY
   <lsp> --version   # confirm binary is now in PATH

5. RETRY the original mcp_* call
   The LSP server needs a moment to index the project; first call may be slow.
```

#### Concrete example: Go project

❌ Wrong (agent gives up after first failure):
```ts
const r = await mcp_find_symbol({ name_path: "executeTask", relative_path: "src/main.go" });
// → "language server gopls not available"
// Agent: "Let me grep instead"
// const m = await bash({ command: `grep -n "func executeTask" .` });
```

✅ Right (detect → install → verify → retry):
```ts
// 1. Detect language
const hasGo = await bash({ command: `test -f go.mod && echo yes || echo no` });
// 2. Check LSP
const hasGopls = await bash({ command: `which gopls` });
if (!hasGopls) {
  // 3. Install (assumes Go toolchain is installed)
  await bash({ command: `go install golang.org/x/tools/gopls@latest` });
  // 4. Verify
  const ver = await bash({ command: `gopls version` });
}
// 5. Retry (first call after install may be slow while LSP indexes the project)
const r = await mcp_find_symbol({ name_path: "executeTask", relative_path: "src/main.go" });
```

#### Why this matters

- `mcp_find_symbol` on a Go project without `gopls` returns empty or errors — looks like the project has no symbols.
- Falling back to `grep` finds the function but loses type info, reference graph, call hierarchy.
- The cost of installing `gopls` is one `go install` (5-30s) and is amortized over the entire session.
- LSP gives semantic understanding that grep cannot match.

EOF

  echo "  Installed SYSTEM.md"
}

get_settings_packages() {
  local settings="$PI_DIR/agent/settings.json"
  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    print(json.dumps(d.get('packages', [])))
except:
    print('[]')
" 2>/dev/null
}

is_sages_installed() {
  [[ -d "$PKG_DIR" && -f "$PKG_DIR/package.json" ]]
}

register_settings() {
  local settings="$PI_DIR/agent/settings.json"
  mkdir -p "$(dirname "$settings")"

  if [[ ! -f "$settings" ]]; then
    echo '{"packages": []}' > "$settings"
  fi

  python3 -c "
import json, sys
f, pkg = '$settings', '$PKG_DIR'
try:
    d = json.load(open(f))
except (json.JSONDecodeError, FileNotFoundError):
    d = {'packages': []}
# Remove existing sages entry, then add
d['packages'] = [x for x in d.get('packages', []) if x != pkg and '$PKG_NAME' not in x]
if pkg not in d['packages']:
    d['packages'].append(pkg)
json.dump(d, open(f, 'w'), indent=2)
print('Registered sages')
"
}

unregister_settings() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 0

  python3 -c "
import json, sys
f, pkg = '$settings', '$PKG_DIR'
try:
    d = json.load(open(f))
    d['packages'] = [x for x in d.get('packages', []) if x != pkg and '$PKG_NAME' not in x]
    json.dump(d, open(f, 'w'), indent=2)
    print('Unregistered sages')
except Exception as e:
    print('Warning:', e, file=sys.stderr)
"
}

# ────────────────────────────────────────────────────────────
# 共享:克隆 + 复制 sages 文件
# ────────────────────────────────────────────────────────────
install_sages_files() {
  check_git
  TMP_DIR=$(mktemp -d)
  echo "  Cloning from $REPO_URL..."
  git clone "$REPO_URL" "$TMP_DIR" || {
    echo "Error: Failed to clone sages repository"
    return 1
  }

  mkdir -p "$PKG_DIR"
  for dir in prompts skills extensions src; do
    local src_dir="$TMP_DIR/pi/$dir"
    local dest_dir="$PKG_DIR/$dir"

    if [[ ! -d "$src_dir" ]]; then
      continue
    fi

    if [[ -d "$dest_dir" && "${FORCE:-false}" != true ]]; then
      echo "  Skipping $dir/ (exists, use --force to overwrite)"
    else
      rm -rf "$dest_dir"
      cp -r "$src_dir" "$PKG_DIR/"
      echo "  Installed $dir/"
    fi
  done

  # [修复] 也复制 .sages/workflows/ 模板——/sages-init 用它
  local src_workflows="$TMP_DIR/pi/.sages/workflows"
  local dest_workflows="$PKG_DIR/.sages/workflows"
  if [[ -d "$src_workflows" ]]; then
    if [[ -d "$dest_workflows" && "${FORCE:-false}" != true ]]; then
      echo "  Skipping .sages/workflows/ (exists, use --force to overwrite)"
    else
      mkdir -p "$PKG_DIR/.sages"
      rm -rf "$dest_workflows"
      cp -r "$src_workflows" "$dest_workflows"
      echo "  Installed .sages/workflows/"
    fi
  fi

  # Handle package.json
  if [[ -f "$PKG_DIR/package.json" && "${FORCE:-false}" != true ]]; then
    echo "  Keeping existing package.json"
  elif [[ -f "$TMP_DIR/pi/package.json" ]]; then
    cp "$TMP_DIR/pi/package.json" "$PKG_DIR/package.json"
    echo "  Installed package.json"
  fi

  # Install dependencies into $PKG_DIR/node_modules
  if [[ -f "$PKG_DIR/package.json" ]] && command -v bun &>/dev/null; then
    echo "  Installing dependencies (bun install)..."
    (cd "$PKG_DIR" && bun install --silent 2>&1 | tail -3) || {
      echo "  Warning: bun install failed, deps may be missing"
    }
  fi

  register_settings
}

# ────────────────────────────────────────────────────────────
# pi-serena: 复制本地 pi-serena/ 到 $PI_DIR/packages/pi-serena/
# ────────────────────────────────────────────────────────────
install_serena_files() {
  local src_root="$TMP_DIR/$PI_SERENA_SRC_REL"

  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in clone, skipping pi-serena files"
    return 0
  }

  if [[ -d "$PI_SERENA_DEST_DIR" && "${FORCE:-false}" != true ]]; then
    echo "  Skipping pi-serena files (exists at $PI_SERENA_DEST_DIR, use --force to overwrite)"
  else
    rm -rf "$PI_SERENA_DEST_DIR"
    mkdir -p "$PI_DIR/packages"
    cp -r "$src_root" "$PI_SERENA_DEST_DIR"
    echo "  Installed pi-serena files to $PI_SERENA_DEST_DIR"
  fi

  # Install pi-serena deps if package.json exists and bun is available
  if [[ -f "$PI_SERENA_DEST_DIR/package.json" ]] && command -v bun &>/dev/null; then
    echo "  Installing pi-serena dependencies (bun install)..."
    (cd "$PI_SERENA_DEST_DIR" && bun install --silent 2>&1 | tail -3) || {
      echo "  Warning: pi-serena bun install failed, deps may be missing"
    }
  fi
}

write_serena_mcp_config() {
  # Locate the template: prefer the installed copy, fall back to the freshly-cloned TMP_DIR
  local template=""
  if [[ -f "$PI_SERENA_DEST_DIR/templates/mcp.json" ]]; then
    template="$PI_SERENA_DEST_DIR/templates/mcp.json"
  elif [[ -f "$TMP_DIR/$PI_SERENA_SRC_REL/templates/mcp.json" ]]; then
    template="$TMP_DIR/$PI_SERENA_SRC_REL/templates/mcp.json"
  fi

  if [[ -z "$template" ]]; then
    echo "  Warning: mcp.json template not found, skipping"
    return 0
  fi

  if [[ -f "$PI_SERENA_MCP_JSON" && "${FORCE:-false}" != true ]]; then
    echo "  mcp.json exists at $PI_SERENA_MCP_JSON (use --force to overwrite)"
    return 0
  fi

  mkdir -p "$(dirname "$PI_SERENA_MCP_JSON")"
  cp "$template" "$PI_SERENA_MCP_JSON"
  echo "  Wrote $PI_SERENA_MCP_JSON from template"
}

is_pi_serena_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1

  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    # Exact match: avoid substring collision with hypothetical 'pi-serena-extras' etc.
    if any(p == 'pi-serena' or p == '$PI_SERENA_PKG' or p.endswith('/pi-serena') for p in pkgs):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_serena() {
  echo "==> Installing pi-serena..."

  # Idempotency: if already registered and not forcing, only ensure mcp.json exists
  if is_pi_serena_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-serena already installed (use --force to reinstall)"
    write_serena_mcp_config
    return 0
  fi

  # Copy files from clone to permanent location (must succeed for registration to work)
  if ! install_serena_files; then
    echo "  Error: install_serena_files failed, aborting pi-serena install"
    return 1
  fi

  # Register directly in settings.json with absolute path
  # (matches sages/yunxiao pattern — no `pi install` needed for local packages)
  if is_pi_serena_installed; then
    echo "  pi-serena already registered in settings.json"
  else
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ ! -f "$settings" ]] && echo '{"packages": []}' > "$settings"
    echo "  Registering pi-serena in settings.json..."
    python3 -c "
import json
f, pkg = '$settings', '$PI_SERENA_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
print('  Registered', pkg)
"
  fi

  # Write the curated .mcp.json (only if absent)
  write_serena_mcp_config

  echo "  pi-serena installed"
}

uninstall_pi_serena() {
  echo "==> Uninstalling pi-serena..."

  local settings="$PI_DIR/agent/settings.json"

  # Remove from settings.json (exact match to avoid substring collision)
  [[ -f "$settings" ]] && python3 -c "
import json
f = '$settings'
try:
    d = json.load(open(f))
    d['packages'] = [x for x in d.get('packages', []) if not (x == 'pi-serena' or x == '$PI_SERENA_PKG' or x.endswith('/pi-serena'))]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Removed pi-serena from settings.json')
except Exception as e:
    print('  Warning:', e)
"

  # Remove the installed directory
  if [[ -d "$PI_SERENA_DEST_DIR" ]]; then
    rm -rf "$PI_SERENA_DEST_DIR"
    echo "  Removed $PI_SERENA_DEST_DIR"
  fi

  # Note: we deliberately KEEP ~/.pi/agent/mcp.json because users
  # may have customized it with additional MCP servers.
  echo "  pi-serena uninstalled (kept $PI_SERENA_MCP_JSON)"
}

# ────────────────────────────────────────────────────────────
# 模式 1:全量安装(默认)
# ────────────────────────────────────────────────────────────
install() {
  echo "==> Installing sages + pi-memory + pi-codebase-memory + pi-serena..."

  # Pre-flight checks
  install_pi_if_needed

  # Verify pi is available
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi

  # Install pi-memory first
  install_pi_memory

  # Install pi-codebase-memory
  install_pi_codebase_memory

  # Install pi-mcp-adapter (provides mcp proxy tool, required for serena/lsp MCP)
  install_pi_mcp_adapter

  # Install sages first (git clone populates TMP_DIR, needed by install_pi_serena)
  echo "==> Installing sages..."
  install_sages_files || exit 1

  # Install pi-serena (uses TMP_DIR/pi-serena from the clone above)
  install_pi_serena || true

  # Install system prompt
  install_system_prompt

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# 模式 2:仅更新 sages(跳过 pi-memory、pi-codebase-memory 和 SYSTEM.md)
# ────────────────────────────────────────────────────────────
install_sages_only() {
  echo "==> Installing sages only (skip pi-memory, pi-codebase-memory, pi-serena, skip SYSTEM.md)..."

  # Pre-flight: pi 仍然需要(sages 是 pi extension)
  install_pi_if_needed
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi

  # 仅安装 sages 文件
  echo "==> Installing sages..."
  install_sages_files || exit 1

  # 显式不调用 install_pi_memory / install_pi_codebase_memory / install_pi_serena / install_system_prompt
  echo "  (skipped: pi-memory, pi-codebase-memory, pi-serena, SYSTEM.md)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# 模式 3:仅更新 SYSTEM.md(跳过 sages、pi-memory 和 pi-codebase-memory)
# ────────────────────────────────────────────────────────────
install_system_only() {
  echo "==> Installing SYSTEM.md only (skip sages, pi-memory, pi-codebase-memory, pi-serena)..."
  # 不需要 git / pi —— SYSTEM.md 是独立 markdown
  install_system_prompt
  echo "  (skipped: sages, pi-memory, pi-codebase-memory, pi-serena)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# 卸载(同时移除 sages、pi-memory 和 pi-codebase-memory)
# ────────────────────────────────────────────────────────────
uninstall() {
  echo "==> Uninstalling sages + pi-memory + pi-codebase-memory + pi-serena..."

  # Remove sages
  if [[ -d "$PKG_DIR" ]]; then
    rm -rf "$PKG_DIR"
    echo "  Removed sages"
  fi

  # Unregister sages
  unregister_settings

  # Uninstall pi-memory
  uninstall_pi_memory

  # Uninstall pi-codebase-memory
  uninstall_pi_codebase_memory

  # Uninstall pi-mcp-adapter
  uninstall_pi_mcp_adapter

  # Uninstall pi-serena
  uninstall_pi_serena

  echo ""
  echo "Done. Restart pi: exit && pi"
}

main() {
  local FORCE=false UNINSTALL=false SAGES_ONLY=false SYSTEM_ONLY=false
  local MODE_COUNT=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix)
        PI_DIR="$2"
        PKG_DIR="$PI_DIR/packages/$PKG_NAME"
        shift 2
        ;;
      --force) FORCE=true; shift ;;
      --uninstall) UNINSTALL=true; MODE_COUNT=$((MODE_COUNT+1)); shift ;;
      --sages-only) SAGES_ONLY=true; MODE_COUNT=$((MODE_COUNT+1)); shift ;;
      --system-only) SYSTEM_ONLY=true; MODE_COUNT=$((MODE_COUNT+1)); shift ;;
      --help|-h) usage; exit 0 ;;
      *) echo "Error: Unknown option: $1"; usage; exit 1 ;;
    esac
  done

  # 互斥校验:一次只能选一种模式
  if [[ "$MODE_COUNT" -gt 1 ]]; then
    echo "Error: --uninstall, --sages-only, --system-only are mutually exclusive"
    echo "Pick at most one of them (or none for full install)."
    usage
    exit 1
  fi

  if $UNINSTALL; then
    uninstall
  elif $SAGES_ONLY; then
    install_sages_only
  elif $SYSTEM_ONLY; then
    install_system_only
  else
    install
  fi
}

main "$@"
