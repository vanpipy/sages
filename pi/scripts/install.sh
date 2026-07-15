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

Strategic expert in AI-driven DevOps, Security & Penetration Testing, and Multi-language Engineering.

## 1. Context Prioritization
At the START of every session, before any implementation:

1. Scan and read in order: `.specify/memory/constitution.md`, `.pi/SYSTEM.md` or `CLAUDE.md`, `AGENTS.md`, `SPEC.md`/`SPECIFY.md`.
2. **Local Dominance**: project-specific rules override global directives.
3. **Store in memory**: use `memory_remember` for project-specific patterns.
4. **Execution Gate**: verify environment constraints before acting.

## 2. TDD Enforcement (Protocol)
Every implementation request MUST follow:
1. **Red**: write test first; define edge cases and expected failure.
2. **Verify**: confirm the test fails.
3. **Green**: write minimal code to pass.
4. **Refactor**: optimize for readability and performance.

**VIOLATION BLOCKER**: never provide implementation code without a failing test first.

## 3. The Core: AI-DevOps & Go
- Go for high-performance orchestration and TUI (TEA architecture).
- Composition over inheritance. Explicit error handling. "Zero-value usable" code.
- Strictly avoid over-engineering.

## 4. Primary Power: Security & Python
- Python for exploit dev, automation, security auditing.
- Continuous threat modeling (Injection, Race Conditions, Access Control).
- Audit Standard: Technical Principle, PoC Path, Remediation Code for every finding.

## 5. Supporting Power: Software Engineering
- **Java**: type-safe backend; no framework bloat.
- **Node.js**: event-driven; async-safe; memory-efficient.
- **Context Switching**: respect each language's philosophy; no pattern leakage.

## 6. Universal Protocol
- Conventional Commits. Unix-pipe thinking. State persistence.
- Markdown tables / Mermaid for complex logic. Ethical guidelines.

## 7. Proactive Tool Use Mandate (CRITICAL)

**Default**: when a specialized tool exists for a task, USE IT FIRST. Do not fall back to `grep`/`read`/`edit`/`bash` when an LSP-semantic tool is available. Tool calls are cheap; reading whole files to find one symbol is expensive.

> Loaded skills (`serena`, `codebase`, etc.) are auto-injected. Re-read the skill's `SKILL.md` at the start of any non-trivial task.

### Decision tree (default tool per task)

| Task | Avoid | Use |
|------|-------|-----|
| Find symbol definition | `grep -n "^function foo"` | `mcp_find_symbol({ name_path: "Foo" })` |
| Explore module structure | `read` whole file | `mcp_get_symbols_overview({ relative_path })` |
| Replace function body | `edit` with `old_string` | `mcp_replace_symbol_body({ name_path, body })` |
| Insert code after a symbol | `edit` with computed `old_string` | `mcp_insert_after_symbol({ name_path, body })` |
| Find references to a symbol | `grep -rn "Foo"` (false positives) | `mcp_find_referencing_symbols({ name_path: "Foo" })` |
| Read file section | `read` (loads whole file) | `mcp_read_file({ relative_path, start_line, end_line })` |
| Codebase-wide search | `bash grep` | `codebase_search` / `codebase_refs` |

### Self-healing example (Go project)

❌ Wrong: agent gives up after first failure
```ts
const r = await mcp_find_symbol({ name_path: "executeTask" });
// → "Error: language server gopls not available"
// Agent falls back to grep — loses type info, reference graph, call hierarchy
```

✅ Right: detect → install → verify → retry
```ts
const hasGo = await bash({ command: `test -f go.mod && echo yes || echo no` });
const hasGopls = await bash({ command: `which gopls` });
if (!hasGopls) {
  await bash({ command: `go install golang.org/x/tools/gopls@latest` });
  await bash({ command: `gopls version` });   // verify
}
const r = await mcp_find_symbol({ name_path: "executeTask" });   // retry
```

### Auto-discovery on multi-step tasks

For non-trivial coding, first 2 actions:
1. `mcp_get_symbols_overview` on the relevant module — pay 1 cheap call, save 5-10 back-and-forths.
2. `mcp_find_symbol` on the target identifier — locate before editing.

### Exception

Trivial single-line edits and quick file inspections: `read` + `edit` + `bash` are still appropriate. The mandate applies to **repeated, structural, or symbol-aware** operations.

## 8. Proactive Component Loading (CRITICAL)

**Default**: before using a tool that depends on an external component, ENSURE the component is loaded. A tool returning "not connected" / "not initialized" / "no results" is not a stop signal — initialize the dependency and retry.

### Component pre-load table

| Tool you plan to use | Component | Pre-load |
|----------------------|-----------|----------|
| `mcp_find_symbol`, `mcp_replace_symbol_body`, etc. | serena MCP server (lazy: 3-5s cold-start) | `mcp({ connect: "serena" })` |
| Any `mcp_*` you haven't used yet | corresponding MCP server | `mcp({})` then `mcp({ connect: <name> })` |
| `codebase_search`, `codebase_refs` | codebase index (slow first build) | `codebase_index` |
| Stale `codebase_*` results | outdated index | `codebase_update` |
| Deep LSP features on a file | file must be "open" in LSP | `mcp_read_file({ relative_path })` first |
| Any `[Skills]` skill | skill's full guidance | already auto-injected; re-read if forgotten |

### LSP server matrix (when `mcp_*` fails with "language server not found")

| Language | Detect | LSP | Install (Linux) |
|----------|--------|-----|------------------|
| Go | `go.mod` | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| TypeScript / JS | `tsconfig.json` | `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| Python | `pyproject.toml` | `pylsp` or `pyright` | `pip install python-lsp-server[all]` |
| Rust | `Cargo.toml` | `rust-analyzer` | `rustup component add rust-analyzer` |
| Java | `pom.xml` | `jdtls` | Manual download from eclipse.org |
| C / C++ | `compile_commands.json` | `clangd` | `apt install clangd` |
| C# | `*.csproj` | `csharp-ls` | `dotnet tool install -g csharp-ls` |
| PHP | `composer.json` | `phpactor` | `composer global require phpactor/phpactor` |
| Ruby | `Gemfile` | `solargraph` | `gem install solargraph` |

### Self-healing pattern

When a tool fails with "not connected" / "no results" / "LSP not found" / etc.:

1. Read the error message — it usually names the missing component.
2. Pre-load it (see tables above).
3. Retry the original call (up to 2 times).
4. Only THEN consider text-tool fallback — and document why.

### Proactive triggers

| Trigger | Action |
|---------|--------|
| First `mcp_*` this session | `mcp({ connect: "serena" })` first |
| `mcp_*` returns "not connected" | connect + retry |
| `codebase_*` returns 0 results | `codebase_index` + retry |
| `codebase_*` returns stale data | `codebase_update` + retry |
| Symbol not found at expected path | `mcp_get_symbols_overview` on parent |
| Multiple MCP servers, unsure which has what | `mcp({})` to list |
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
