#!/usr/bin/env bash
#
# Four Sages Installation Script for pi
# Installs to ~/.pi/packages/sages
#
# Also installs pi-codebase-memory for codebase indexing/search,
# pi-aft (via aft-pi extension) — AFT-backed code analysis (no LSP needed),
# and pi-magic-context — CortexKit's persistent memory + context layer.
#
# Selective install options:
#   --sages-only   only install sages source files (still re-clones repo; skip pi-codebase-memory, pi-aft, AFT config, pi-magic-context, pi-subagents, subagent templates, SYSTEM.md)
#   --system-only  only install/update SYSTEM.md (skip sages, pi-codebase-memory, pi-aft, AFT config, pi-magic-context, pi-subagents, subagent templates)
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

# Subagent template install info.
# Source: pi/templates/agents/{software-auditor,software-developer}.md (git-tracked)
# Target: $AGENT_DIR/agents/ — global agent definitions loaded by pi-subagents.
# Used by sages orchestrator workflow to spawn sub-agents by name
# (subagent_type="software-developer" / "software-auditor"). Without these,
# the orchestrator's Agent tool calls fail with "unknown agent" errors.
#
# Each template body carries an HTML-comment sentinel (SAGES_TEMPLATE_V1) so
# uninstall_subagent_templates can distinguish "we installed this" from
# "user wrote their own agent or hand-edited ours".
#
# ── 4-agent subagent pipeline ─────────────────────────────────────
# The full pipeline the orchestrator dispatches (see SUBAGENTS.md):
#
#   Stage 1  Explore              ← pi-subagents built-in (no install)
#   Stage 2  Plan                 ← pi-subagents built-in (no install)
#   Stage 3  software-developer   ← shipped via SUBAGENT_NAMES below
#   Stage 4  software-auditor     ← shipped via SUBAGENT_NAMES below
#
# We ship ONLY the 2 custom agents (Stages 3-4). The 2 built-ins (Stages 1-2)
# come from @tintinweb/pi-subagents and don't need installation. This keeps
# the install lean and avoids overriding useful defaults — override Explore/
# Plan only if a project needs custom research/planning rules.
SUBAGENT_TEMPLATE_DIR="$SCRIPT_DIR/../templates/agents"
SUBAGENT_TARGET_DIR="$AGENT_DIR/agents"
SUBAGENT_NAMES=("software-auditor" "software-developer")

# Subagent pipeline doc — installed to $AGENT_DIR/SUBAGENTS.md alongside
# the agent .md files. Plain markdown, NOT parsed by pi-subagents (it only
# scans $AGENT_DIR/agents/*.md for agent frontmatter), so the install target
# is $AGENT_DIR/ (not $AGENT_DIR/agents/).
SUBAGENTS_DOC_TEMPLATE="$SCRIPT_DIR/../templates/SUBAGENTS.md"
SUBAGENTS_DOC_TARGET="$AGENT_DIR/SUBAGENTS.md"

# AFT config template — copied to ~/.config/cortexkit/aft.jsonc so AFT
# daemon starts with feature flags enabled (search_index, semantic_search,
# validate_on_edit) instead of degraded defaults.
# SAGES_TEMPLATE_V1 sentinel in the template lets uninstall_aft_config()
# distinguish "our template" from a user's hand-edited config.
AFT_TEMPLATE="$SCRIPT_DIR/../templates/aft.jsonc"
AFT_CONFIG_PATH="$HOME/.config/cortexkit/aft.jsonc"

# pi-subagents config (toolDescriptionMode: "custom") + agent-tool-description.md
# override. pi-subagents reads toolDescriptionMode from $AGENT_DIR/subagents.json
# and the description template from $AGENT_DIR/agent-tool-description.md (see
# pi-subagents/dist/index.js#loadCustomToolDescription, ~line 791). This pair
# lets sages replace the upstream default Agent tool description with a
# sage-tuned one — specifically, inverting the foreground default for
# software-developer/auditor and adding a todowrite-driven orchestration hint.
# SAGES_TEMPLATE_V1 sentinel in the description template lets uninstall_agent_tool_description
# distinguish "our template" from a user's hand-edited version.
AGENT_TOOL_DESCRIPTION_TEMPLATE="$SCRIPT_DIR/../templates/agent-tool-description.md"
AGENT_TOOL_DESCRIPTION_TARGET="$AGENT_DIR/agent-tool-description.md"
SUBAGENTS_CONFIG_TEMPLATE="$SCRIPT_DIR/../templates/subagents.json"
SUBAGENTS_CONFIG_TARGET="$AGENT_DIR/subagents.json"


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

# pi-aft (via @cortexkit/aft-pi npm extension)
# pi-aft is npm-installed; setup command registers automatically
# The setup command (npx @cortexkit/aft@latest setup) registers it AND downloads the platform binary.
# AFT does not need a separate mcp.json (the setup command handles it)

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
  echo "  --sages-only       Only install sages source files (still re-clones; skip pi-codebase-memory, pi-aft, AFT config, pi-magic-context, pi-subagents, subagent templates, SYSTEM.md)"
  echo "  --system-only      Only install/update SYSTEM.md (skip sages, pi-codebase-memory, pi-aft, AFT config, pi-magic-context, pi-subagents, subagent templates)"
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

# ────────────────────────────────────────────────────────────
# Subagent templates (pi-subagents' global agent definitions)
# Source: pi/templates/agents/{software-auditor,software-developer}.md
# Target: $SUBAGENT_TARGET_DIR/ — where pi-subagents loads agents by name.
# ────────────────────────────────────────────────────────────

# Sentinel marker stamped into every template body (see templates/agents/*.md).
# HTML comment: invisible in markdown render, unknown to pi-subagents' YAML-only
# frontmatter parser, but grep-detectable so uninstall can distinguish
# template-installed files from user-written/edited ones.
SUBAGENT_SENTINEL_TEXT='SAGES_TEMPLATE_V1'

# True if $1 exists and carries the SAGES_TEMPLATE_V1 sentinel — i.e. we
# installed it. Mirrors is_aft_config_installed() for the AFT config flow.
is_subagent_template_installed() {
  local file="$1"
  [[ -f "$file" ]] && grep -q "$SUBAGENT_SENTINEL_TEXT" "$file" 2>/dev/null
}

# Atomic file copy: write to "<target>.tmp.<pid>" then mv to target. On
# Linux/POSIX, `mv` within the same filesystem is an atomic rename, so
# concurrent readers (e.g., pi-subagents scanning $AGENT_DIR/agents/)
# never see a half-written file. Cleans up the tmp file on failure.
# Used by both install_subagent_templates and install_subagents_doc to
# safely refresh user-visible files where partial writes would be
# user-visible.
_atomic_copy() {
  local src="$1" target="$2"
  local tmp="${target}.tmp.$$"
  if cp "$src" "$tmp" 2>/dev/null; then
    mv "$tmp" "$target"
  else
    rm -f "$tmp"
    return 1
  fi
}

# Copy every $SUBAGENT_NAMES template from $SUBAGENT_TEMPLATE_DIR to
# $SUBAGENT_TARGET_DIR. Idempotent rules (match install_aft_config):
#   - missing → install from template
#   - file exists with sentinel → skip (we installed it; --force to overwrite)
#   - file exists without sentinel → user-customized; skip unless --force
# Shell-quoted: array iteration is POSIX-portable bash.
install_subagent_templates() {
  if [[ ! -d "$SUBAGENT_TEMPLATE_DIR" ]]; then
    echo "  Warning: subagent template dir not found at $SUBAGENT_TEMPLATE_DIR"
    echo "  (Re-download the sages repo or restore templates/agents/)"
    return 0
  fi

  mkdir -p "$SUBAGENT_TARGET_DIR"

  local name template target
  for name in "${SUBAGENT_NAMES[@]}"; do
    template="$SUBAGENT_TEMPLATE_DIR/$name.md"
    target="$SUBAGENT_TARGET_DIR/$name.md"

    if [[ ! -f "$template" ]]; then
      echo "  Warning: template not found: $template (skipping $name)"
      continue
    fi

    if [[ -f "$target" ]] && is_subagent_template_installed "$target" && [[ "${FORCE:-false}" != true ]]; then
      echo "  $name.md already installed (use --force to reinstall)"
      continue
    fi

    if [[ -f "$target" ]] && ! is_subagent_template_installed "$target" && [[ "${FORCE:-false}" != true ]]; then
      echo "  $name.md exists with user customization (use --force to overwrite)"
      continue
    fi

    rm -f "$target"
    _atomic_copy "$template" "$target"
    echo "  Installed $name.md (subagent template)"
  done
}

# Remove files in $SUBAGENT_TARGET_DIR ONLY if they carry our sentinel.
# Globs $SUBAGENT_TARGET_DIR/*.md directly (not iterating $SUBAGENT_NAMES)
# so user-added agent .md files in $AGENT_DIR/agents/ also get evaluated
# against the NEVER-TOUCH policy. `shopt -s nullglob` makes an empty dir
# produce a length-0 array, so the early-return skips cleanly. User-
# written or hand-edited agent files (no sentinel) are left alone,
# matching the uninstall_aft_config + uninstall_magic_context policy.
#
# Residual race: if a file's sentinel membership changes between the
# is_subagent_template_installed check and the rm call below, the file's
# state at moment-of-rm determines behaviour. Acceptable for this
# installer (not designed to be reentrant).
uninstall_subagent_templates() {
  shopt -s nullglob 2>/dev/null || true
  local candidates=("$SUBAGENT_TARGET_DIR"/*.md)
  [[ ${#candidates[@]} -eq 0 ]] && return 0

  local to_remove=()
  local f name
  for f in "${candidates[@]}"; do
    name=$(basename "$f")
    if is_subagent_template_installed "$f"; then
      to_remove+=("$f")
      echo "  Removed $name (was our template)"
    else
      echo "  $name is user-customized, leaving alone"
    fi
  done

  # Use if (not && short-circuit): under `set -e`, `[[ ... ]] && cmd` would
  # abort the script when the test is false but the && chain returns 1.
  # if/fi constructors are exempt from set -e on the test itself.
  if [[ ${#to_remove[@]} -gt 0 ]]; then
    rm -f "${to_remove[@]}"
  fi
}

# ────────────────────────────────────────────────────────────
# SUBAGENTS.md — 4-agent pipeline doc
# Lives at $AGENT_DIR/SUBAGENTS.md (next to agent .md files but NOT inside
# agents/ — it's documentation, not an agent definition). pi-subagents only
# loads *.md from agents/ as agent specs, so SUBAGENTS.md is safely ignored
# as an agent even though YAML frontmatter is absent.
# ────────────────────────────────────────────────────────────

install_subagents_doc() {
  if [[ ! -f "$SUBAGENTS_DOC_TEMPLATE" ]]; then
    echo "  Warning: SUBAGENTS.md template not found at $SUBAGENTS_DOC_TEMPLATE"
    echo "  (Re-download the sages repo or restore templates/SUBAGENTS.md)"
    return 0
  fi

  if [[ -f "$SUBAGENTS_DOC_TARGET" ]] && [[ "${FORCE:-false}" != true ]]; then
    echo "  SUBAGENTS.md already exists (use --force to overwrite)"
    return 0
  fi

  mkdir -p "$(dirname "$SUBAGENTS_DOC_TARGET")"
  _atomic_copy "$SUBAGENTS_DOC_TEMPLATE" "$SUBAGENTS_DOC_TARGET"
  echo "  Installed SUBAGENTS.md (4-agent pipeline doc)"
}

# Uninstall SUBAGENTS.md only if it matches our template (byte-identical).
# Unlike the agent .md files (which use a sentinel in-body), plain docs have
# no hidden marker; diff is the trust signal. NEVER-TOUCH for any user-edited
# doc, just like uninstall_aft_config's "user-customized → skip" policy.
uninstall_subagents_doc() {
  if [[ ! -f "$SUBAGENTS_DOC_TARGET" ]]; then
    return 0
  fi
  if [[ ! -f "$SUBAGENTS_DOC_TEMPLATE" ]]; then
    echo "  SUBAGENTS.md comparison template missing, leaving alone"
    return 0
  fi
  if diff -q "$SUBAGENTS_DOC_TEMPLATE" "$SUBAGENTS_DOC_TARGET" > /dev/null 2>&1; then
    rm -f "$SUBAGENTS_DOC_TARGET"
    echo "  Removed SUBAGENTS.md (was our template)"
  else
    echo "  SUBAGENTS.md is user-customized, leaving alone"
  fi
}

# ────────────────────────────────────────────────────────────
# agent-tool-description.md — sage-tuned Agent tool description override
#
# pi-subagents looks up $AGENT_DIR/agent-tool-description.md when
# toolDescriptionMode is "custom" (pi-subagents/dist/index.js#loadCustomToolDescription,
# ~line 791). The file is read once at tool registration; re-installing
# refreshes the file for the next pi session.
#
# Idempotency rules (match install_subagent_templates):
#   - missing → install from template
#   - file exists with sentinel → skip (we installed it; --force to overwrite)
#   - file exists without sentinel → user-customized; skip unless --force
# ────────────────────────────────────────────────────────────

is_agent_tool_description_installed() {
  [[ -f "$AGENT_TOOL_DESCRIPTION_TARGET" ]] && \
    grep -q "$SUBAGENT_SENTINEL_TEXT" "$AGENT_TOOL_DESCRIPTION_TARGET" 2>/dev/null
}

install_agent_tool_description() {
  if [[ ! -f "$AGENT_TOOL_DESCRIPTION_TEMPLATE" ]]; then
    echo "  Warning: agent-tool-description.md template not found at $AGENT_TOOL_DESCRIPTION_TEMPLATE"
    return 0
  fi

  mkdir -p "$(dirname "$AGENT_TOOL_DESCRIPTION_TARGET")"

  if is_agent_tool_description_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  agent-tool-description.md already installed (use --force to reinstall)"
    return 0
  fi

  if [[ -f "$AGENT_TOOL_DESCRIPTION_TARGET" ]] && ! is_agent_tool_description_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  agent-tool-description.md exists with user customization (use --force to overwrite)"
    return 0
  fi

  rm -f "$AGENT_TOOL_DESCRIPTION_TARGET"
  _atomic_copy "$AGENT_TOOL_DESCRIPTION_TEMPLATE" "$AGENT_TOOL_DESCRIPTION_TARGET"
  echo "  Installed agent-tool-description.md (sage-tuned Agent tool description)"
}

uninstall_agent_tool_description() {
  if [[ ! -f "$AGENT_TOOL_DESCRIPTION_TARGET" ]]; then
    return 0
  fi
  if is_agent_tool_description_installed; then
    rm -f "$AGENT_TOOL_DESCRIPTION_TARGET"
    echo "  Removed agent-tool-description.md (was our template)"
  else
    echo "  agent-tool-description.md is user-customized, leaving alone"
  fi
}

# ────────────────────────────────────────────────────────────
# subagents.json — pi-subagents settings (toolDescriptionMode: "custom")
#
# pi-subagents reads $AGENT_DIR/subagents.json for toolDescriptionMode and
# other operational settings (pi-subagents/dist/settings.js). We write
# {"toolDescriptionMode": "custom"} so the description override above is
# activated on next pi session.
#
# MERGE semantics (not replace): if the file exists with other keys
# (maxConcurrent, defaultMaxTurns, defaultJoinMode, fleetView, ...),
# we preserve those and just ensure toolDescriptionMode is set. User
# settings survive an install.sh re-run.
# ────────────────────────────────────────────────────────────

install_subagents_config() {
  if [[ ! -f "$SUBAGENTS_CONFIG_TEMPLATE" ]]; then
    echo "  Warning: subagents.json template not found at $SUBAGENTS_CONFIG_TEMPLATE"
    return 0
  fi

  mkdir -p "$(dirname "$SUBAGENTS_CONFIG_TARGET")"

  # Fresh install: write template verbatim (minus _comment). _sages_template_marker
  # is a hidden key that lets uninstall identify files we installed.
  if [[ ! -f "$SUBAGENTS_CONFIG_TARGET" ]]; then
    python3 -c "
import json, sys
try:
    t = json.load(open('$SUBAGENTS_CONFIG_TEMPLATE'))
    # Drop _comment (template-only documentation); keep _sages_template_marker
    # so uninstall_agent_tool_description-style sentinel detection works.
    out = {k: v for k, v in t.items() if k != '_comment'}
    with open('$SUBAGENTS_CONFIG_TARGET', 'w') as f:
        json.dump(out, f, indent=2)
        f.write('\n')
    sys.exit(0)
except Exception as e:
    print('  Warning: failed to install subagents.json:', e, file=sys.stderr)
    sys.exit(1)
" || return 1
    echo "  Installed subagents.json (toolDescriptionMode=custom)"
    return 0
  fi

  # Existing file: MERGE — only ensure toolDescriptionMode is set; leave
  # every other key (maxConcurrent, defaultMaxTurns, ...) alone. If the user
  # has set toolDescriptionMode to something else, leave it (NEVER-TOUCH for
  # explicit user choices).
  python3 -c "
import json, sys
path = '$SUBAGENTS_CONFIG_TARGET'
try:
    d = json.load(open(path))
except Exception:
    # Unparseable existing file: leave it alone, warn.
    print('  Warning: existing subagents.json is unparseable, leaving alone (use --force to overwrite)', file=sys.stderr)
    sys.exit(2)

# Idempotent guard: already set to what we want.
if d.get('toolDescriptionMode') == 'custom':
    print('  subagents.json already has toolDescriptionMode=custom')
    sys.exit(0)

# Skip if user explicitly chose a different mode (don't override).
if 'toolDescriptionMode' in d:
    print('  subagents.json has user-set toolDescriptionMode=\\\"' + str(d['toolDescriptionMode']) + '\\\", leaving alone')
    sys.exit(0)

# Safe to add: user hasn't expressed a preference for this key.
d['toolDescriptionMode'] = 'custom'
with open(path, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
print('  Added toolDescriptionMode=custom to existing subagents.json')
" || return 0  # python exit code 2 = unparseable; treat as warning, not failure
}

# Uninstall subagents.json only if it's our handiwork:
#   1. file missing → skip
#   2. file has toolDescriptionMode != 'custom' → user explicitly chose a
#      different mode; leave it alone
#   3. file has any keys besides toolDescriptionMode + _sages_template_marker
#      → user has added other settings; leave it alone
#   4. file is exactly {toolDescriptionMode: 'custom', _sages_template_marker:
#      'SAGES_TEMPLATE_V1'} (or missing _sages_template_marker) → safe to
#      remove (was purely our install)
uninstall_subagents_config() {
  if [[ ! -f "$SUBAGENTS_CONFIG_TARGET" ]]; then
    return 0
  fi
  python3 -c "
import json, sys, os
path = '$SUBAGENTS_CONFIG_TARGET'
try:
    d = json.load(open(path))
except Exception:
    # Unparseable — not ours, leave it.
    print('  subagents.json is unparseable, leaving alone')
    sys.exit(0)

# Rule 2: user explicitly chose a non-custom mode.
if d.get('toolDescriptionMode') not in (None, 'custom'):
    print('  subagents.json has user-set toolDescriptionMode=' + repr(d.get('toolDescriptionMode')) + ', leaving alone')
    sys.exit(0)

# Rule 3: user has added other settings.
keys_we_may_have_added = {'toolDescriptionMode', '_sages_template_marker'}
user_keys = {k: v for k, v in d.items() if k not in keys_we_may_have_added}
if user_keys:
    print('  subagents.json has user settings, leaving alone')
    sys.exit(0)

# Rule 4: empty or only our keys — safe to remove.
os.remove(path)
print('  Removed subagents.json (was our install)')
" || return 0
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
# pi-aft — installed via npx + npm
# Uses @cortexkit/aft-pi for the Pi extension and @cortexkit/aft-linux-x64 (or
# similar) for the binary that the extension loads.
# ──────────────────────────────────────────────────────────────────

# pi-aft package info (npm-installed)
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
  echo "==> Installing pi-aft..."

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

# ──────────────────────────────────────────────────────────────────
# pi-subagents — npm-installed subagent extension for pi
#
# Complements sages — the orchestrator tool surface uses pi-subagents'
# `Agent` tool to actually spawn subagents for the 4-stage workflow.
# Install via `pi install npm:@tintinweb/pi-subagents` (the standard
# mechanism, same shape as pi-aft and pi-magic-context). The pi CLI
# handles downloading, peer-dep resolution, and settings.json registration
# in one step.
# ──────────────────────────────────────────────────────────────────

PI_SUBAGENTS_PKG="npm:@tintinweb/pi-subagents"

is_pi_subagents_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1
  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    # Accept the canonical npm form, or any path-form (for forward/backward compat).
    if any(p == '$PI_SUBAGENTS_PKG' or p.endswith('/pi-subagents') or p.endswith('@tintinweb/pi-subagents') for p in pkgs):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_subagents() {
  echo "==> Installing pi-subagents..."

  # Idempotent: skip if installed
  if is_pi_subagents_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-subagents already installed (use --force to reinstall)"
    return 0
  fi

  # Force-install path: uninstall first
  if [[ "${FORCE:-false}" == true ]] && is_pi_subagents_installed; then
    echo "  Force-reinstall: removing previous pi-subagents"
    uninstall_pi_subagents
  fi

  # Prefer `pi install` — it handles npm fetch, peer-dep resolution,
  # and settings.json registration in one step.
  if command -v pi &>/dev/null; then
    echo "  Installing via 'pi install $PI_SUBAGENTS_PKG'..."
    if pi install "$PI_SUBAGENTS_PKG" 2>&1 | tail -5; then
      echo "  pi-subagents installed via pi install"
      return 0
    fi
    echo "  pi install failed, falling back to manual registration"
  else
    echo "  'pi' command not found; falling back to manual registration"
  fi

  # Fallback: ensure npm package dir is present, then register in settings.json
  if [[ ! -d "$PI_DIR/agent/npm/node_modules/@tintinweb/pi-subagents" ]] && command -v npm &>/dev/null; then
    echo "  Fetching npm package..."
    (cd "$PI_DIR/agent/npm" && npm install --legacy-peer-deps "$PI_SUBAGENTS_PKG" 2>&1 | tail -3) || {
      echo "  Warning: npm install failed; user must run 'pi install $PI_SUBAGENTS_PKG' manually"
      return 1
    }
  fi

  local settings="$PI_DIR/agent/settings.json"
  mkdir -p "$(dirname "$settings")"
  [[ ! -f "$settings" ]] && echo '{"packages": []}' > "$settings"
  python3 -c "
import json
f, pkg = '$settings', '$PI_SUBAGENTS_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
# Remove any previous pi-subagents entry, then add canonical npm form
d['packages'] = [x for x in d.get('packages', []) if not (x.endswith('/pi-subagents') or x.endswith('@tintinweb/pi-subagents'))]
if pkg not in d['packages']:
    d['packages'].append(pkg)
    json.dump(d, open(f, 'w'), indent=2)
    print('  Registered', pkg)
"

  echo "  pi-subagents installed"
}

uninstall_pi_subagents() {
  echo "==> Uninstalling pi-subagents..."

  # Strip from settings.json (handles both npm: form and any path form)
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    new_pkgs = [p for p in pkgs if not (p.endswith('/pi-subagents') or p.endswith('@tintinweb/pi-subagents'))]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('  Removed pi-subagents from settings.json')
except Exception as e:
    print('  Warning:', e, file=sys.stderr)
" 2>/dev/null || true

  echo "  pi-subagents uninstalled (use 'pi remove $PI_SUBAGENTS_PKG' to also remove npm package files)"
}

# ──────────────────────────────────────────────────────────────────
# pi-magic-context — CortexKit's persistent memory + context layer
# (installs alongside pi-aft; both target @earendil-works/pi-coding-agent)
# ──────────────────────────────────────────────────────────────────

# pi-magic-context package info (npm-installed, same pattern as pi-aft)
PI_MAGIC_CONTEXT_PKG="npm:@cortexkit/pi-magic-context"
MAGIC_CONTEXT_TEMPLATE="$SCRIPT_DIR/../templates/magic-context.jsonc"
MAGIC_CONTEXT_CONFIG_PATH="$HOME/.config/cortexkit/magic-context.jsonc"

is_pi_magic_context_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1

  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    if any(p == 'npm:@cortexkit/pi-magic-context' or p == '$PI_MAGIC_CONTEXT_PKG' or p.endswith('/pi-magic-context') for p in pkgs):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

# Idempotency rules for ~/.config/cortexkit/magic-context.jsonc mirror the
# AFT config pattern: only overwrite user-customized files when --force is
# passed; degraded (empty) or missing files get the template.
is_magic_context_config_degraded() {
  [[ ! -f "$MAGIC_CONTEXT_CONFIG_PATH" ]] && return 0  # missing = trivially degraded
  python3 -c "
import json, sys
try:
    d = json.load(open('$MAGIC_CONTEXT_CONFIG_PATH'))
    meaningful = [k for k in d if k not in ('\$schema', '_sages_template_marker')]
    sys.exit(0 if not meaningful else 1)
except Exception:
    sys.exit(0)
" 2>/dev/null
}

install_magic_context_config() {
  if [[ ! -f "$MAGIC_CONTEXT_TEMPLATE" ]]; then
    echo "  Warning: magic-context template not found at $MAGIC_CONTEXT_TEMPLATE"
    return 0
  fi

  mkdir -p "$(dirname "$MAGIC_CONTEXT_CONFIG_PATH")"

  # Already installed by us → skip (matches install_aft_config behavior).
  if [[ -f "$MAGIC_CONTEXT_CONFIG_PATH" ]] && grep -q 'SAGES_TEMPLATE_V1' "$MAGIC_CONTEXT_CONFIG_PATH" 2>/dev/null && [[ "${FORCE:-false}" != true ]]; then
    echo "  magic-context config already installed (use --force to reinstall)"
    return 0
  fi

  # User-customized → preserve (matches install_aft_config behavior).
  if [[ -f "$MAGIC_CONTEXT_CONFIG_PATH" ]] && ! is_magic_context_config_degraded; then
    echo "  magic-context config already exists with user customization (use --force to overwrite)"
    return 0
  fi

  if [[ -f "$MAGIC_CONTEXT_CONFIG_PATH" ]] && is_magic_context_config_degraded; then
    echo "  Upgrading degraded magic-context config (only \$schema, no feature flags)"
  fi

  cp "$MAGIC_CONTEXT_TEMPLATE" "$MAGIC_CONTEXT_CONFIG_PATH"
  echo "  Installed magic-context config from template"
}

install_pi_magic_context() {
  echo "==> Installing pi-magic-context..."

  # Idempotent: skip if installed
  if is_pi_magic_context_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-magic-context already installed (use --force to reinstall)"
    install_magic_context_config
    return 0
  fi

  # Force-install path: uninstall first
  if [[ "${FORCE:-false}" == true ]] && is_pi_magic_context_installed; then
    echo "  Force-reinstall: removing previous pi-magic-context first"
    uninstall_pi_magic_context
  fi

  # 1) Install the npm package via pi. The interactive setup wizard
  #    (`npx @cortexkit/magic-context@latest setup --harness pi`) prompts
  #    for historian/dreamer/sidekick model choices and is meant for
  #    first-time human installs. We skip the wizard and write the config
  #    directly via install_magic_context_config below — the wizard can
  #    still be run manually after install to refine the config.
  #
  #    The onnxruntime-node postinstall (used for embeddings) sometimes
  #    fails on restricted CDN networks. Use --ignore-scripts to skip it
  #    so semantic search stays off until ONNX can be installed manually.
  if command -v pi &>/dev/null; then
    echo "  Installing @cortexkit/pi-magic-context via pi (skipping onnx postinstall)..."
    (cd "$TMP_DIR" && \
      npm install --prefix "$PI_DIR/agent/npm" --legacy-peer-deps --ignore-scripts "$PI_MAGIC_CONTEXT_PKG" 2>&1 | tail -3) || {
      echo "  Warning: npm install failed; try 'npm install --prefix ~/.pi/agent/npm --ignore-scripts $PI_MAGIC_CONTEXT_PKG' manually"
    }
    # Register in settings.json (matches pi-aft/pi-graphify pattern).
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ -f "$settings" ]] || echo '{"packages": []}' > "$settings"
    python3 -c "
import json
f, pkg = '$settings', '$PI_MAGIC_CONTEXT_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Registered', pkg)
"
  else
    echo "  'pi' command not found; user must install manually"
  fi

  # 2) Write the magic-context config template (idempotent — skips if
  #    user-customized).
  install_magic_context_config

  echo "  pi-magic-context installed"
}

uninstall_pi_magic_context() {
  echo "==> Uninstalling pi-magic-context..."

  # Manual cleanup: strip from settings.json
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    new_pkgs = [p for p in pkgs if p != 'npm:@cortexkit/pi-magic-context' and not p.endswith('/pi-magic-context')]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open('$settings', 'w'), indent=2)
        print('  Removed pi-magic-context from settings.json')
except Exception as e:
    sys.exit(1)
" 2>/dev/null || true

  # Remove installed package files (best-effort).
  rm -rf "$PI_DIR/agent/npm/node_modules/@cortexkit/pi-magic-context" 2>/dev/null && \
    echo "  Removed pi-magic-context package files"

  # NEVER-TOUCH policy (mirrors install_aft_config): only remove config
  # if it carries our SAGES_TEMPLATE_V1 sentinel.
  if [[ -f "$MAGIC_CONTEXT_CONFIG_PATH" ]] && grep -q 'SAGES_TEMPLATE_V1' "$MAGIC_CONTEXT_CONFIG_PATH" 2>/dev/null; then
    rm -f "$MAGIC_CONTEXT_CONFIG_PATH"
    echo "  Removed magic-context config (was our template)"
  else
    echo "  magic-context config is user-customized, leaving alone"
  fi

  echo "  pi-magic-context uninstalled"
}

# ──────────────────────────────────────────────────────────────────
# AFT config (~/.config/cortexkit/aft.jsonc) — feature flags template
# ──────────────────────────────────────────────────────────────────

# Returns true if $AFT_CONFIG_PATH exists and carries our SAGES_TEMPLATE_V1
# sentinel. Used by uninstall_aft_config() to decide whether the file was
# installed by us (safe to remove) or hand-edited by the user (leave alone).
is_aft_config_installed() {
  [[ -f "$AFT_CONFIG_PATH" ]] && \
    grep -q 'SAGES_TEMPLATE_V1' "$AFT_CONFIG_PATH" 2>/dev/null
}

# Copy templates/aft.jsonc → ~/.config/cortexkit/aft.jsonc.
#
# Idempotency rules:
#   1. File missing → install template.
#   2. File exists, carries our SAGES_TEMPLATE_V1 sentinel → skip (already installed).
#   3. File exists, "degraded" (only $schema key, no other config) →
#      install template (upgrade path — user benefits from real feature flags).
#   4. File exists, "user-customized" (has any other config keys) → skip unless --force.
#
# "Degraded" detection is JSON-aware (not byte-count based): we parse the
# file and check whether it has any meaningful config keys beyond $schema.
# This avoids both false positives (clobbering small-but-valid customizations)
# and false negatives (missing truly-empty configs).
#
# Per-session fields (harness, project_root) are NOT in the template; the
# AFT bridge sets them at session start via ensureConfigured(). Pinning them
# here would break multi-project users (run sages in repo A, then repo B).
install_aft_config() {
  if [[ ! -f "$AFT_TEMPLATE" ]]; then
    echo "  Warning: AFT template not found at $AFT_TEMPLATE"
    return 0
  fi

  mkdir -p "$(dirname "$AFT_CONFIG_PATH")"

  # Already installed by us → skip.
  if is_aft_config_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  AFT config already installed (use --force to reinstall)"
    return 0
  fi

  # Degraded file detection (JSON-aware): no meaningful config keys.
  # This is the case we hit in production 2026-07-19: just $schema, no flags.
  if [[ -f "$AFT_CONFIG_PATH" ]] && ! is_aft_config_degraded; then
    # Has real config (user-customized) → preserve.
    echo "  AFT config already exists with user customization (use --force to overwrite)"
    return 0
  fi

  if [[ -f "$AFT_CONFIG_PATH" ]] && is_aft_config_degraded; then
    echo "  Upgrading degraded AFT config (only \$schema, no feature flags)"
  fi

  # Fresh install, --force overwrite, or upgrade from degraded state.
  cp "$AFT_TEMPLATE" "$AFT_CONFIG_PATH"
  echo "  Installed AFT config from template (feature flags enabled)"
}

# Returns true if AFT_CONFIG_PATH exists but has no meaningful config —
# only the $schema reference (or unparseable JSON). Used by install_aft_config
# to detect the "degraded empty" state we observed in production 2026-07-19.
is_aft_config_degraded() {
  [[ ! -f "$AFT_CONFIG_PATH" ]] && return 0  # missing = trivially degraded
  python3 -c "
import json, sys
try:
    d = json.load(open('$AFT_CONFIG_PATH'))
    # 'Degraded' = no config keys beyond \$schema and our marker
    meaningful = [k for k in d if k not in ('\$schema', '_sages_template_marker')]
    sys.exit(0 if not meaningful else 1)
except Exception:
    # Unparseable JSON — treat as degraded (we'll overwrite)
    sys.exit(0)
" 2>/dev/null
}

# Remove $AFT_CONFIG_PATH ONLY if it carries our SAGES_TEMPLATE_V1 sentinel.
# Hand-edited user configs are left untouched.
uninstall_aft_config() {
  if [[ ! -f "$AFT_CONFIG_PATH" ]]; then
    return 0
  fi
  if is_aft_config_installed; then
    rm -f "$AFT_CONFIG_PATH"
    echo "  Removed AFT config (was our template)"
  else
    echo "  AFT config is user-customized, leaving alone"
  fi
}

# ────────────────────────────────────────────────────────────
# 模式 1:全量安装(默认)
# ────────────────────────────────────────────────────────────
install() {
  echo "==> Installing sages + pi-codebase-memory + pi-aft + pi-magic-context + pi-subagents + 4-agent subagent pipeline..."

  # Pre-flight checks
  install_pi_if_needed

  # Verify pi is available
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi


  # Install sages first (git clone populates TMP_DIR)
  echo "==> Installing sages..."
  install_sages_files || exit 1

  # Install pi-aft (uses npm + npx setup)
  install_pi_aft || true

  # Install AFT config template → ~/.config/cortexkit/aft.jsonc
  # (must run AFTER install_pi_aft, since AFT setup creates the file as empty)
  install_aft_config

  # Install pi-magic-context (cross-session memory + context layer)
  install_pi_magic_context || true

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

  # Install graphify CLI with [mcp] extra
  install_graphify_binary || {
    echo "  Note: graphify CLI install failed. To retry: uv tool install 'graphifyy[mcp]'"
  }

  # Install pi-subagents (npm-installed via 'pi install npm:@tintinweb/pi-subagents').
  # Complements sages — the orchestrator tool surface uses pi-subagents' Agent tool
  # to actually spawn subagents for the 4-stage workflow.
  install_pi_subagents || true

  # After ALL peer file copies are done, set up node_modules symlinks pointing
  # at sages' shared deps (idempotent — skipped if peers already have node_modules).
  setup_peer_node_modules_symlinks

  # Install system prompt
  install_system_prompt

  # Install subagent templates (Agent tool requires software-{auditor,developer}
  # to exist in $AGENT_DIR/agents/ for orchestrator to dispatch by name).
  # Combine with the SUBAGENTS.md doc to ship the complete 4-agent pipeline:
  # Stages 1-2 (Explore, Plan) are pi-subagents built-ins; Stages 3-4
  # (software-{developer,auditor}) are the templates we ship.
  install_subagent_templates
  install_subagents_doc

  # Install agent-tool-description.md override + subagents.json setting
  # (toolDescriptionMode=custom). pi-subagents reads these at next session
  # start — see pi-subagents/dist/index.js#loadCustomToolDescription.
  install_agent_tool_description
  install_subagents_config

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# 模式 2:仅更新 sages(跳过 pi-codebase-memory 和 SYSTEM.md)
# ────────────────────────────────────────────────────────────
install_sages_only() {
  echo "==> Installing sages only (skip pi-codebase-memory, pi-aft, AFT config, pi-magic-context, pi-subagents, subagent templates, skip SYSTEM.md)..."

  # Pre-flight: pi 仍然需要(sages 是 pi extension)
  install_pi_if_needed
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi

  # 仅安装 sages 文件
  echo "==> Installing sages..."
  install_sages_files || exit 1

  # 显式不调用 install_pi_codebase_memory / install_pi_aft / install_aft_config / install_pi_magic_context / install_pi_subagents / install_system_prompt
  echo "  (skipped: pi-codebase-memory, pi-aft, AFT config, pi-magic-context, pi-subagents, subagent templates, SYSTEM.md)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# 模式 3:仅更新 SYSTEM.md(跳过 sages 和 pi-codebase-memory)
# ────────────────────────────────────────────────────────────
install_system_only() {
  echo "==> Installing SYSTEM.md only (skip sages, pi-codebase-memory, pi-aft, AFT config, subagent templates)..."
  # 不需要 git / pi —— SYSTEM.md 是独立 markdown
  install_system_prompt
  echo "  (skipped: sages, pi-codebase-memory, pi-aft, AFT config, subagent templates)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# 卸载(同时移除 sages 和 pi-codebase-memory)
# ────────────────────────────────────────────────────────────
uninstall() {
  echo "==> Uninstalling sages + pi-codebase-memory + pi-aft + pi-magic-context + pi-subagents + AFT config + 4-agent subagent pipeline..."

  # Remove sages
  if [[ -d "$PKG_DIR" ]]; then
    rm -rf "$PKG_DIR"
    echo "  Removed sages"
  fi

  # Unregister sages
  unregister_settings

  # Uninstall pi-codebase-memory (sage peer)
  uninstall_pi_codebase_memory

  # Uninstall codebase-memory-mcp binary
  uninstall_codebase_memory_mcp_binary


  # Uninstall pi-aft
  uninstall_pi_aft

  # Uninstall AFT config template (only if it's our template, not user-edited)
  uninstall_aft_config

  # Uninstall pi-magic-context (cross-session memory layer)
  uninstall_pi_magic_context

  # Uninstall pi-subagents (subagent extension)
  uninstall_pi_subagents

  # Uninstall subagent templates we installed (leaves user-customized alone),
  # plus the SUBAGENTS.md doc (only if byte-identical to our template)
  uninstall_subagent_templates
  uninstall_subagents_doc

  # Uninstall agent-tool-description.md override + subagents.json setting.
  uninstall_agent_tool_description
  uninstall_subagents_config

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
