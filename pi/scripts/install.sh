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

# Resolve this script's directory (works whether invoked by absolute path, symlink, or relative)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# SYSTEM.md template (single source of truth for all three install scripts: .sh / .ps1 / .bat)
SYSTEM_TEMPLATE="$SCRIPT_DIR/../templates/SYSTEM.md"

# pi-memory package info
PI_MEMORY_PKG="npm:@samfp/pi-memory"

# pi-codebase-memory npm pkg identifier (single source of truth for is/install/uninstall)
PI_CODEBASE_MEMORY_PKG="npm:pi-codebase-memory"

# pi-mcp-adapter package info (provides the `mcp` proxy tool — required for serena/lsp MCP integration)
PI_MCP_ADAPTER_PKG="npm:pi-mcp-adapter"

# pi-codebase-memory sage-peer (local package, installed by file-copy not `pi install npm:`)
PI_CODEBASE_MEMORY_PKG_NAME="@sages/pi-codebase-memory"
PI_CODEBASE_MEMORY_SRC_REL="pi-codebase-memory"
PI_CODEBASE_MEMORY_DEST_DIR="$PI_DIR/packages/pi-codebase-memory"
# Local-peer package identifier (the dest dir path, registered in settings.json like pi-serena)
PI_CODEBASE_MEMORY_LOCAL_PKG="$PI_CODEBASE_MEMORY_DEST_DIR"

# codebase-memory-mcp binary install info
CBM_REPO="DeusData/codebase-memory-mcp"
CBM_INSTALL_DIR="$HOME/.local/bin"
CBM_BINARY_PATH="$CBM_INSTALL_DIR/codebase-memory-mcp"

# pi-graphify package info (sage peer for graphify MCP integration)
PI_GRAPHIFY_SRC_REL="pi-graphify"
PI_GRAPHIFY_DEST_DIR="$PI_DIR/packages/pi-graphify"
PI_GRAPHIFY_PKG="$PI_GRAPHIFY_DEST_DIR"

# graphify CLI install info
GRAPHIFY_BIN_PATH="$HOME/.local/bin/graphify"

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
    # Match either npm pkg identifier OR local-peer dest-dir path
    if '$PI_CODEBASE_MEMORY_PKG' in packages or '$PI_CODEBASE_MEMORY_LOCAL_PKG' in packages or 'pi-codebase-memory' in packages:
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

  # Fallback: register local-peer dest dir in settings.json
  # (PI_CODEBASE_MEMORY_LOCAL_PKG is a path; pi can resolve directory paths as packages)
  echo "  Adding to settings.json..."
  local settings="$PI_DIR/agent/settings.json"
  mkdir -p "$(dirname "$settings")"

  if [[ ! -f "$settings" ]]; then
    echo '{"packages": []}' > "$settings"
  fi

  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_CODEBASE_MEMORY_LOCAL_PKG'
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
f, npm_pkg, local_pkg = '$settings', '$PI_CODEBASE_MEMORY_PKG', '$PI_CODEBASE_MEMORY_LOCAL_PKG'
try:
    d = json.load(open(f))
    pkgs = d.get('packages', [])
    # Remove npm pkg, local-peer dest path, or substring variant
    new_pkgs = [x for x in pkgs if x != npm_pkg and x != local_pkg and x != 'pi-codebase-memory']
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
# Sage peer for codebase-memory-mcp (file copy + mcp.json merge + binary download)
# ────────────────────────────────────────────────────────────

install_pi_codebase_memory_files() {
  local src_root="$TMP_DIR/$PI_CODEBASE_MEMORY_SRC_REL"
  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in clone, skipping pi-codebase-memory files"
    return 0
  }
  if [[ -d "$PI_CODEBASE_MEMORY_DEST_DIR" && "${FORCE:-false}" != true ]]; then
    echo "  Skipping pi-codebase-memory files (exists, use --force)"
  else
    rm -rf "$PI_CODEBASE_MEMORY_DEST_DIR"
    mkdir -p "$PI_DIR/packages"
    cp -r "$src_root" "$PI_CODEBASE_MEMORY_DEST_DIR"
    echo "  Installed pi-codebase-memory files to $PI_CODEBASE_MEMORY_DEST_DIR"
  fi
  if [[ -f "$PI_CODEBASE_MEMORY_DEST_DIR/package.json" ]] && command -v bun &>/dev/null; then
    (cd "$PI_CODEBASE_MEMORY_DEST_DIR" && bun install --silent 2>&1 | tail -1) || true
  fi

  # Register local-peer package in settings.json (matches pi-serena/pi-graphify pattern).
  # Idempotent: skips if already present.
  local settings="$PI_DIR/agent/settings.json"
  mkdir -p "$(dirname "$settings")"
  [[ ! -f "$settings" ]] && echo '{"packages": []}' > "$settings"
  python3 -c "
import json
f, pkg = '$settings', '$PI_CODEBASE_MEMORY_LOCAL_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Registered', pkg)
"
}

write_codebase_memory_mcp_config() {
  local template=""
  if [[ -f "$PI_CODEBASE_MEMORY_DEST_DIR/templates/mcp.json" ]]; then
    template="$PI_CODEBASE_MEMORY_DEST_DIR/templates/mcp.json"
  elif [[ -f "$TMP_DIR/$PI_CODEBASE_MEMORY_SRC_REL/templates/mcp.json" ]]; then
    template="$TMP_DIR/$PI_CODEBASE_MEMORY_SRC_REL/templates/mcp.json"
  fi
  [[ -z "$template" ]] && { echo "  Warning: codebase-memory-mcp mcp.json template not found"; return 0; }
  if [[ -f "$PI_DIR/agent/mcp.json" ]]; then
    # Always merge (even with --force) — never overwrite the whole mcp.json,
    # which would erase other servers' entries.
    python3 -c "
import json
f = '$PI_DIR/agent/mcp.json'
tpl = '$template'
try: d = json.load(open(f))
except: d = {'mcpServers': {}, 'settings': {}}
tpl_d = json.load(open(tpl))
existing = d.get('mcpServers', {})
if existing.get('codebase-memory-mcp') != tpl_d.get('mcpServers', {}).get('codebase-memory-mcp'):
    existing.update(tpl_d.get('mcpServers', {}))
    d['mcpServers'] = existing
    json.dump(d, open(f, 'w'), indent=2)
    if 'codebase-memory-mcp' in tpl_d.get('mcpServers', {}):
        print('  ${FORCE:+--force }refreshed codebase-memory-mcp in mcp.json')
    else:
        print('  Merged codebase-memory-mcp template into mcp.json')
else:
    print('  codebase-memory-mcp already in mcp.json (unchanged)')
"
  else
    mkdir -p "$PI_DIR/agent"
    cp "$template" "$PI_DIR/agent/mcp.json"
    echo "  Wrote $PI_DIR/agent/mcp.json from template"
  fi
}

# ────────────────────────────────────────────────────────────
# codebase-memory-mcp binary: download from GitHub releases
# ────────────────────────────────────────────────────────────

install_codebase_memory_mcp_binary() {
  echo "==> Installing codebase-memory-mcp binary..."

  if [[ -x "$CBM_BINARY_PATH" ]]; then
    echo "  codebase-memory-mcp already installed at $CBM_BINARY_PATH"
    return 0
  fi
  if ! command -v curl &>/dev/null; then
    echo "  Error: curl required"
    return 1
  fi

  local os arch portable ext archive url
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in linux|darwin) ;; *) echo "  Error: unsupported OS $os"; return 1 ;; esac
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "  Error: unsupported arch $arch"; return 1 ;;
  esac
  portable=""; [[ "$os" = "linux" ]] && portable="-portable"
  ext="tar.gz"
  archive="codebase-memory-mcp-${os}-${arch}${portable}.${ext}"
  url="https://github.com/${CBM_REPO}/releases/latest/download/${archive}"

  echo "  Downloading ${archive}..."
  local tmpdir; tmpdir=$(mktemp -d)
  if ! curl -fSL --progress-bar -o "$tmpdir/$archive" "$url"; then
    echo "  Error: download failed"
    rm -rf "$tmpdir"; return 1
  fi

  mkdir -p "$CBM_INSTALL_DIR"
  tar -xzf "$tmpdir/$archive" -C "$tmpdir"
  local binary
  binary=$(find "$tmpdir" -type f -name "codebase-memory-mcp" -executable 2>/dev/null | head -1)
  [[ -z "$binary" ]] && { echo "  Error: binary not in archive"; rm -rf "$tmpdir"; return 1; }
  mv "$binary" "$CBM_BINARY_PATH"
  chmod +x "$CBM_BINARY_PATH"
  rm -rf "$tmpdir"
  echo "  Installed codebase-memory-mcp at $CBM_BINARY_PATH"
}

uninstall_codebase_memory_mcp_binary() {
  echo "==> Uninstalling codebase-memory-mcp binary..."
  if [[ ! -f "$CBM_BINARY_PATH" ]]; then
    echo "  Binary not found at $CBM_BINARY_PATH"
    return 0
  fi
  rm -f "$CBM_BINARY_PATH"
  echo "  Removed $CBM_BINARY_PATH"
}

# ────────────────────────────────────────────────────────────
# Sage peer for graphify MCP integration (file copy + mcp.json merge + uv tool install)
# ────────────────────────────────────────────────────────────

is_pi_graphify_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1
  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    if any(p == '$PI_GRAPHIFY_PKG' or p.endswith('/pi-graphify') for p in pkgs):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_graphify_files() {
  local src_root="$TMP_DIR/$PI_GRAPHIFY_SRC_REL"
  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in clone, skipping pi-graphify files"
    return 0
  }
  if [[ -d "$PI_GRAPHIFY_DEST_DIR" && "${FORCE:-false}" != true ]]; then
    echo "  Skipping pi-graphify files (exists, use --force)"
  else
    rm -rf "$PI_GRAPHIFY_DEST_DIR"
    mkdir -p "$PI_DIR/packages"
    cp -r "$src_root" "$PI_GRAPHIFY_DEST_DIR"
    echo "  Installed pi-graphify files to $PI_GRAPHIFY_DEST_DIR"
  fi
  if [[ -f "$PI_GRAPHIFY_DEST_DIR/package.json" ]] && command -v bun &>/dev/null; then
    (cd "$PI_GRAPHIFY_DEST_DIR" && bun install --silent 2>&1 | tail -1) || true
  fi
}

write_graphify_mcp_config() {
  local template=""
  if [[ -f "$PI_GRAPHIFY_DEST_DIR/templates/mcp.json" ]]; then
    template="$PI_GRAPHIFY_DEST_DIR/templates/mcp.json"
  elif [[ -f "$TMP_DIR/$PI_GRAPHIFY_SRC_REL/templates/mcp.json" ]]; then
    template="$TMP_DIR/$PI_GRAPHIFY_SRC_REL/templates/mcp.json"
  fi
  [[ -z "$template" ]] && { echo "  Warning: graphify mcp.json template not found"; return 0; }

  # Substitute __PI_GRAPHIFY_START_MCP__ placeholder with absolute path
  local resolved_template
  resolved_template=$(mktemp)
  sed "s|__PI_GRAPHIFY_START_MCP__|$PI_GRAPHIFY_DEST_DIR/templates/start-mcp.sh|g" "$template" > "$resolved_template"

  if [[ -f "$PI_DIR/agent/mcp.json" ]]; then
    # Always merge (even with --force) — never overwrite the whole mcp.json.
    python3 -c "
import json
f = '$PI_DIR/agent/mcp.json'
tpl = '$resolved_template'
try: d = json.load(open(f))
except: d = {'mcpServers': {}, 'settings': {}}
tpl_d = json.load(open(tpl))
existing = d.get('mcpServers', {})
if existing.get('graphify') != tpl_d.get('mcpServers', {}).get('graphify'):
    existing.update(tpl_d.get('mcpServers', {}))
    d['mcpServers'] = existing
    json.dump(d, open(f, 'w'), indent=2)
    if 'graphify' in tpl_d.get('mcpServers', {}):
        print('  ${FORCE:+--force }refreshed graphify in mcp.json')
    else:
        print('  Merged graphify template into mcp.json')
else:
    print('  graphify already in mcp.json (unchanged)')
"
  else
    mkdir -p "$PI_DIR/agent"
    cp "$resolved_template" "$PI_DIR/agent/mcp.json"
    echo "  Wrote $PI_DIR/agent/mcp.json from template"
  fi
  rm -f "$resolved_template"
}

install_graphify_binary() {
  echo "==> Installing graphify CLI (with [mcp] extra)..."

  # v0.8.33+: [mcp] extra is verified by checking if `graphify.serve` module is importable
  # (not via `graphify --help | grep --mcp` anymore — that flag is gone in v0.8.33).
  _graphify_mcp_ready() {
    uv run --with graphifyy --with mcp python -c "from graphify.serve import serve; print('ok')" 2>/dev/null | grep -q "ok"
  }

  if [[ -x "$GRAPHIFY_BIN_PATH" ]] && _graphify_mcp_ready; then
    echo "  graphify already installed with [mcp] extra at $GRAPHIFY_BIN_PATH"
    return 0
  fi
  if ! command -v uv &>/dev/null; then
    echo "  Error: uv required (curl -LsSf https://astral.sh/uv/install.sh | sh)"
    return 1
  fi

  # If binary exists but [mcp] extra is missing, plain `uv tool install graphifyy[mcp]`
  # is a metadata no-op — uv doesn't reinstall to pull in new extras. Force --reinstall
  # so the extra dependencies are actually fetched.
  local reinstall_flag=""
  if [[ -x "$GRAPHIFY_BIN_PATH" ]]; then
    reinstall_flag="--reinstall"
    echo "  Reinstalling graphify with [mcp] extra (binary exists without [mcp])..."
  else
    echo "  Installing via 'uv tool install graphifyy[mcp]'..."
  fi
  if uv tool install $reinstall_flag "graphifyy[mcp]" 2>&1 | tail -3; then
    echo "  Installed graphify at $GRAPHIFY_BIN_PATH"
  else
    echo "  uv tool install failed"
    return 1
  fi
  if ! _graphify_mcp_ready; then
    echo "  Warning: [mcp] extra still missing. Try: uv tool install --reinstall 'graphifyy[mcp]'"
    return 1
  fi
}

uninstall_graphify_binary() {
  echo "==> Uninstalling graphify..."
  if ! command -v uv &>/dev/null; then
    echo "  uv not found, cannot uninstall graphify"
    return 0
  fi
  if uv tool uninstall graphifyy 2>&1 | tail -2; then
    echo "  Removed graphify"
  else
    echo "  uv tool uninstall failed (may not be installed)"
  fi
}

install_pi_graphify() {
  echo "==> Installing pi-graphify..."
  if is_pi_graphify_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-graphify already installed (use --force to reinstall)"
    write_graphify_mcp_config
    return 0
  fi
  if ! install_pi_graphify_files; then
    echo "  Error: install_pi_graphify_files failed, aborting"
    return 1
  fi
  if is_pi_graphify_installed; then
    echo "  pi-graphify already registered in settings.json"
  else
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ ! -f "$settings" ]] && echo '{"packages": []}' > "$settings"
    python3 -c "
import json
f, pkg = '$settings', '$PI_GRAPHIFY_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Registered', pkg)
"
  fi
  write_graphify_mcp_config

  # Remove user-level graphify skill if present (v0.3.0: package owns canonical skill).
  # pi skill priority rules give user-level skills precedence, so without this removal,
  # the package's bundled skills/graphify/SKILL.md is silently skipped and a collision warning
  # appears at startup.
  local user_skill="$PI_DIR/agent/skills/graphify"
  if [[ -d "$user_skill" ]]; then
    rm -rf "$user_skill"
    echo "  Removed user-level skill $user_skill (now owned by pi-graphify package)"
  fi

  echo "  pi-graphify installed"
}

uninstall_pi_graphify() {
  echo "==> Uninstalling pi-graphify..."
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json
f = '$settings'
try:
    d = json.load(open(f))
    d['packages'] = [x for x in d.get('packages', []) if not (x == '$PI_GRAPHIFY_PKG' or x.endswith('/pi-graphify'))]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Removed pi-graphify from settings.json')
except Exception as e:
    print('  Warning:', e)
"
  if [[ -d "$PI_GRAPHIFY_DEST_DIR" ]]; then
    rm -rf "$PI_GRAPHIFY_DEST_DIR"
    echo "  Removed $PI_GRAPHIFY_DEST_DIR"
  fi
  echo "  pi-graphify uninstalled (graphify mcp.json entry left in place)"
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

  # SYSTEM.md is sourced from a single template (pi/templates/SYSTEM.md) to avoid
  # drift across install.sh / install.ps1 / install.bat.
  if [[ ! -f "$SYSTEM_TEMPLATE" ]]; then
    echo "  Error: SYSTEM.md template not found at $SYSTEM_TEMPLATE"
    echo "  (Re-download the sages repo or restore templates/SYSTEM.md)"
    return 1
  fi
  cp "$SYSTEM_TEMPLATE" "$AGENT_DIR/SYSTEM.md"
  echo "  Installed SYSTEM.md (from template)"

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

  # NOTE: peer node_modules symlinks are set up in install() AFTER all peer file
  # copies complete — not here, where peer dirs don't exist yet.
}

# Link each installed peer package's node_modules → ../sages/node_modules so that
# tsc/test imports from peer source trees (which may not carry their own node_modules)
# resolve shared deps via sages' installed deps. Idempotent: skipped if peer already
# has its own node_modules (e.g., populated by `bun install` in install_*_files).
#
# IMPORTANT: this must run AFTER all peer file copies (in install()) — not in
# install_sages_files(). The previous implementation ran inside the clone where
# the symlink target `../pi/node_modules` was correct relative to $TMP_DIR/pi/,
# but `cp -r` then copied those symlinks into $PI_DIR/packages/, where the same
# relative path resolves to a non-existent `~/.pi/packages/pi/node_modules`.
setup_peer_node_modules_symlinks() {
  for peer in pi-serena pi-graphify pi-codebase-memory; do
    local peer_dir="$PI_DIR/packages/$peer"
    [[ ! -d "$peer_dir" ]] && continue
    if [[ -L "$peer_dir/node_modules" || -e "$peer_dir/node_modules" ]]; then
      continue
    fi
    ln -s ../sages/node_modules "$peer_dir/node_modules"
    echo "  Linked $peer/node_modules → ../sages/node_modules"
  done
}
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

  if [[ -f "$PI_SERENA_MCP_JSON" ]]; then
    # Always merge (even with --force) — never overwrite the whole mcp.json,
    # which would erase other servers' entries (graphify, codebase-memory-mcp).
    python3 -c "
import json
f = '$PI_SERENA_MCP_JSON'
tpl = '$template'
try: d = json.load(open(f))
except: d = {'mcpServers': {}, 'settings': {}}
tpl_d = json.load(open(tpl))
existing = d.get('mcpServers', {})
if existing.get('serena') != tpl_d.get('mcpServers', {}).get('serena'):
    existing.update(tpl_d.get('mcpServers', {}))
    d['mcpServers'] = existing
    json.dump(d, open(f, 'w'), indent=2)
    if 'serena' in tpl_d.get('mcpServers', {}):
        print('  ${FORCE:+--force }refreshed serena in mcp.json')
    else:
        print('  Merged serena template into mcp.json')
else:
    print('  serena already in mcp.json (unchanged)')
"
  else
    mkdir -p "$(dirname "$PI_SERENA_MCP_JSON")"
    cp "$template" "$PI_SERENA_MCP_JSON"
    echo "  Wrote $PI_SERENA_MCP_JSON from template"
  fi
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

  # Install pi-codebase-memory sage peer (file copy from TMP_DIR/pi-codebase-memory + mcp.json merge)
  install_pi_codebase_memory_files || true
  write_codebase_memory_mcp_config

  # Install codebase-memory-mcp binary (~50MB download from GitHub releases)
  install_codebase_memory_mcp_binary || {
    echo "  Note: codebase-memory-mcp binary install failed."
    echo "  Sage workflow will work without it; MCP graph tools unavailable until manually installed."
    echo "  To retry: bash <(curl -fsSL https://raw.githubusercontent.com/${CBM_REPO}/main/install.sh)"
  }

  # Install pi-graphify (sage peer for graphify MCP integration)
  install_pi_graphify || true

  # Install graphify CLI with [mcp] extra
  install_graphify_binary || {
    echo "  Note: graphify CLI install failed. To retry: uv tool install 'graphifyy[mcp]'"
  }

  # After ALL peer file copies are done, set up node_modules symlinks pointing
  # at sages' shared deps (idempotent — skipped if peers already have node_modules).
  setup_peer_node_modules_symlinks

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

  # Uninstall pi-codebase-memory (sage peer)
  uninstall_pi_codebase_memory

  # Uninstall codebase-memory-mcp binary
  uninstall_codebase_memory_mcp_binary

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
