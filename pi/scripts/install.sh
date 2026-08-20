#!/usr/bin/env bash
#
# Four Sages Installation Script for pi
# Installs to ~/.pi/packages/sages
#
# This script owns the full Sages extension stack on Linux/macOS:
#
#   Local-peer (file-copy) extensions — all four come from one
#   `git clone $REPO_URL && git checkout $SAGES_REPO_SHA`, so one
#   ref pins all four together:
#     sages                → ~/.pi/packages/sages
#     pi-codebase-memory   → ~/.pi/packages/pi-codebase-memory
#     pi-subagents         → ~/.pi/packages/pi-subagents
#     pi-evaluator         → ~/.pi/packages/pi-evaluator
#
#   npm-installed extensions (--prefix ~/.pi/agent/npm), versions
#   pinned for reproducibility — see "Pinned npm-peer versions" below:
#     pi-mcp-adapter@2.25.0              → npm:pi-mcp-adapter@2.25.0
#     @cortexkit/pi-magic-context@0.36.1 → CortexKit's cross-session memory layer
#     @davecodes/pi-routines@0.5.1       → scheduled + event-driven routines
#
#   Manual-only carve-out (intentionally NOT auto-installed):
#     AFT (npm:@cortexkit/aft-pi) — binary provisioning is owned by the
#     AFT team; users run
#         npx @cortexkit/aft@latest setup --harness pi
#     manually. pi/templates/aft.jsonc ships as a reference template the
#     user can copy to ~/.config/cortexkit/aft.jsonc after installation.
#
# Selective install options:
#   --sages-only   only install sages source files (still re-clones repo; skip pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-routines, pi-subagents, pi-evaluator, subagent templates, SYSTEM.md)
#   --system-only  only install/update SYSTEM.md (skip sages, pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-routines, pi-subagents, pi-evaluator, subagent templates)
#
# These flags are mutually exclusive with --uninstall and each other.
#

set -euo pipefail

# Core paths
PI_DIR="${PI_DIR:-$HOME/.pi}"
PKG_NAME="sages"
PKG_DIR="$PI_DIR/packages/$PKG_NAME"
REPO_URL="https://github.com/vanpipy/sages.git"
# Pinned sage git ref. The local-peer file-copy packages — sages,
# pi-codebase-memory, pi-subagents — are all sourced from this same
# clone, so one ref pins all three. Bump + re-run install.sh to
# upgrade the local-peer stack. Update the matching "Pinned
# npm-peer versions" comment block below when bumping.
#
# Pin policy: reference a SHA that is reachable from origin/main —
# i.e., already pushed. Bump after the next sage commit lands on
# the remote (typical flow: push new commit, bump the SHA to that
# commit's hash in the next install.sh update).
#
# The local-peer file-copy packages — sages, pi-codebase-memory,
# pi-subagents, pi-evaluator — are all sourced from this same clone,
# so one ref pins all four together. Bump + re-run install.sh to
# upgrade the local-peer stack.
#
# Short: 04cc8c1 (fix(pi/install): sync pi-mcp-adapter and ...)
SAGES_REPO_SHA="04cc8c1d43b56c8fc6194ebe1d6a490d311c5440"
AGENT_DIR="$PI_DIR/agent"

# Resolve this script's directory (works whether invoked by absolute path, symlink, or relative)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# SYSTEM.md template (single source of truth for all three install scripts: .sh / .ps1 / .bat)
SYSTEM_TEMPLATE="$SCRIPT_DIR/../templates/SYSTEM.md"

# Subagent template install info.
# Phase A (DAG-2026-011) + Phase B (DAG-2026-011) — done: every default
# subagent (Explore, Plan, developer, auditor) is a
# canonical built-in in pi-subagents — see `pi-subagents/src/default-agents.ts`.
# No user-level template is shipped; SUBAGENT_NAMES is empty and the
# install path is a no-op for subagent templates. Pre-existing user-
# level `developer.md` and `auditor.md` (if installed
# by older install.sh / install.ps1 / install.bat versions) are LEFT IN
# PLACE for the user to remove manually — auto-backup-and-remove was
# removed because the user-level file is theirs to manage. New user
# customizations go in `~/.pi/agent/agents/` (global) or `.pi/agents/`
# (project) and override the built-in via direct registry-hit
# precedence in `registerAgents` (see agent-types.ts).
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
#   Stage 3  developer            ← pi-subagents built-in (no install)
#   Stage 4  auditor              ← pi-subagents built-in (no install)
#   (cross-workspace)  merger     ← pi-subagents built-in (no install)
SUBAGENT_TEMPLATE_DIR="$SCRIPT_DIR/../templates/agents"
SUBAGENT_TARGET_DIR="$AGENT_DIR/agents"
SUBAGENT_NAMES=()

# Subagent pipeline doc — installed to $AGENT_DIR/SUBAGENTS.md alongside
# the agent .md files. Plain markdown, NOT parsed by pi-subagents (it only
# scans $AGENT_DIR/agents/*.md for agent frontmatter), so the install target
# is $AGENT_DIR/ (not $AGENT_DIR/agents/).
SUBAGENTS_DOC_TEMPLATE="$SCRIPT_DIR/../templates/SUBAGENTS.md"
SUBAGENTS_DOC_TARGET="$AGENT_DIR/SUBAGENTS.md"

# pi-subagents config (toolDescriptionMode: "custom") + agent-tool-description.md
# override. pi-subagents reads toolDescriptionMode from $AGENT_DIR/subagents.json
# and the description template from $AGENT_DIR/agent-tool-description.md (see
# pi-subagents/dist/index.js#loadCustomToolDescription, ~line 791). This pair
# lets sages replace the upstream default Agent tool description with a
# sage-tuned one — specifically, inverting the foreground default for
# developer/auditor and adding a todowrite-driven orchestration hint.
# SAGES_TEMPLATE_V1 sentinel in the description template lets uninstall_agent_tool_description
# distinguish "our template" from a user's hand-edited version.
AGENT_TOOL_DESCRIPTION_TEMPLATE="$SCRIPT_DIR/../templates/agent-tool-description.md"
AGENT_TOOL_DESCRIPTION_TARGET="$AGENT_DIR/agent-tool-description.md"
SUBAGENTS_CONFIG_TEMPLATE="$SCRIPT_DIR/../templates/subagents.json"
SUBAGENTS_CONFIG_TARGET="$AGENT_DIR/subagents.json"


# pi-codebase-memory sage-peer (local package, installed by file-copy not `pi install npm:`)
PI_CODEBASE_MEMORY_SRC_REL="pi-codebase-memory"
PI_CODEBASE_MEMORY_DEST_DIR="$PI_DIR/packages/pi-codebase-memory"
# Package identifier used everywhere (registered in settings.json).
# Test contract: must be the dest-dir absolute path, NOT a `npm:` identifier.
PI_CODEBASE_MEMORY_PKG="$PI_CODEBASE_MEMORY_DEST_DIR"

# codebase-memory-mcp binary install info
CBM_REPO="DeusData/codebase-memory-mcp"
CBM_INSTALL_DIR="$HOME/.local/bin"
CBM_BINARY_PATH="$CBM_INSTALL_DIR/codebase-memory-mcp"

# pi-subagents package info (sage peer, deployed by file-copy)
PI_SUBAGENTS_SRC_REL="pi-subagents"
PI_SUBAGENTS_DEST_DIR="$PI_DIR/packages/pi-subagents"
PI_SUBAGENTS_PKG="$PI_SUBAGENTS_DEST_DIR"

# pi-evaluator package info (sage peer, deployed by file-copy)
# pi-evaluator is the reward-mode extension (eval_score + eval_trend tools).
# Default OFF, opt-in via `sages.rewardMode: true` in ~/.pi/agent/settings.json.
# See pi-evaluator/skills/evaluator/SKILL.md for the 5-dimension scoring model.
PI_EVALUATOR_SRC_REL="pi-evaluator"
PI_EVALUATOR_DEST_DIR="$PI_DIR/packages/pi-evaluator"
PI_EVALUATOR_PKG="$PI_EVALUATOR_DEST_DIR"

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
  echo "  --sages-only       Only install sages source files (still re-clones; skip pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-routines, pi-subagents, pi-evaluator, subagent templates, SYSTEM.md)"
  echo "  --system-only      Only install/update SYSTEM.md (skip sages, pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-routines, pi-subagents, pi-evaluator, subagent templates)"
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
  # Auto-recovery invariant: return true ONLY when both conditions hold —
  # settings.json registers the package AND the dest dir exists on disk.
  #
  # Bug this guards: if the package dir was deleted out-of-band (manual cleanup,
  # interrupted install, etc.), a settings.json-only check returns true and the
  # installer's "already installed" early-return skips re-copying files. Result:
  # settings says installed, but the extension's session_start never fires and
  # the user sees MCP servers "0/2" with no error feedback. Requiring both
  # conditions means the next install run sees the missing dir, falls through
  # the early-return, and re-runs the file-copy + settings.json registration path.
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1

  python3 -c "
import json, os, sys
try:
    d = json.load(open('$settings'))
    pkg = '$PI_CODEBASE_MEMORY_PKG'
    # Exact match only — substring 'pi-codebase-memory' would false-positive on
    # unrelated forks like 'pi-codebase-memory-extra'. Pair the settings.json
    # registration with os.path.isdir() so a deleted dest dir re-triggers install.
    if pkg in d.get('packages', []) and os.path.isdir(pkg):
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

  # Register local-peer package in settings.json (matches the local-peer pattern).
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
  # NEVER-TOUCH policy (v3): NEVER-TOUCH comment in install_*_config for the matching
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
# Phase A + Phase B: every default is built-in to pi-subagents; no
# canonical template is installed. Pre-existing user-level files
# (developer.md / auditor.md) are
# left in place for the user to remove manually. See DEVELOPER_AGENT
# and AUDITOR_AGENT in `pi-subagents/src/default-agents.ts`.
# ────────────────────────────────────────────────────────────

# Sentinel marker stamped into every template body (see templates/agents/*.md).
# HTML comment: invisible in markdown render, unknown to pi-subagents' YAML-only
# frontmatter parser, but grep-detectable so uninstall can distinguish
# template-installed files from user-written/edited ones.
SUBAGENT_SENTINEL_TEXT='SAGES_TEMPLATE_V1'

# True if $1 exists and carries the SAGES_TEMPLATE_V1 sentinel — i.e. we
# installed it. Mirrors is_*-config_installed patterns.
is_subagent_template_installed() {
  local file="$1"
  [[ -f "$file" ]] && grep -q "$SUBAGENT_SENTINEL_TEXT" "$file" 2>/dev/null
}

# Phase A + Phase B (DAG-2026-011) — done. The canonical `developer`
# and `auditor` agents are both built-in to pi-subagents. Pre-existing
# user-level `developer.md` and `auditor.md` files
# (if installed by older install.sh / install.ps1 / install.bat
# versions) are left in place for the user to remove manually. The
# user-level file shadows the built-in alias via direct registry hit
# precedence in `registerAgents` (see agent-types.ts), so removing it
# is a deliberate user choice — auto-backup-and-remove adds complexity
# the user doesn't need.

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
# $SUBAGENT_TARGET_DIR. Idempotent rules (match *_config):
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
      # Phase A P3 (DAG-2026-011): back up and classify user-customized
      # subagent templates BEFORE skipping. The backup directory
      # `$SUBAGENT_TARGET_DIR/.phase-a-migration/` carries:
      #   - the original file (`<name>.md`)
      #   - a metadata sidecar (`<name>.md.meta`) recording the install
      #     time + the classification ("user-customized") so a rollback
      #     is always possible without consulting git.
      # Phase B (auditor migration) reuses this directory.
      local backup_root="$SUBAGENT_TARGET_DIR/.phase-a-migration"
      mkdir -p "$backup_root"
      local ts
      ts=$(date +%Y%m%dT%H%M%S)
      cp "$target" "$backup_root/${name}.${ts}.md" 2>/dev/null || true
      cat > "$backup_root/${name}.${ts}.md.meta" <<META_EOF
classification: user-customized
install_time: ${ts}
subagent_name: ${name}
phase: A
reason: existing file lacks SAGES_TEMPLATE_V1 sentinel; skipped install to preserve customization
META_EOF
      echo "  $name.md exists with user customization — backed up to .phase-a-migration/${name}.${ts}.md (use --force to overwrite)"
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
# matching the uninstall_*_config + uninstall_magic_context policy.
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
# doc, just like the *_config "user-customized → skip" policy.
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
# Shared: clone + copy sages files
# ────────────────────────────────────────────────────────────
install_sages_files() {
  check_git
  TMP_DIR=$(mktemp -d)
  echo "  Cloning from $REPO_URL..."
  git clone "$REPO_URL" "$TMP_DIR" || {
    echo "Error: Failed to clone sages repository"
    return 1
  }

  # Pin the checkout to SAGES_REPO_SHA so the local-peer file-copy
  # packages (sages, pi-codebase-memory, pi-subagents) all come from
  # the same sage git ref. One ref pins all three together.
  # `git checkout <sha>` fails if the SHA isn't reachable from the
  # default branch; surface that explicitly so a stale pin is loud,
  # not silent.
  echo "  Checking out pinned ref $SAGES_REPO_SHA..."
  (cd "$TMP_DIR" && git checkout --quiet "$SAGES_REPO_SHA") || {
    echo "Error: Pinned sage ref $SAGES_REPO_SHA not found in $REPO_URL"
    echo "Bump SAGES_REPO_SHA in install.sh to a ref that exists on the default branch."
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
  for peer in pi-codebase-memory pi-subagents pi-evaluator; do
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
# pi-subagents — subagent extension for pi
#
# The orchestrator tool surface uses pi-subagents' `Agent` tool to
# actually spawn subagents for the 4-stage workflow.
#
# Source of truth: the local fork at ./pi-subagents/ (a sibling of
# ./pi/ in this sages monorepo). At runtime pi loads it from
# $PI_DIR/packages/pi-subagents, which install.sh deploys by file-copy
# during the default install path (mirror of the local-peer flow).
#
# The npm upstream (npm:@tintinweb/pi-subagents) is intentionally NOT
# installed because it would conflict with the local fork by
# registering the same tool names (Agent, get_subagent_result,
# steer_subagent). If a user previously had the npm version installed,
# they should remove it from settings.json before running this script;
# uninstall_pi_subagents strips both forms.
#
# Note: the previous design deferred pi-subagents to a "manually
# deployed from a certified merge" path (see memory #28). As of the
# script-refactor that added install_pi_subagents, this script owns
# the install/uninstall lifecycle.
# ──────────────────────────────────────────────────────────────────

is_pi_subagents_installed() {
  # Auto-recovery invariant: return true ONLY when both conditions hold —
  # settings.json registers the package AND the dest dir exists on disk.
  # Mirrors is_pi_codebase_memory_installed: pair settings.json registration
  # with os.path.isdir() so a deleted dest dir re-triggers install.
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1
  python3 -c "
import json, os, sys
try:
    d = json.load(open('$settings'))
    pkg = '$PI_SUBAGENTS_PKG'
    if pkg in d.get('packages', []) and os.path.isdir(pkg):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_subagents_files() {
  local src_root="$TMP_DIR/$PI_SUBAGENTS_SRC_REL"
  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in clone, skipping pi-subagents files"
    return 0
  }
  if [[ -d "$PI_SUBAGENTS_DEST_DIR" && "${FORCE:-false}" != true ]]; then
    echo "  Skipping pi-subagents files (exists, use --force)"
  else
    rm -rf "$PI_SUBAGENTS_DEST_DIR"
    mkdir -p "$PI_DIR/packages"
    cp -r "$src_root" "$PI_SUBAGENTS_DEST_DIR"
    echo "  Installed pi-subagents files to $PI_SUBAGENTS_DEST_DIR"
  fi
  if [[ -f "$PI_SUBAGENTS_DEST_DIR/package.json" ]] && command -v bun &>/dev/null; then
    (cd "$PI_SUBAGENTS_DEST_DIR" && bun install --silent 2>&1 | tail -1) || true
  fi
}

install_pi_subagents() {
  echo "==> Installing pi-subagents..."
  if is_pi_subagents_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-subagents already installed (use --force to reinstall)"
    return 0
  fi
  if ! install_pi_subagents_files; then
    echo "  Error: install_pi_subagents_files failed, aborting"
    return 1
  fi
  if is_pi_subagents_installed; then
    echo "  pi-subagents already registered in settings.json"
  else
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ ! -f "$settings" ]] && echo '{"packages": []}' > "$settings"
    python3 -c "
import json
f, pkg = '$settings', '$PI_SUBAGENTS_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Registered', pkg)
"
  fi
  echo "  pi-subagents installed"
}

uninstall_pi_subagents() {
  echo "==> Uninstalling pi-subagents..."

  # 1) Strip BOTH forms from settings.json (handles legacy npm install + the local fork path).
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    new_pkgs = [p for p in pkgs if not (p == 'npm:@tintinweb/pi-subagents' or p.endswith('/pi-subagents') or p.endswith('@tintinweb/pi-subagents'))]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('  Removed pi-subagents entries from settings.json')
except Exception as e:
    print('  Warning:', e, file=sys.stderr)
" 2>/dev/null || true

  # 2) Remove the package directory if it exists.
  if [[ -d "$PI_SUBAGENTS_DEST_DIR" ]]; then
    rm -rf "$PI_SUBAGENTS_DEST_DIR"
    echo "  Removed $PI_SUBAGENTS_DEST_DIR"
  fi

  echo "  pi-subagents uninstalled"
}

# ──────────────────────────────────────────────────────────────────
# pi-evaluator — reward-mode extension for pi
#
# pi-evaluator adds 2 passive-observer tools (eval_score, eval_trend) that
# score the active Sages workflow across 5 dimensions (goal, dag, implement,
# audit, coordination). It is a pure-TS sage peer — file-copied from the same
# `git clone` that sources sages / pi-codebase-memory / pi-subagents.
#
# Reward mode is OFF by default. Users opt in via `sages.rewardMode: true`
# in ~/.pi/agent/settings.json. The extension itself is always installed;
# the toggle only controls whether eval_score / eval_trend return data.
#
# At runtime pi loads it from $PI_DIR/packages/pi-evaluator, which
# install.sh deploys by file-copy during the default install path (mirror
# of the local-peer flow used by pi-codebase-memory / pi-subagents).
# ──────────────────────────────────────────────────────────────────

is_pi_evaluator_installed() {
  # Auto-recovery invariant: return true ONLY when both conditions hold —
  # settings.json registers the package AND the dest dir exists on disk.
  # Mirrors is_pi_subagents_installed / is_pi_codebase_memory_installed.
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1
  python3 -c "
import json, os, sys
try:
    d = json.load(open('$settings'))
    pkg = '$PI_EVALUATOR_PKG'
    if pkg in d.get('packages', []) and os.path.isdir(pkg):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_evaluator_files() {
  local src_root="$TMP_DIR/$PI_EVALUATOR_SRC_REL"
  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in clone, skipping pi-evaluator files"
    return 0
  }
  if [[ -d "$PI_EVALUATOR_DEST_DIR" && "${FORCE:-false}" != true ]]; then
    echo "  Skipping pi-evaluator files (exists, use --force)"
  else
    rm -rf "$PI_EVALUATOR_DEST_DIR"
    mkdir -p "$PI_DIR/packages"
    cp -r "$src_root" "$PI_EVALUATOR_DEST_DIR"
    echo "  Installed pi-evaluator files to $PI_EVALUATOR_DEST_DIR"
  fi
  if [[ -f "$PI_EVALUATOR_DEST_DIR/package.json" ]] && command -v bun &>/dev/null; then
    (cd "$PI_EVALUATOR_DEST_DIR" && bun install --silent 2>&1 | tail -1) || true
  fi
}

install_pi_evaluator() {
  echo "==> Installing pi-evaluator..."
  if is_pi_evaluator_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-evaluator already installed (use --force to reinstall)"
    return 0
  fi
  if ! install_pi_evaluator_files; then
    echo "  Error: install_pi_evaluator_files failed, aborting"
    return 1
  fi
  if is_pi_evaluator_installed; then
    echo "  pi-evaluator already registered in settings.json"
  else
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ ! -f "$settings" ]] && echo '{"packages": []}' > "$settings"
    python3 -c "
import json
f, pkg = '$settings', '$PI_EVALUATOR_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Registered', pkg)
"
  fi
  echo "  pi-evaluator installed"
}

uninstall_pi_evaluator() {
  echo "==> Uninstalling pi-evaluator..."

  # 1) Strip from settings.json.
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    new_pkgs = [p for p in pkgs if not (p == 'npm:@sages/pi-evaluator' or p.endswith('/pi-evaluator') or p.endswith('@sages/pi-evaluator'))]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('  Removed pi-evaluator entries from settings.json')
except Exception as e:
    print('  Warning:', e, file=sys.stderr)
" 2>/dev/null || true

  # 2) Remove the package directory if it exists.
  if [[ -d "$PI_EVALUATOR_DEST_DIR" ]]; then
    rm -rf "$PI_EVALUATOR_DEST_DIR"
    echo "  Removed $PI_EVALUATOR_DEST_DIR"
  fi

  echo "  pi-evaluator uninstalled"
}

# ──────────────────────────────────────────────────────────────────
# Pinned npm-peer versions
#
# Every npm: extension that install.sh installs has its version
# locked at the PI_*_PKG constant declaration (e.g.,
# PI_MCP_ADAPTER_PKG="npm:pi-mcp-adapter@2.25.0"). The pinned
# form is used both for the `npm install` invocation and for the
# settings.json registration — pi's package manager parses the
# @version suffix and uses it for installed-vs-configured version
# checks (parseSource in @earendil-works/pi-coding-agent/dist/core/
# package-manager.js; `pinned: isExactNpmVersion(version)` and
# `installedNpmMatchesConfiguredVersion` both key off the suffix).
#
# Updating a version is a deliberate change: bump the PI_*_PKG
# constant, then re-run install.sh to refresh node_modules (use
# --force to override an already-installed state).
#
#   pi-mcp-adapter                → 2.25.0
#   @cortexkit/pi-magic-context   → 0.36.1
#   @davecodes/pi-routines        → 0.5.1
#
# Local-peer (file-copy) packages — sages, pi-codebase-memory,
# pi-subagents — are NOT pinned via npm; they are pinned together
# via the SAGES_REPO_SHA git ref (full:
# 04cc8c1d43b56c8fc6194ebe1d6a490d311c5440 — short: 04cc8c1).
# All three are file-copied from one `git clone $REPO_URL &&
# git checkout $SAGES_REPO_SHA`, so the single ref pins all three.
#
#   sages / pi-codebase-memory / pi-subagents → 04cc8c1
#
# AFT (@cortexkit/aft-pi) is NOT pinned here; it is intentionally
# not auto-installed (memory #25) — users run
#     npx @cortexkit/aft@latest setup --harness pi
# manually.
# ──────────────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────────
# pi-magic-context — CortexKit's persistent memory + context layer
# (installs via pi; uses @earendil-works/pi-coding-agent as a peer)
# PINNED: @cortexkit/pi-magic-context@0.36.1
# ──────────────────────────────────────────────────────────────────

# pi-magic-context package info (npm-installed, version pinned above)
PI_MAGIC_CONTEXT_PKG="npm:@cortexkit/pi-magic-context@0.36.1"
MAGIC_CONTEXT_TEMPLATE="$SCRIPT_DIR/../templates/magic-context.jsonc"
MAGIC_CONTEXT_CONFIG_PATH="$HOME/.config/cortexkit/magic-context.jsonc"

is_pi_magic_context_installed() {
  # Auto-recovery invariant (mirrors is_pi_codebase_memory_installed):
  # require BOTH settings.json registration AND node_modules dir on disk.
  # PKG_PATTERN matches three forms so a legacy version-less entry does
  # not silently no-op the install:
  #   1. npm:@cortexkit/pi-magic-context       (legacy version-less)
  #   2. npm:@cortexkit/pi-magic-context@X.Y.Z (pinned form — see block above)
  #   3. /path/to/pi-magic-context              (hypothetical local-fork path)
  local settings="$PI_DIR/agent/settings.json"
  local node_modules_dir="$PI_DIR/agent/npm/node_modules/@cortexkit/pi-magic-context"
  [[ ! -f "$settings" ]] && return 1
  python3 -c "
import json, os, re, sys
try:
    d = json.load(open('$settings'))
    PKG_PATTERN = re.compile(r'^(npm:@cortexkit/pi-magic-context(@.+)?|.*/pi-magic-context)\$')
    registered = any(PKG_PATTERN.match(p) for p in d.get('packages', []))
    if registered and os.path.isdir('$node_modules_dir'):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

# Idempotency rules for ~/.config/cortexkit/magic-context.jsonc mirror the
# *_config pattern: only overwrite user-customized files when --force is
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

  # Already installed by us → skip (matches *_config behavior).
  if [[ -f "$MAGIC_CONTEXT_CONFIG_PATH" ]] && grep -q 'SAGES_TEMPLATE_V1' "$MAGIC_CONTEXT_CONFIG_PATH" 2>/dev/null && [[ "${FORCE:-false}" != true ]]; then
    echo "  magic-context config already installed (use --force to reinstall)"
    return 0
  fi

  # User-customized → preserve (matches *_config behavior).
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
    # Register in settings.json (matches the local-peer pattern).
    # Normalize any legacy form (version-less or /path/...) to the single
    # pinned form so future installs and updates see the version pin.
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ -f "$settings" ]] || echo '{"packages": []}' > "$settings"
    python3 -c "
import json, re
f, pkg = '$settings', '$PI_MAGIC_CONTEXT_PKG'
PKG_PATTERN = re.compile(r'^(npm:@cortexkit/pi-magic-context(@.+)?|.*/pi-magic-context)\$')
try: d = json.load(open(f))
except: d = {'packages': []}
pkgs = [p for p in d.get('packages', []) if not PKG_PATTERN.match(p)]
if pkg not in pkgs:
    pkgs.append(pkg)
d['packages'] = pkgs
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

  # Manual cleanup: strip any form (legacy version-less, pinned @version,
  # or /path/... local-fork) from settings.json.
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, re, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    PKG_PATTERN = re.compile(r'^(npm:@cortexkit/pi-magic-context(@.+)?|.*/pi-magic-context)\$')
    new_pkgs = [p for p in pkgs if not PKG_PATTERN.match(p)]
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

  # NEVER-TOUCH policy (mirrors other *_config functions): only remove config
  # if it carries our SAGES_TEMPLATE_V1 sentinel.
  if [[ -f "$MAGIC_CONTEXT_CONFIG_PATH" ]] && grep -q 'SAGES_TEMPLATE_V1' "$MAGIC_CONTEXT_CONFIG_PATH" 2>/dev/null; then
    rm -f "$MAGIC_CONTEXT_CONFIG_PATH"
    echo "  Removed magic-context config (was our template)"
  else
    echo "  magic-context config is user-customized, leaving alone"
  fi

  echo "  pi-magic-context uninstalled"
}

# ────────────────────────────────────────────────────────────
# pi-mcp-adapter — MCP (Model Context Protocol) server adapter for pi
# PINNED: pi-mcp-adapter@2.25.0  (see "Pinned npm-peer versions" block above)
#
# Mirrors the install_pi_magic_context npm-install pattern. The
# `@napi-rs/keyring` native dep compiles via node-gyp on install; the
# `--ignore-scripts` flag matches magic-context's onnx-postinstall skip
# (used here for parity and to keep the install offline-safe). If the
# user later needs OAuth credential storage, they can reinstall without
# --ignore-scripts to build the native binary.
# ────────────────────────────────────────────────────────────

PI_MCP_ADAPTER_PKG="npm:pi-mcp-adapter@2.25.0"
PI_MCP_ADAPTER_NODE_MODULES_DIR="$PI_DIR/agent/npm/node_modules/pi-mcp-adapter"

is_pi_mcp_adapter_installed() {
  # Auto-recovery invariant (mirrors is_pi_codebase_memory_installed):
  # require BOTH settings.json registration AND node_modules dir on disk
  # so a partial install (settings.json registered but files missing)
  # re-triggers install instead of silently no-op'ing.
  # PKG_PATTERN matches three forms so a legacy version-less entry does
  # not silently no-op the install:
  #   1. npm:pi-mcp-adapter        (legacy version-less)
  #   2. npm:pi-mcp-adapter@X.Y.Z  (pinned form — see block above)
  #   3. /path/to/pi-mcp-adapter    (hypothetical local-fork path)
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1
  python3 -c "
import json, os, re, sys
try:
    d = json.load(open('$settings'))
    PKG_PATTERN = re.compile(r'^(npm:pi-mcp-adapter(@.+)?|.*/pi-mcp-adapter)\$')
    registered = any(PKG_PATTERN.match(p) for p in d.get('packages', []))
    if registered and os.path.isdir('$PI_MCP_ADAPTER_NODE_MODULES_DIR'):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_mcp_adapter() {
  echo "==> Installing pi-mcp-adapter..."

  if is_pi_mcp_adapter_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-mcp-adapter already installed (use --force to reinstall)"
    return 0
  fi

  if [[ "${FORCE:-false}" == true ]] && is_pi_mcp_adapter_installed; then
    echo "  Force-reinstall: removing previous pi-mcp-adapter first"
    uninstall_pi_mcp_adapter
  fi

  if command -v pi &>/dev/null; then
    echo "  Installing pi-mcp-adapter via npm (skipping postinstall scripts)..."
    # cd to ${TMP_DIR:-/tmp} to match the magic-context pattern; --prefix
    # governs the install location so cwd is incidental.
    (cd "${TMP_DIR:-/tmp}" && \
      npm install --prefix "$PI_DIR/agent/npm" --legacy-peer-deps --ignore-scripts "$PI_MCP_ADAPTER_PKG" 2>&1 | tail -3) || {
      echo "  Warning: npm install failed; try 'npm install --prefix ~/.pi/agent/npm --ignore-scripts $PI_MCP_ADAPTER_PKG' manually"
    }

    # Register in settings.json (matches the local-peer pattern).
    # Normalize any legacy form (version-less or /path/...) to the single
    # pinned form so future installs and updates see the version pin.
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ -f "$settings" ]] || echo '{"packages": []}' > "$settings"
    python3 -c "
import json, re
f, pkg = '$settings', '$PI_MCP_ADAPTER_PKG'
PKG_PATTERN = re.compile(r'^(npm:pi-mcp-adapter(@.+)?|.*/pi-mcp-adapter)\$')
try: d = json.load(open(f))
except: d = {'packages': []}
pkgs = [p for p in d.get('packages', []) if not PKG_PATTERN.match(p)]
if pkg not in pkgs:
    pkgs.append(pkg)
d['packages'] = pkgs
json.dump(d, open(f, 'w'), indent=2)
print('  Registered', pkg)
"
  else
    echo "  'pi' command not found; user must install manually"
  fi

  echo "  pi-mcp-adapter installed"
}

uninstall_pi_mcp_adapter() {
  echo "==> Uninstalling pi-mcp-adapter..."

  # Strip any form (legacy version-less, pinned @version, or /path/...
  # local-fork) from settings.json.
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, re, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    PKG_PATTERN = re.compile(r'^(npm:pi-mcp-adapter(@.+)?|.*/pi-mcp-adapter)\$')
    new_pkgs = [p for p in pkgs if not PKG_PATTERN.match(p)]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open('$settings', 'w'), indent=2)
        print('  Removed pi-mcp-adapter from settings.json')
except Exception as e:
    sys.exit(1)
" 2>/dev/null || true

  # Remove installed package files (best-effort).
  if [[ -d "$PI_MCP_ADAPTER_NODE_MODULES_DIR" ]]; then
    rm -rf "$PI_MCP_ADAPTER_NODE_MODULES_DIR"
    echo "  Removed $PI_MCP_ADAPTER_NODE_MODULES_DIR"
  fi

  echo "  pi-mcp-adapter uninstalled"
}

# ────────────────────────────────────────────────────────────
# pi-routines (@davecodes) — scheduled + event-driven routines
# PINNED: @davecodes/pi-routines@0.5.1  (see "Pinned npm-peer versions" block above)
#
# Mirrors the install_pi_magic_context npm-install pattern. Pure JS
# (no native deps — just nanoid + typebox), so --ignore-scripts is
# purely a network-safety / parity choice rather than a workaround
# for a failing postinstall. The cli-style install matches the rest
# of the npm-peer stack.
# ────────────────────────────────────────────────────────────

PI_ROUTINES_PKG="npm:@davecodes/pi-routines@0.5.1"
PI_ROUTINES_NODE_MODULES_DIR="$PI_DIR/agent/npm/node_modules/@davecodes/pi-routines"

is_pi_routines_installed() {
  # Auto-recovery invariant (mirrors is_pi_codebase_memory_installed):
  # require BOTH settings.json registration AND node_modules dir on disk.
  # PKG_PATTERN matches four forms so any legacy form does not silently
  # no-op the install:
  #   1. npm:@davecodes/pi-routines                  (legacy version-less)
  #   2. npm:@davecodes/pi-routines@X.Y.Z            (pinned form — see block above)
  #   3. /path/to/pi-routines                         (unscoped local-fork path)
  #   4. /path/to/@davecodes/pi-routines             (scoped local-fork path)
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1
  python3 -c "
import json, os, re, sys
try:
    d = json.load(open('$settings'))
    PKG_PATTERN = re.compile(r'^(npm:@davecodes/pi-routines(@.+)?|.*/pi-routines|.*/@davecodes/pi-routines)\$')
    registered = any(PKG_PATTERN.match(p) for p in d.get('packages', []))
    if registered and os.path.isdir('$PI_ROUTINES_NODE_MODULES_DIR'):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_routines() {
  echo "==> Installing @davecodes/pi-routines..."

  if is_pi_routines_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  @davecodes/pi-routines already installed (use --force to reinstall)"
    return 0
  fi

  if [[ "${FORCE:-false}" == true ]] && is_pi_routines_installed; then
    echo "  Force-reinstall: removing previous @davecodes/pi-routines first"
    uninstall_pi_routines
  fi

  if command -v pi &>/dev/null; then
    echo "  Installing @davecodes/pi-routines via npm..."
    (cd "${TMP_DIR:-/tmp}" && \
      npm install --prefix "$PI_DIR/agent/npm" --legacy-peer-deps --ignore-scripts "$PI_ROUTINES_PKG" 2>&1 | tail -3) || {
      echo "  Warning: npm install failed; try 'npm install --prefix ~/.pi/agent/npm --ignore-scripts $PI_ROUTINES_PKG' manually"
    }

    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ -f "$settings" ]] || echo '{"packages": []}' > "$settings"
    python3 -c "
import json, re
f, pkg = '$settings', '$PI_ROUTINES_PKG'
PKG_PATTERN = re.compile(r'^(npm:@davecodes/pi-routines(@.+)?|.*/pi-routines|.*/@davecodes/pi-routines)\$')
try: d = json.load(open(f))
except: d = {'packages': []}
pkgs = [p for p in d.get('packages', []) if not PKG_PATTERN.match(p)]
if pkg not in pkgs:
    pkgs.append(pkg)
d['packages'] = pkgs
json.dump(d, open(f, 'w'), indent=2)
print('  Registered', pkg)
"
  else
    echo "  'pi' command not found; user must install manually"
  fi

  echo "  @davecodes/pi-routines installed"
}

uninstall_pi_routines() {
  echo "==> Uninstalling @davecodes/pi-routines..."

  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, re, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    PKG_PATTERN = re.compile(r'^(npm:@davecodes/pi-routines(@.+)?|.*/pi-routines|.*/@davecodes/pi-routines)\$')
    new_pkgs = [p for p in pkgs if not PKG_PATTERN.match(p)]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open('$settings', 'w'), indent=2)
        print('  Removed @davecodes/pi-routines from settings.json')
except Exception as e:
    sys.exit(1)
" 2>/dev/null || true

  if [[ -d "$PI_ROUTINES_NODE_MODULES_DIR" ]]; then
    rm -rf "$PI_ROUTINES_NODE_MODULES_DIR"
    echo "  Removed $PI_ROUTINES_NODE_MODULES_DIR"
  fi

  echo "  @davecodes/pi-routines uninstalled"
}

# ────────────────────────────────────────────────────────────
# Mode 1: full install (default)
# ────────────────────────────────────────────────────────────
install() {
  echo "==> Installing sages + pi-codebase-memory + pi-mcp-adapter + pi-magic-context + pi-routines + pi-subagents + pi-evaluator + 4-agent subagent pipeline..."

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

  # Install pi-magic-context (cross-session memory + context layer)
  install_pi_magic_context || true

  # Install pi-mcp-adapter (MCP server adapter)
  install_pi_mcp_adapter || true

  # Install @davecodes/pi-routines (scheduled + event-driven routines)
  install_pi_routines || true

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

  # Install pi-subagents (sage peer, file-copy from ./pi-subagents/ in the clone).
  install_pi_subagents || true

  # Install pi-evaluator (sage peer, file-copy from ./pi-evaluator/ in the clone).
  # Reward mode (eval_score / eval_trend) is OFF by default — opt in via
  # `sages.rewardMode: true` in ~/.pi/agent/settings.json after install.
  install_pi_evaluator || true

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
# Mode 2: update sages only (skip pi-codebase-memory and SYSTEM.md)
# ────────────────────────────────────────────────────────────
install_sages_only() {
  echo "==> Installing sages only (skip pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-routines, pi-subagents, pi-evaluator, subagent templates, skip SYSTEM.md)..."

  # Pre-flight: pi is still required (sages is a pi extension)
  install_pi_if_needed
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi

  # Install only the sages files
  echo "==> Installing sages..."
  install_sages_files || exit 1

  # Explicitly do NOT call install_pi_codebase_memory / install_pi_mcp_adapter / install_pi_magic_context / install_pi_routines / install_pi_subagents / install_pi_evaluator / install_system_prompt
  echo "  (skipped: pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-routines, pi-subagents, pi-evaluator, subagent templates, SYSTEM.md)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# Mode 3: update SYSTEM.md only (skip sages and pi-codebase-memory)
# ────────────────────────────────────────────────────────────
install_system_only() {
  echo "==> Installing SYSTEM.md only (skip sages, pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-routines, pi-subagents, pi-evaluator, subagent templates)..."
  # No git / pi needed — SYSTEM.md is standalone markdown
  install_system_prompt
  echo "  (skipped: sages, pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-routines, pi-subagents, pi-evaluator, subagent templates)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# Uninstall (removes both sages and pi-codebase-memory)
# ────────────────────────────────────────────────────────────
uninstall() {
  echo "==> Uninstalling sages + pi-codebase-memory + pi-mcp-adapter + pi-magic-context + pi-routines + pi-subagents + pi-evaluator + 4-agent subagent pipeline..."

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


  # Uninstall pi-magic-context (cross-session memory layer)
  uninstall_pi_magic_context

  # Uninstall pi-mcp-adapter (MCP server adapter)
  uninstall_pi_mcp_adapter

  # Uninstall @davecodes/pi-routines (scheduled + event-driven routines)
  uninstall_pi_routines

  # Uninstall pi-subagents (subagent extension)
  uninstall_pi_subagents

  # Uninstall pi-evaluator (reward-mode extension)
  uninstall_pi_evaluator

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

  # Mutual-exclusion check: only one mode may be selected at a time
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
