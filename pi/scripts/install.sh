#!/usr/bin/env bash
#
# Four Sages Installation Script for pi
# Installs to ~/.pi/packages/sages
#
# Also installs pi-memory for persistent memory capabilities,
# pi-codebase-memory for codebase indexing/search, and
# pi-aft (via aft-pi extension) — AFT-backed code analysis (replaces serena, no LSP needed)
#
# Selective install options:
#   --sages-only   only update sages (skip pi-memory, pi-codebase-memory, pi-aft, pi-semantic-nudge and SYSTEM.md)
#   --system-only  only install/update SYSTEM.md (skip sages, pi-memory, pi-codebase-memory, pi-aft, pi-semantic-nudge)
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

# pi-mcp-adapter package info (provides the `mcp` proxy tool — optional for sages, AFT is the new layer)
PI_MCP_ADAPTER_PKG="npm:pi-mcp-adapter"

# pi-codebase-memory sage-peer (local package, installed by file-copy not `pi install npm:`)
PI_CODEBASE_MEMORY_SRC_REL="pi-codebase-memory"
PI_CODEBASE_MEMORY_DEST_DIR="$PI_DIR/packages/pi-codebase-memory"
# Package identifier used everywhere (registered in settings.json like pi-aft/pi-graphify).
# Test contract: must be the dest-dir absolute path, NOT a `npm:` identifier.
PI_CODEBASE_MEMORY_PKG="$PI_CODEBASE_MEMORY_DEST_DIR"

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

# pi-aft (via @cortexkit/aft-pi npm extension — replaces pi-serena entirely)
# pi-aft is npm-installed; setup command registers automatically
# The setup command (npx @cortexkit/aft@latest setup) registers it AND downloads the platform binary.
# REMOVED: pi-serena no longer shipped (replaced by @cortexkit/aft-pi from npm)
# REMOVED
# REMOVED
# REMOVED: AFT does not need a separate mcp.json (the setup command handles it)

# pi-semantic-nudge package info (keeps LLM using semantic tools in long sessions)
# Same pattern as before — npm install.
PI_SEMANTIC_NUDGE_SRC_REL="pi-semantic-nudge"
PI_SEMANTIC_NUDGE_DEST_DIR="$PI_DIR/packages/pi-semantic-nudge"
PI_SEMANTIC_NUDGE_PKG="$PI_SEMANTIC_NUDGE_DEST_DIR"

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
  echo "  --sages-only       Only install/update sages (skip pi-memory, pi-codebase-memory, pi-aft, pi-semantic-nudge, SYSTEM.md)"
  echo "  --system-only      Only install/update SYSTEM.md (skip sages, pi-memory, pi-codebase-memory, pi-aft, pi-semantic-nudge)"
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
    # Exact match only — substring 'pi-codebase-memory' would false-positive on
    # unrelated forks like 'pi-codebase-memory-extra'.
    if '$PI_CODEBASE_MEMORY_PKG' in packages:
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_codebase_memory() {
  echo "==> Installing pi-codebase-memory..."

  # Idempotent: if already registered in settings.json, only ensure files are present.
  if is_pi_codebase_memory_installed; then
    echo "  pi-codebase-memory already installed"
    return 0
  fi

  # Copy source files (from the freshly-cloned TMP_DIR; may be skipped if dir exists)
  # Note: `${TMP_DIR:-}` defaults to empty string when unset (e.g. in unit-test isolation),
  # making the path `"/pi-codebase-memory"` which won't exist → the ! -d branch triggers.
  local src_root="${TMP_DIR:-}/$PI_CODEBASE_MEMORY_SRC_REL"
  if [[ ! -d "$src_root" ]]; then
    echo "  Warning: $src_root not found in clone, skipping file copy (settings.json registration still happens)"
  elif [[ -d "$PI_CODEBASE_MEMORY_DEST_DIR" && "${FORCE:-false}" != true ]]; then
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

  # Register local-peer package in settings.json (matches pi-aft / pi-graphify pattern).
  # Idempotent: skips if already present.
  local settings="$PI_DIR/agent/settings.json"
  mkdir -p "$(dirname "$settings")"
  [[ ! -f "$settings" ]] && echo '{"packages": []}' > "$settings"
  python3 -c "
import json
f, pkg = '$settings', '$PI_CODEBASE_MEMORY_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Registered', pkg)
"

  echo "  pi-codebase-memory installed"
}

uninstall_pi_codebase_memory() {
  echo "==> Uninstalling pi-codebase-memory..."

  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && { echo "  No settings file"; return 0; }

  # Exact-match removal (no substring) — preserves hypothetical forks/extras.
  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_CODEBASE_MEMORY_PKG'
try:
    d = json.load(open(f))
    pkgs = d.get('packages', [])
    new_pkgs = [x for x in pkgs if x != pkg]
    if len(new_pkgs) < len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('  Removed', pkg, 'from settings.json')
    else:
        print('  Not found in settings.json')
except Exception as e:
    print('  Warning:', e, file=sys.stderr)
    sys.exit(1)
"

  # Remove package directory if exists
  if [[ -d "$PI_CODEBASE_MEMORY_DEST_DIR" ]]; then
    rm -rf "$PI_CODEBASE_MEMORY_DEST_DIR"
    echo "  Removed $PI_CODEBASE_MEMORY_DEST_DIR"
  fi

  echo "  pi-codebase-memory uninstalled"
}

# ────────────────────────────────────────────────────────────
# codebase-memory-mcp: mcp.json merge + binary download
# ────────────────────────────────────────────────────────────

write_codebase_memory_mcp_config() {
  local template=""
  if [[ -f "$PI_CODEBASE_MEMORY_DEST_DIR/templates/mcp.json" ]]; then
    template="$PI_CODEBASE_MEMORY_DEST_DIR/templates/mcp.json"
  elif [[ -f "$TMP_DIR/$PI_CODEBASE_MEMORY_SRC_REL/templates/mcp.json" ]]; then
    template="$TMP_DIR/$PI_CODEBASE_MEMORY_SRC_REL/templates/mcp.json"
  fi
  [[ -z "$template" ]] && { echo "  Warning: codebase-memory-mcp mcp.json template not found"; return 0; }
  # NEVER-TOUCH policy (v3): see write_aft_setup_cmd for the matching
  # rationale + regression history. install.sh only writes mcp.json on first
  # install; afterwards, the file is user-owned and untouched on every rerun.
  if [[ -f "$PI_DIR/agent/mcp.json" ]]; then
    echo "  Skipped mcp.json (already exists, user-customized — preserved as-is)"
    return 0
  fi

  mkdir -p "$PI_DIR/agent"
  cp "$template" "$PI_DIR/agent/mcp.json"
  echo "  Wrote $PI_DIR/agent/mcp.json from template"
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

  # NEVER-TOUCH policy: see install_pi_aft for rationale (user owns AFT setup).
  if [[ -f "$PI_DIR/agent/mcp.json" ]]; then
    echo "  Skipped mcp.json (already exists, user-customized — preserved as-is)"
    rm -f "$resolved_template"
    return 0
  fi

  mkdir -p "$PI_DIR/agent"
  cp "$resolved_template" "$PI_DIR/agent/mcp.json"
  echo "  Wrote $PI_DIR/agent/mcp.json from template"
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
  for dir in skills src; do
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
  for peer in pi-aft pi-graphify pi-codebase-memory; do
    local peer_dir="$PI_DIR/packages/$peer"
    [[ ! -d "$peer_dir" ]] && continue
    if [[ -L "$peer_dir/node_modules" || -e "$peer_dir/node_modules" ]]; then
      continue
    fi
    ln -s ../sages/node_modules "$peer_dir/node_modules"
    echo "  Linked $peer/node_modules → ../sages/node_modules"
  done
}
# ──────────────────────────────────────────────────────────────────
# pi-aft (replaces pi-serena) — installed via npx + npm
# Uses @cortexkit/aft-pi for the Pi extension and @cortexkit/aft-linux-x64 (or
# similar) for the binary that the extension loads.
# ──────────────────────────────────────────────────────────────────

# pi-aft package info (npm-installed, replaces pi-serena entirely)
PI_AFT_PKG="npm:@cortexkit/aft-pi"

is_pi_aft_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1

  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    # Exact match: avoid substring collision with hypothetical 'pi-aft-extras' etc.
    if any(p == 'npm:@cortexkit/aft-pi' or p == '$PI_AFT_PKG' or p.endswith('/aft-pi') for p in pkgs):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_aft() {
  echo "==> Installing pi-aft (replaces pi-serena)..."

  # Idempotent: skip if installed
  if is_pi_aft_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-aft already installed (use --force to reinstall)"
    return 0
  fi

  # Force-install path: uninstall first
  if [[ "${FORCE:-false}" == true ]] && is_pi_aft_installed; then
    echo "  Force-reinstall: removing previous aft-pi first"
    uninstall_pi_aft
  fi

  # 1) Install the npm package via pi
  if command -v pi &>/dev/null; then
    echo "  Installing @cortexkit/aft-pi via pi..."
    (cd "$TMP_DIR" && pi install npm:@cortexkit/aft-pi --approve 2>&1 | tail -5) || {
      echo "  Warning: pi install failed; try 'npx @cortexkit/aft@latest setup --harness pi' manually"
    }
  else
    echo "  'pi' command not found; skipping npm install (user must install manually)"
  fi

  # 2) Run the AFT setup wizard, which:
  #    - Downloads the platform binary (linux-x64, darwin-arm64, etc.) to ~/.cache/aft
  #    - Registers the binary path for the extension
  #    - Creates ~/.config/cortexkit/aft.jsonc with the recommended surface
  if command -v npx &>/dev/null; then
    echo "  Running AFT setup (downloads platform binary + registers extension)..."
    npx --yes @cortexkit/aft@latest setup --harness pi 2>&1 | tail -10 || {
      echo "  Warning: AFT setup returned non-zero. Run 'npx @cortexkit/aft@latest doctor' to diagnose."
    }
  else
    echo "  npx not available; user must run AFT setup manually"
  fi

  echo "  pi-aft installed"
}

uninstall_pi_aft() {
  echo "==> Uninstalling pi-aft..."

  # 1) Run AFT's own uninstall (removes binary + pi extension from settings.json)
  if command -v npx &>/dev/null; then
    npx --yes @cortexkit/aft@latest uninstall --harness pi 2>&1 | tail -5 || {
      echo "  AFT uninstall non-zero; falling back to manual cleanup"
    }
  fi

  # 2) Manual fallback: strip aft-pi from settings.json
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    new_pkgs = [p for p in pkgs if p != 'npm:@cortexkit/aft-pi' and not p.endswith('/aft-pi')]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open('$settings', 'w'), indent=2)
        print('  Removed aft-pi from settings.json')
except Exception as e:
    sys.exit(1)
" 2>/dev/null || true

  # 3) Remove cached binary (best-effort)
  rm -rf "$HOME/.cache/aft" 2>/dev/null && echo "  Removed ~/.cache/aft"

  echo "  pi-aft uninstalled"
}

install_semantic_nudge_files() {
  local src_root="$TMP_DIR/$PI_SEMANTIC_NUDGE_SRC_REL"
  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in clone, skipping pi-semantic-nudge files"
    return 0
  }

  if [[ -d "$PI_SEMANTIC_NUDGE_DEST_DIR" && "${FORCE:-false}" != true ]]; then
    echo "  Skipping pi-semantic-nudge files (exists at $PI_SEMANTIC_NUDGE_DEST_DIR, use --force to overwrite)"
  else
    rm -rf "$PI_SEMANTIC_NUDGE_DEST_DIR"
    mkdir -p "$PI_DIR/packages"
    cp -r "$src_root" "$PI_SEMANTIC_NUDGE_DEST_DIR"
    echo "  Installed pi-semantic-nudge files to $PI_SEMANTIC_NUDGE_DEST_DIR"
  fi

  # Install deps if package.json exists and bun is available
  if [[ -f "$PI_SEMANTIC_NUDGE_DEST_DIR/package.json" ]] && command -v bun &>/dev/null; then
    echo "  Installing pi-semantic-nudge dependencies (bun install)..."
    (cd "$PI_SEMANTIC_NUDGE_DEST_DIR" && bun install --silent 2>&1 | tail -3) || {
      echo "  Warning: pi-semantic-nudge bun install failed, deps may be missing"
    }
  fi
}

install_pi_semantic_nudge() {
  echo "==> Installing pi-semantic-nudge..."

  # Idempotency: if already registered and not forcing, skip files copy.
  if is_pi_semantic_nudge_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-semantic-nudge already installed (use --force to reinstall)"
    return 0
  fi

  # Copy files from clone (requires TMP_DIR from install_sages_files above)
  if ! install_semantic_nudge_files; then
    echo "  Error: install_semantic_nudge_files failed, aborting pi-semantic-nudge install"
    return 1
  fi

  # Register in settings.json (matches pi-aft/pi-graphify pattern)
  if is_pi_semantic_nudge_installed; then
    echo "  pi-semantic-nudge already registered in settings.json"
  else
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ ! -f "$settings" ]] && echo '{"packages": []}' > "$settings"
    echo "  Registering pi-semantic-nudge in settings.json..."
    python3 -c "
import json
f, pkg = '$settings', '$PI_SEMANTIC_NUDGE_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
print('  Registered', pkg)
"
  fi

  # Apply the initial tool-description patch right now (so LLM sees [PREFERRED]
  # tags even before the next session_start fires the extension's ensurePatched).
  if [[ -f "$PI_SEMANTIC_NUDGE_DEST_DIR/scripts/patch_tool_descriptions.py" ]]; then
    if command -v python3 &>/dev/null; then
      echo "  Patching tool descriptions (initial pass)..."
      python3 "$PI_SEMANTIC_NUDGE_DEST_DIR/scripts/patch_tool_descriptions.py" || \
        echo "  Note: initial patch failed (will retry on next session_start)"
    fi
  fi

  echo "  pi-semantic-nudge installed"
}

uninstall_pi_semantic_nudge() {
  echo "==> Uninstalling pi-semantic-nudge..."

  local settings="$PI_DIR/agent/settings.json"

  # Remove from settings.json (exact match to avoid substring collision)
  [[ -f "$settings" ]] && python3 -c "
import json
f = '$settings'
try:
    d = json.load(open(f))
    d['packages'] = [x for x in d.get('packages', []) if not (x == '$PI_SEMANTIC_NUDGE_PKG' or x.endswith('/pi-semantic-nudge'))]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Removed pi-semantic-nudge from settings.json')
except Exception as e:
    print('  Warning:', e)
"

  # Remove installed directory
  if [[ -d "$PI_SEMANTIC_NUDGE_DEST_DIR" ]]; then
    rm -rf "$PI_SEMANTIC_NUDGE_DEST_DIR"
    echo "  Removed $PI_SEMANTIC_NUDGE_DEST_DIR"
  fi

  echo "  pi-semantic-nudge uninstalled"
}

# ────────────────────────────────────────────────────────────
# 模式 1:全量安装(默认)
# ────────────────────────────────────────────────────────────
install() {
  echo "==> Installing sages + pi-memory + pi-codebase-memory + pi-aft + pi-semantic-nudge..."

  # Pre-flight checks
  install_pi_if_needed

  # Verify pi is available
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi

  # Install pi-memory first
  install_pi_memory

  # Install pi-mcp-adapter (provides mcp proxy tool, optional for sages)
  install_pi_mcp_adapter

  # Install sages first (git clone populates TMP_DIR)
  echo "==> Installing sages..."
  install_sages_files || exit 1

  # Install pi-aft (replaces pi-serena; uses npm + npx setup)
  install_pi_aft || true

  # Install pi-codebase-memory sage peer (file copy from TMP_DIR/pi-codebase-memory + settings.json register).
  # Old design had two steps (install_pi_codebase_memory + install_pi_codebase_memory_files); merged into one
  # after we dropped the npm:pi-codebase-memory (R-Dson) variant in favor of the local peer only.
  install_pi_codebase_memory || true
  write_codebase_memory_mcp_config

  # Install codebase-memory-mcp binary (~50MB download from GitHub releases)
  install_codebase_memory_mcp_binary || {
    echo "  Note: codebase-memory-mcp binary install failed."
    echo "  Sage will work without it; MCP graph tools unavailable until manually installed."
    echo "  To retry: bash <(curl -fsSL https://raw.githubusercontent.com/${CBM_REPO}/main/install.sh)"
  }

  # Install pi-graphify (sage peer for graphify MCP integration)
  install_pi_graphify || true

  # Install pi-semantic-nudge (sage peer for tool-priority enforcement)
  install_pi_semantic_nudge || true

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
  echo "==> Installing sages only (skip pi-memory, pi-codebase-memory, pi-aft, skip SYSTEM.md)..."

  # Pre-flight: pi 仍然需要(sages 是 pi extension)
  install_pi_if_needed
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi

  # 仅安装 sages 文件
  echo "==> Installing sages..."
  install_sages_files || exit 1

  # 显式不调用 install_pi_memory / install_pi_codebase_memory / install_pi_aft / install_system_prompt
  echo "  (skipped: pi-memory, pi-codebase-memory, pi-aft, SYSTEM.md)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# 模式 3:仅更新 SYSTEM.md(跳过 sages、pi-memory 和 pi-codebase-memory)
# ────────────────────────────────────────────────────────────
install_system_only() {
  echo "==> Installing SYSTEM.md only (skip sages, pi-memory, pi-codebase-memory, pi-aft)..."
  # 不需要 git / pi —— SYSTEM.md 是独立 markdown
  install_system_prompt
  echo "  (skipped: sages, pi-memory, pi-codebase-memory, pi-aft)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# 卸载(同时移除 sages、pi-memory 和 pi-codebase-memory)
# ────────────────────────────────────────────────────────────
uninstall() {
  echo "==> Uninstalling sages + pi-memory + pi-codebase-memory + pi-aft + pi-semantic-nudge..."

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

  # Uninstall pi-aft (replaces pi-serena)
  uninstall_pi_aft

  # Uninstall pi-semantic-nudge (sage peer)
  uninstall_pi_semantic_nudge

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
