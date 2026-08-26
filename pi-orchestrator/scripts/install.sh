#!/usr/bin/env bash
#
# Sages Installation Script for pi (orchestrator-owned, GC-2026-073)
#
# This script owns the full Sages extension stack on Linux/macOS,
# including all peer packages. As of GC-2026-073 the conductor
# package (`./pi/`) was retired — its capabilities (profile-driven
# tool filter, prompt composer, soft-mode reminder) were absorbed
# directly into the orchestrator's `src/extension.ts` (session_start,
# before_agent_start, tool_call hooks). The orchestrator is now the
# sole entrypoint package; this script installs it plus all peers.
#
#   Local-peer (file-copy) extensions — all four are sourced from the
#   local sages repo (the parent directory of
#   pi-orchestrator/scripts/install.sh). No `git clone`, no remote
#   ref pin: install.sh reads the source files from its own containing
#   repo (LOCAL_REPO_ROOT, derived from ${BASH_SOURCE[0]}). Bump
#   versions in the local repo and re-run.
#     pi-orchestrator      → ~/.pi/packages/pi-orchestrator  (the Sages orchestrator)
#     pi-codebase-memory   → ~/.pi/packages/pi-codebase-memory
#     pi-subagents         → ~/.pi/packages/pi-subagents
#     pi-evaluator         → ~/.pi/packages/pi-evaluator
#
#   npm-installed extensions (--prefix ~/.pi/agent/npm), versions
#   pinned for reproducibility — see "Pinned npm-peer versions" below:
#     pi-mcp-adapter@2.25.0              → npm:pi-mcp-adapter@2.25.0
#     @cortexkit/pi-magic-context@0.36.1 → CortexKit's cross-session memory layer
#
#   Manual-only carve-out (intentionally NOT auto-installed):
#     AFT (npm:@cortexkit/aft-pi) — binary provisioning is owned by the
#     AFT team; users run
#         npx @cortexkit/aft@latest setup --harness pi
#     manually. pi-orchestrator/templates/aft.jsonc ships as a reference
#     template the user can copy to ~/.config/cortexkit/aft.jsonc
#     after installation.
#
# Selective install options:
#   --orchestrator-only only install orchestrator source files (skip pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-subagents, pi-evaluator, subagent templates, SYSTEM.md)
#   --system-only       only install/update SYSTEM.md (skip orchestrator, pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-subagents, pi-evaluator, subagent templates)
#
# These flags are mutually exclusive with --uninstall and each other.
#

set -euo pipefail

# Core paths
PI_DIR="${PI_DIR:-$HOME/.pi}"
PKG_NAME="pi-orchestrator"
PKG_DIR="$PI_DIR/packages/$PKG_NAME"
AGENT_DIR="$PI_DIR/agent"

# Resolve this script's directory (works whether invoked by absolute path, symlink, or relative)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# Local sages repo root — parent directory of pi-orchestrator/.
# install.sh no longer clones; it sources all four peer packages from
# this directory. The sanity check below fails loud if install.sh
# was misplaced (e.g., copied to /tmp without the surrounding repo
# tree) so the install never silently skips a missing peer.
LOCAL_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ ! -d "$LOCAL_REPO_ROOT/pi-orchestrator" \
   || ! -d "$LOCAL_REPO_ROOT/pi-codebase-memory" \
   || ! -d "$LOCAL_REPO_ROOT/pi-subagents" \
   || ! -d "$LOCAL_REPO_ROOT/pi-evaluator" ]]; then
  echo "Error: LOCAL_REPO_ROOT sanity check failed" >&2
  echo "  Expected: <repo>/{pi-orchestrator,pi-codebase-memory,pi-subagents,pi-evaluator}/" >&2
  echo "  Got: $LOCAL_REPO_ROOT" >&2
  echo "  install.sh must live at <repo>/pi-orchestrator/scripts/install.sh" >&2
  exit 1
fi

# SYSTEM.md template (single source of truth for all three install scripts: .sh / .ps1 / .bat)
SYSTEM_TEMPLATE="$SCRIPT_DIR/../templates/SYSTEM.md"

# Subagent template install info (GC-2026-066 reversal).
#
# Every default subagent (Explore, Plan, developer, auditor) is a
# canonical built-in in pi-subagents — see
# `pi-subagents/src/default-agents.ts`. No user-level template is
# shipped, and there is no install / uninstall path for subagent
# templates anymore. Pre-existing user-level developer.md /
# auditor.md (if installed by older install.sh / install.ps1 /
# install.bat versions) are LEFT IN PLACE for the user to remove
# manually. New user customizations go in `~/.pi/agent/agents/`
# (global) or `.pi/agents/` (project) and override the built-in via
# direct registry-hit precedence in `registerAgents` (see
# agent-types.ts).
#
# The `SUBAGENT_SENTINEL_TEXT` constant below stays — it's stamped into
# `templates/agent-tool-description.md` (one of the files this
# installer still writes) so the uninstall path can tell which copy
# is ours.

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

# pi-orchestrator package info (sage peer, deployed by file-copy).
# GC-2026-073: the orchestrator is now the entrypoint package — it
# absorbs the conductor's session_start / before_agent_start /
# tool_call hooks. There is no separate "sages" or "conductor"
# install target.
PI_ORCHESTRATOR_SRC_REL="pi-orchestrator"
PI_ORCHESTRATOR_DEST_DIR="$PI_DIR/packages/pi-orchestrator"
PI_ORCHESTRATOR_PKG="$PI_ORCHESTRATOR_DEST_DIR"

# pi-evaluator package info (sage peer, deployed by file-copy)
# pi-evaluator is the reward-mode extension (eval_score + eval_trend tools).
# Default OFF, opt-in via `sages.rewardMode: true` in ~/.pi/agent/settings.json.
# See pi-evaluator/skills/evaluator/SKILL.md for the 5-dimension scoring model.
PI_EVALUATOR_SRC_REL="pi-evaluator"
PI_EVALUATOR_DEST_DIR="$PI_DIR/packages/pi-evaluator"
PI_EVALUATOR_PKG="$PI_EVALUATOR_DEST_DIR"

# No temp dir to clean up — install.sh sources files from LOCAL_REPO_ROOT
# (derived above), so the historical TMP_DIR + clone trap is obsolete.

usage() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --prefix DIR       Set pi config dir (default: ~/.pi)"
  echo "  --force            Overwrite existing files"
  echo "  --uninstall        Remove installed files"
  echo "  --orchestrator-only Only install orchestrator source files (skip pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-subagents, pi-evaluator, subagent templates, SYSTEM.md)"
  echo "  --system-only      Only install/update SYSTEM.md (skip orchestrator, pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-subagents, pi-evaluator, subagent templates)"
  echo "  --help, -h         Show this help message"
  echo ""
  echo "Modes are mutually exclusive: pick one of (default | --uninstall | --orchestrator-only | --system-only)."
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

  # Copy source files from LOCAL_REPO_ROOT. The sanity check at script
  # entry guarantees all four peer dirs exist; if a future refactor
  # removes that check, this guard still surfaces a missing source loud.
  local src_root="$LOCAL_REPO_ROOT/$PI_CODEBASE_MEMORY_SRC_REL"
  if [[ ! -d "$src_root" ]]; then
    echo "  Warning: $src_root not found in local sages repo, skipping file copy (settings.json registration still happens)"
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
  elif [[ -f "$LOCAL_REPO_ROOT/$PI_CODEBASE_MEMORY_SRC_REL/templates/mcp.json" ]]; then
    template="$LOCAL_REPO_ROOT/$PI_CODEBASE_MEMORY_SRC_REL/templates/mcp.json"
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

  # SYSTEM.md is sourced from a single template (pi-orchestrator/templates/SYSTEM.md) to avoid
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

# Sentinel marker for `templates/agent-tool-description.md`. The file
# uses this in-body so the uninstall path can tell which copy is ours.
# (Subagent templates no longer ship — every default subagent is a
# built-in in pi-subagents; see `pi-subagents/src/default-agents.ts`.)
SUBAGENT_SENTINEL_TEXT='SAGES_TEMPLATE_V1'


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
# Used by install_agent_tool_description to safely refresh user-visible
# files where partial writes would be user-visible.
#
# History: previously also used by `install_subagents_doc` for the
# `pi-orchestrator/templates/SUBAGENTS.md` doc; that doc was retired in GC-2026-069
# because no runtime code path read it (the LLM-facing roster comes
# from `pi-orchestrator/templates/agent-tool-description.md` via {{typeList}}).
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

# ────────────────────────────────────────────────────────────
# agent-tool-description.md — sage-tuned Agent tool description override
#
# pi-subagents looks up $AGENT_DIR/agent-tool-description.md when
# toolDescriptionMode is "custom" (pi-subagents/dist/index.js#loadCustomToolDescription,
# ~line 791). The file is read once at tool registration; re-installing
# refreshes the file for the next pi session.
#
# Idempotency rules (match install_subagents_config / agent_tool_description):
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
# Remove existing orchestrator entry, then add
d['packages'] = [x for x in d.get('packages', []) if x != pkg and '$PKG_NAME' not in x]
if pkg not in d['packages']:
    d['packages'].append(pkg)
json.dump(d, open(f, 'w'), indent=2)
print('Registered pi-orchestrator')
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
    print('Unregistered pi-orchestrator')
except Exception as e:
    print('Warning:', e, file=sys.stderr)
"
}

# ────────────────────────────────────────────────────────────
# Shared: copy pi-orchestrator files from the local sages repo
# ────────────────────────────────────────────────────────────

# Critical-deps verification: confirm node_modules/<dep> exists for every
# module that pi loads at extension-startup time (i.e. the require stack
# pi-core hits before user code runs). If any are missing, pi will fail
# with `Cannot find module '<dep>'` at session start, leaving the user
# with a broken extension and no obvious recovery path. Caller prints
# recovery instructions; this function only reports.
#
# Critical deps are sourced from runtime imports of src/extension.ts →
# src/goal-contract.ts (the file in the original failure's require
# stack). Bump this list when a new top-level src/*.ts file adds a
# `dependencies` import that runs at module load (not a type-only or
# dynamic import).
verify_critical_orchestrator_deps() {
  local pkg_dir="$1"
  local missing=()
  for dep in js-yaml typebox; do
    if [[ ! -d "$pkg_dir/node_modules/$dep" ]]; then
      missing+=("$dep")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "  ERROR: critical deps missing after bun install:"
    for dep in "${missing[@]}"; do
      echo "    - node_modules/$dep"
    done
    return 1
  fi
  return 0
}

install_orchestrator_files() {
  # No clone: source files come from LOCAL_REPO_ROOT (the parent
  # directory of pi-orchestrator/, derived at script entry +
  # sanity-checked). The user controls which commit is installed by
  # where their local repo is checked out — `git checkout` in the
  # sages repo, then re-run install.sh. Pin policy is gone (no
  # SAGES_REPO_SHA, no remote ref).
  local src_root="$LOCAL_REPO_ROOT/pi-orchestrator"
  if [[ ! -d "$src_root" ]]; then
    echo "Error: pi-orchestrator source tree not found at $src_root"
    echo "  LOCAL_REPO_ROOT sanity check passed earlier — this is unexpected."
    return 1
  fi

  mkdir -p "$PKG_DIR"
  for dir in skills src templates; do
    local src_dir="$src_root/$dir"
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
  elif [[ -f "$src_root/package.json" ]]; then
    cp "$src_root/package.json" "$PKG_DIR/package.json"
    echo "  Installed package.json"
  fi

  # Install dependencies into $PKG_DIR/node_modules.
  #
  # Drop --silent and add a critical-deps verification step. The
  # pre-fix form (`bun install --silent 2>&1 | tail -3 || echo
  # warning`) swallowed install failures — when bun hit a network
  # error or the silent mode hid a real non-zero exit, the script
  # continued, the user started a pi session, and pi failed with
  # `Cannot find module 'js-yaml'` (js-yaml is required at
  # extension load by src/goal-contract.ts). The verification step
  # below catches that case and prints a clear recovery path.
  if [[ -f "$PKG_DIR/package.json" ]] && command -v bun &>/dev/null; then
    echo "  Installing dependencies (bun install)..."
    if ! (cd "$PKG_DIR" && bun install 2>&1 | tail -10); then
      echo "  ERROR: bun install failed; deps may be missing"
      echo "  Run 'cd $PKG_DIR && bun install' manually to diagnose"
    elif ! verify_critical_orchestrator_deps "$PKG_DIR"; then
      echo "  Run 'cd $PKG_DIR && bun install' manually to recover"
    fi
  elif [[ -f "$PKG_DIR/package.json" ]] && ! command -v bun &>/dev/null; then
    echo "  Warning: bun not found on PATH; $PKG_DIR/node_modules not populated"
    echo "  Install bun (https://bun.sh) and re-run install.sh, or run"
    echo "  'cd $PKG_DIR && npm install' manually before starting pi."
  fi

  register_settings

  # NOTE: peer node_modules symlinks are set up in install() AFTER all peer file
  # copies complete — not here, where peer dirs don't exist yet.
}

# Link each installed peer package's node_modules → ../pi-orchestrator/node_modules
# so that tsc/test imports from peer source trees (which may not carry their
# own node_modules) resolve shared deps via the orchestrator's installed
# deps. Idempotent: skipped if peer already has its own node_modules (e.g.,
# populated by `bun install` in install_*_files).
#
# IMPORTANT: this must run AFTER all peer file copies (in install()) — not in
# install_orchestrator_files(). Peer source dirs are read straight from
# $LOCAL_REPO_ROOT (no clone staging dir involved), so there is no longer a
# risk of copying stale relative-path symlinks into $PI_DIR/packages/.
setup_peer_node_modules_symlinks() {
  for peer in pi-codebase-memory pi-subagents pi-evaluator; do
    local peer_dir="$PI_DIR/packages/$peer"
    [[ ! -d "$peer_dir" ]] && continue
    if [[ -L "$peer_dir/node_modules" || -e "$peer_dir/node_modules" ]]; then
      continue
    fi
    ln -s ../pi-orchestrator/node_modules "$peer_dir/node_modules"
    echo "  Linked $peer/node_modules → ../pi-orchestrator/node_modules"
  done

}

# Reverse-direction symlink: expose each installed sage peer under
# pi-orchestrator/node_modules/@sages/<peer> so that an import statement
# like `import { KNOWN_SUBAGENT_IDS } from '@sages/pi-subagents'` inside
# pi-orchestrator/src/**/*.ts resolves during Node module resolution.
#
# Walks-up resolution from an importing file under
# pi-orchestrator/src/ lands on pi-orchestrator/node_modules first, so
# without this link Node cannot find any `@sages/*` peer. The forward
# link above (peer/node_modules → pi-orchestrator/node_modules) solves
# the opposite direction (peer reading orchestrator's deps); this
# function solves the orchestrator reading peers-as-packages.
#
# Idempotent: skip when the symlink already points at the expected
# relative target; rebuild when it's wrong or dangling. Never clobber a
# real directory or file at the path — warn and skip. Runs after
# setup_peer_node_modules_symlinks in install() so a fresh `bun install`
# inside install_orchestrator_files cannot wipe the symlink.
setup_orchestrator_peer_symlinks() {
  for peer in pi-subagents pi-codebase-memory pi-evaluator; do
    local peer_dir="$PI_DIR/packages/$peer"
    [[ ! -d "$peer_dir" ]] && continue  # user opted out (--orchestrator-only)

    local link_dir="$PKG_DIR/node_modules/@sages"
    local link_path="$link_dir/$peer"

    mkdir -p "$link_dir"

    if [[ -L "$link_path" ]]; then
      local current
      current="$(readlink "$link_path")"
      if [[ "$current" == "../../../$peer" ]]; then
        continue  # already correct
      fi
      rm "$link_path"
    elif [[ -e "$link_path" ]]; then
      # Real dir or file — don't clobber; warn so the user can intervene.
      echo "  Warning: $link_path is a real entry (not a symlink), leaving alone"
      continue
    fi

    ln -s "../../../$peer" "$link_path"
    echo "  Linked pi-orchestrator/node_modules/@sages/$peer → ../../../$peer"
  done
}
# ──────────────────────────────────────────────────────────────────
# pi-subagents — subagent extension for pi
#
# The orchestrator tool surface uses pi-subagents' `Agent` tool to
# actually spawn subagents for the 4-stage workflow.
#
# Source of truth: the local fork at ./pi-subagents/ (a sibling of
# ./pi-orchestrator/ in this sages monorepo). At runtime pi loads it
# from $PI_DIR/packages/pi-subagents, which install.sh deploys by
# file-copy during the default install path (mirror of the local-peer
# flow).
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
  local src_root="$LOCAL_REPO_ROOT/$PI_SUBAGENTS_SRC_REL"
  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in local sages repo, skipping pi-subagents files"
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

install_pi_orchestrator_files() {
  local src_root="$LOCAL_REPO_ROOT/$PI_ORCHESTRATOR_SRC_REL"
  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in local sages repo, skipping pi-orchestrator files"
    return 0
  }
  if [[ -d "$PI_ORCHESTRATOR_DEST_DIR" && "${FORCE:-false}" != true ]]; then
    echo "  Skipping pi-orchestrator files (exists, use --force)"
  else
    rm -rf "$PI_ORCHESTRATOR_DEST_DIR"
    mkdir -p "$PI_DIR/packages"
    cp -r "$src_root" "$PI_ORCHESTRATOR_DEST_DIR"
    echo "  Installed pi-orchestrator files to $PI_ORCHESTRATOR_DEST_DIR"
  fi
  if [[ -f "$PI_ORCHESTRATOR_DEST_DIR/package.json" ]] && command -v bun &>/dev/null; then
    (cd "$PI_ORCHESTRATOR_DEST_DIR" && bun install --silent 2>&1 | tail -1) || true
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
# audit, coordination). It is a pure-TS sage peer — file-copied from the
# local sages repo at $LOCAL_REPO_ROOT/pi-evaluator alongside the other
# three peers.
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
  local src_root="$LOCAL_REPO_ROOT/$PI_EVALUATOR_SRC_REL"
  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in local sages repo, skipping pi-evaluator files"
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
#
# Local-peer (file-copy) packages — pi-orchestrator, pi-codebase-memory,
# pi-subagents, pi-evaluator — are NOT pinned via npm and have NO
# remote ref pin. They are sourced directly from the local sages repo
# (the parent directory of pi-orchestrator/scripts/install.sh, derived as
# LOCAL_REPO_ROOT at script entry). "Versioning" is whatever commit
# the local repo is checked out to — `git checkout <sha>` in the
# sages repo, then re-run install.sh to roll the deployed peers.
#
#   pi-orchestrator / pi-codebase-memory / pi-subagents / pi-evaluator → local HEAD
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
    (cd "${LOCAL_REPO_ROOT:-/tmp}" && \
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
    # cd to ${LOCAL_REPO_ROOT:-/tmp} to match the magic-context pattern; --prefix
    # governs the install location so cwd is incidental.
    (cd "${LOCAL_REPO_ROOT:-/tmp}" && \
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
# Mode 1: full install (default)
# ────────────────────────────────────────────────────────────
install() {
  echo "==> Installing pi-orchestrator + pi-codebase-memory + pi-mcp-adapter + pi-magic-context + pi-subagents + pi-evaluator + 4-agent subagent pipeline..."

  # Pre-flight checks
  install_pi_if_needed

  # Verify pi is available
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi


  # Install pi-orchestrator first (sources files from $LOCAL_REPO_ROOT/pi-orchestrator/).
  # GC-2026-073: this replaces the historical `install_sages_files()` —
  # the conductor (./pi/) is gone, and the orchestrator is now the
  # entrypoint package.
  echo "==> Installing pi-orchestrator..."
  install_orchestrator_files || exit 1

  # Install pi-magic-context (cross-session memory + context layer)
  install_pi_magic_context || true

  # Install pi-mcp-adapter (MCP server adapter)
  install_pi_mcp_adapter || true

  # Install pi-codebase-memory sage peer (file copy from $LOCAL_REPO_ROOT/pi-codebase-memory + settings.json register).
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

  # Install pi-subagents (sage peer, file-copied from $LOCAL_REPO_ROOT/pi-subagents).
  install_pi_subagents || true

  # Install pi-evaluator (sage peer, file-copied from $LOCAL_REPO_ROOT/pi-evaluator).
  # Reward mode (eval_score / eval_trend) is OFF by default — opt in via
  # `sages.rewardMode: true` in ~/.pi/agent/settings.json after install.
  install_pi_evaluator || true

  # After ALL peer file copies are done, set up node_modules symlinks pointing
  # at the orchestrator's shared deps (idempotent — skipped if peers already
  # have node_modules).
  setup_peer_node_modules_symlinks

  # Reverse-direction symlinks: expose each installed sage peer under
  # pi-orchestrator/node_modules/@sages/<peer> so that
  # pi-orchestrator/src/**/*.ts can `import '@sages/<peer>'` and Node
  # walks up to find it. Missing this link caused every pre-GC-2026-073
  # install to fail at extension load with `Cannot find module
  # '@sages/pi-subagents'`.
  setup_orchestrator_peer_symlinks

  # Install system prompt
  install_system_prompt

  # Install agent-tool-description.md override + subagents.json setting
  # (toolDescriptionMode=custom). pi-subagents reads these at next session
  # start — see pi-subagents/dist/index.js#loadCustomToolDescription.
  install_agent_tool_description
  install_subagents_config

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# Mode 2: update orchestrator only (skip pi-codebase-memory and SYSTEM.md)
# ────────────────────────────────────────────────────────────
install_orchestrator_only() {
  echo "==> Installing orchestrator only (skip pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-subagents, pi-evaluator, subagent templates, skip SYSTEM.md)..."

  # Pre-flight: pi is still required (orchestrator is a pi extension)
  install_pi_if_needed
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi

  # Install only the orchestrator files
  echo "==> Installing pi-orchestrator..."
  install_orchestrator_files || exit 1

  # Explicitly do NOT call install_pi_codebase_memory / install_pi_mcp_adapter / install_pi_magic_context / install_pi_subagents / install_pi_evaluator / install_system_prompt
  echo "  (skipped: pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-subagents, pi-evaluator, subagent templates, SYSTEM.md)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# Mode 3: update SYSTEM.md only (skip orchestrator and pi-codebase-memory)
# ────────────────────────────────────────────────────────────
install_system_only() {
  echo "==> Installing SYSTEM.md only (skip orchestrator, pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-subagents, pi-evaluator, subagent templates)..."
  # No git / pi needed — SYSTEM.md is standalone markdown
  install_system_prompt
  echo "  (skipped: orchestrator, pi-codebase-memory, pi-mcp-adapter, pi-magic-context, pi-subagents, pi-evaluator, subagent templates)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# Uninstall (removes both orchestrator and pi-codebase-memory)
# ────────────────────────────────────────────────────────────
uninstall() {
  echo "==> Uninstalling pi-orchestrator + pi-codebase-memory + pi-mcp-adapter + pi-magic-context + pi-subagents + pi-evaluator + 4-agent subagent pipeline..."

  # Remove orchestrator
  if [[ -d "$PKG_DIR" ]]; then
    rm -rf "$PKG_DIR"
    echo "  Removed pi-orchestrator"
  fi

  # Unregister orchestrator
  unregister_settings

  # Uninstall pi-codebase-memory (sage peer)
  uninstall_pi_codebase_memory

  # Uninstall codebase-memory-mcp binary
  uninstall_codebase_memory_mcp_binary


  # Uninstall pi-magic-context (cross-session memory layer)
  uninstall_pi_magic_context

  # Uninstall pi-mcp-adapter (MCP server adapter)
  uninstall_pi_mcp_adapter



  # Uninstall pi-subagents (subagent extension)
  uninstall_pi_subagents

  # Uninstall pi-evaluator (reward-mode extension)
  uninstall_pi_evaluator

  # Uninstall agent-tool-description.md override + subagents.json setting.
  uninstall_agent_tool_description
  uninstall_subagents_config

  echo ""
  echo "Done. Restart pi: exit && pi"
}

main() {
  local FORCE=false UNINSTALL=false ORCHESTRATOR_ONLY=false SYSTEM_ONLY=false
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
      --orchestrator-only) ORCHESTRATOR_ONLY=true; MODE_COUNT=$((MODE_COUNT+1)); shift ;;
      --system-only) SYSTEM_ONLY=true; MODE_COUNT=$((MODE_COUNT+1)); shift ;;
      --help|-h) usage; exit 0 ;;
      *) echo "Error: Unknown option: $1"; usage; exit 1 ;;
    esac
  done

  # Mutual-exclusion check: only one mode may be selected at a time
  if [[ "$MODE_COUNT" -gt 1 ]]; then
    echo "Error: --uninstall, --orchestrator-only, --system-only are mutually exclusive"
    echo "Pick at most one of them (or none for full install)."
    usage
    exit 1
  fi

  if $UNINSTALL; then
    uninstall
  elif $ORCHESTRATOR_ONLY; then
    install_orchestrator_only
  elif $SYSTEM_ONLY; then
    install_system_only
  else
    install
  fi
}


main "$@"
