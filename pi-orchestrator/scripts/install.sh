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
#     pi-tasks             → ~/.pi/packages/pi-tasks  (workflow engine: TaskCreate/TaskUpdate/TaskExecute/...)
#                              GC-2026-install-pi-tasks: Sages fork of @tintinweb/pi-tasks v0.9.0.
#                              Used by workflow_run for live progress visibility (GC-2026-pi-tasks-integration).
#
#   npm-installed extensions (--prefix ~/.pi/agent/npm), latest
#   from the npm registry — no version pin (see header below):
#     pi-mcp-adapter                  → npm:pi-mcp-adapter
#     @cortexkit/aft-pi               → npm:@cortexkit/aft-pi
#
#   AFT (@cortexkit/aft-pi) — full install path baked into install.sh as
#   of GC-2026-096. Three pieces, each soft-fail:
#     1. AFT config (~/.config/cortexkit/aft.jsonc) — copied from
#        pi-orchestrator/templates/aft.jsonc with SAGES_TEMPLATE_V1
#        sentinel so uninstall can distinguish "ours" from user-customized.
#     2. AFT plugin (@cortexkit/aft-pi npm peer) — installed to the same
#        prefix as pi-mcp-adapter and registered in settings.json.
#     3. AFT binary (~/.local/bin/aft) — downloaded from cortexkit/aft
#        GitHub release matching the npm peer's pinned version. Verify
#        via checksums.sha256. Mirrors install_codebase_memory_mcp_binary.
#
#   pi-orchestrator/scripts/install.ps1 and install.bat are NOT updated
#   by this GC (Windows out of scope). TODO: implement Windows AFT
#   install when those scripts get the same treatment.
#
# Selective install options:
#   --orchestrator-only only install orchestrator source files (skip pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator, subagent templates, SYSTEM.md)
#   --system-only       only install/update SYSTEM.md (skip orchestrator, pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator, subagent templates)
#   --sync-only         fast path: force-copy pi-orchestrator + pi-tasks source files
#                        into $PKG_DIR without re-running bun install, npm peer
#                        setup, SYSTEM.md, or pi CLI. Requires a prior full
#                        install on this prefix (peer chain must already be
#                        intact at $PI_DIR/packages/). GC-2026-pi-tasks-cascade-
#                        agentid + GC-2026-boundary-subagent-control follow-up.
#   --no-smoke          skip the post-install extension-load smoke test (gate 3 of
#                        run_post_install_gates). Gates 1 (critical_deps) and
#                        2 (package_existence) still run. Useful for fast
#                        iteration when the install is known sound. GC-2026-110.
#
# These flags are mutually exclusive with --uninstall and each other.
#

set -euo pipefail

# Core paths
PI_DIR="${PI_DIR:-$HOME/.pi}"
PKG_NAME="pi-orchestrator"
PKG_DIR="$PI_DIR/packages/$PKG_NAME"
AGENT_DIR="$PI_DIR/agent"

# Resolve this script's directory (works whether invoked by absolute path, symlink, or relative).
# GC-2026-096: respect exported SCRIPT_DIR / LOCAL_REPO_ROOT so callers can
# source install.sh in tests / sandboxed environments without these getting
# overwritten. Falls back to BASH_SOURCE derivation when not set.
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"

# Local sages repo root — parent directory of pi-orchestrator/.
# install.sh no longer clones; it sources all four peer packages from
# this directory. The sanity check below fails loud if install.sh
# was misplaced (e.g., copied to /tmp without the surrounding repo
# tree) so the install never silently skips a missing peer.
LOCAL_REPO_ROOT="${LOCAL_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
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
# Every default subagent (Explore, PlanCompiler, Developer, Reviewer,
# Fix, Merger, MergerAdvisor, +3 advisor agents) is a canonical
# built-in in pi-subagents — see `pi-subagents/src/default-agents.ts`.
# No user-level template is shipped, and there is no install /
# uninstall path for subagent templates anymore. Pre-existing
# user-level developer.md / reviewer.md / auditor.md (if installed by
# older install.sh / install.ps1 / install.bat versions) are LEFT IN
# PLACE for the user to remove manually. New user customizations go
# in `~/.pi/agent/agents/` (global) or `.pi/agents/` (project) and
# override the built-in via direct registry-hit precedence in
# `registerAgents` (see agent-types.ts).
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
# developer/reviewer and adding a todowrite-driven orchestration hint.
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
PI_ORCHESTRATOR_DEST_DIR="$PI_DIR/packages/pi-orchestrator"
# Package identifier used in settings.json#packages. Mirrors the
# other four peers (PI_CODEBASE_MEMORY_PKG, PI_SUBAGENTS_PKG,
# PI_EVALUATOR_PKG, PI_TASKS_PKG). Required by GC-2026-main-agent-tool-surface:
# the is_pi_orchestrator_installed helper + verify_package_existence
# gate read this. Without it, the orchestrator is the only peer
# without an is_*_installed guard, so a dest-dir deletion passes the
# "already installed" early-return and silently strips the
# orchestrator from the LLM-facing tool surface.
PI_ORCHESTRATOR_PKG="$PI_ORCHESTRATOR_DEST_DIR"

# pi-evaluator package info (sage peer, deployed by file-copy)
# pi-evaluator is the reward-mode extension (eval_score + eval_trend tools).
# Default OFF, opt-in via `sages.rewardMode: true` in ~/.pi/agent/settings.json.
# See pi-evaluator/skills/evaluator/SKILL.md for the 5-dimension scoring model.
PI_EVALUATOR_SRC_REL="pi-evaluator"
PI_EVALUATOR_DEST_DIR="$PI_DIR/packages/pi-evaluator"
PI_EVALUATOR_PKG="$PI_EVALUATOR_DEST_DIR"

# pi-tasks package info (sage peer, deployed by file-copy)
# pi-tasks is the workflow engine: TaskCreate / TaskList / TaskUpdate /
# TaskExecute (Claude Code-compatible task tracking). workflow_run
# (the orchestrator's 4-phase pipeline runner, GC-2026-workflow-run; Fix dispatched dynamically)
# creates 4 pi-tasks tasks for live progress visibility
# (GC-2026-pi-tasks-integration). Without pi-tasks installed,
# workflow_run still works — just without the live progress UI
# (pi_tasks.* IDs in the result are empty strings).
#
# @sages/pi-tasks is the Sages fork of @tintinweb/pi-tasks v0.9.0
# (added in commit 8fd2693; sagesized to @sages/* namespace). npm
# upstream is intentionally NOT installed because the orchestrator
# uses it for internal bookkeeping (TaskCreate × N for pi-tasks
# integration) and registering both forms would conflict.
PI_TASKS_SRC_REL="pi-tasks"
PI_TASKS_DEST_DIR="$PI_DIR/packages/pi-tasks"
PI_TASKS_PKG="$PI_TASKS_DEST_DIR"

# AFT (@cortexkit/aft-pi) install info — GC-2026-096.
#
# Full install path baked into install.sh. Three pieces:
#   - AFT_TEMPLATE  -> AFT_CONFIG   (config file)
#   - npm:@cortexkit/aft-pi          (plugin)
#   - AFT_BINARY                     (rust daemon)
#
# AFT_TEMPLATE is the source of truth; AFT_CONFIG is the deployed
# config at ~/.config/cortexkit/aft.jsonc. AFT_SENTINEL stamps the
# template body so uninstall can distinguish "we installed this" from
# "user has customized this" (the magic-context.jsonc precedent).
#
# Mirrors pi-mcp-adapter's pinning policy (no @version suffix — install
# always pulls latest from the npm registry; --force to roll).
AFT_TEMPLATE="$SCRIPT_DIR/../templates/aft.jsonc"
AFT_CONFIG="$HOME/.config/cortexkit/aft.jsonc"
AFT_SENTINEL="SAGES_TEMPLATE_V1"
AFT_NPM_PKG="npm:@cortexkit/aft-pi"
AFT_NPM_DIR="$PI_DIR/agent/npm/node_modules/@cortexkit/aft-pi"
# Binary lives at ~/.local/bin/aft (mirrors codebase-memory-mcp at
# ~/.local/bin/codebase-memory-mcp). On PATH so users can run
# `aft --version` directly.
AFT_BINARY="$HOME/.local/bin/aft"
AFT_BINARY_DIR="$(dirname "$AFT_BINARY")"
# GitHub release source. Same release as the npm peer's bundled binary
# version, resolved at install time from $AFT_NPM_DIR/package.json.
AFT_RELEASE_REPO="cortexkit/aft"

# No temp dir to clean up — install.sh sources files from LOCAL_REPO_ROOT
# (derived above), so the historical TMP_DIR + clone trap is obsolete.

usage() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --prefix DIR       Set pi config dir (default: ~/.pi)"
  echo "  --force            Overwrite existing files"
  echo "  --uninstall        Remove installed files"
  echo "  --orchestrator-only Only install orchestrator source files (skip pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator, subagent templates, SYSTEM.md)"
  echo "  --system-only      Only install/update SYSTEM.md (skip orchestrator, pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator, subagent templates)"
  echo "  --sync-only        Force-copy pi-orchestrator + pi-tasks source files only (no bun install / no peer setup / no SYSTEM.md / no pi CLI). Requires a prior full install on the same prefix."
  echo "  --no-smoke         Skip the post-install extension-load smoke test (gate 3 of run_post_install_gates). Gates 1 (critical_deps) and 2 (package_existence) still run. Useful for fast iteration when you know the install is sound."
  echo "  --help, -h         Show this help message"
  echo ""
  echo "Modes are mutually exclusive: pick one of (default | --uninstall | --orchestrator-only | --system-only | --sync-only)."
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
  # The `--force` bypass mirrors the other peer installers (subagents, evaluator):
  # when --force is set, always re-copy files + re-run bun install so the
  # deployed package.json reflects the current repo state.
  if is_pi_codebase_memory_installed && [[ "${FORCE:-false}" != true ]]; then
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
    # Drop --silent so install failures surface (matches the orchestrator
    # fix at commit e2e0101). pi-codebase-memory has no critical runtime
    # deps to verify (only the pi-coding-agent peer that pi provides),
    # so the per-step verify is a no-op — but at least surface bun
    # install errors instead of silently swallowing them with `|| true`.
    if ! (cd "$PI_CODEBASE_MEMORY_DEST_DIR" && bun install 2>&1 | tail -10); then
      echo "  ERROR: pi-codebase-memory bun install failed"
      echo "  Run 'cd $PI_CODEBASE_MEMORY_DEST_DIR && bun install' manually to diagnose"
      return 1
    fi
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
# codebase-memory-mcp: mcp-adapter.json write + binary download
#
# pi 0.99 split MCP server config into two files:
#   ~/.pi/agent/mcp.json         — read by the built-in 'mcp' extension
#   ~/.pi/agent/mcp-adapter.json — read by the npm:pi-mcp-adapter
#
# Sages ships pi-mcp-adapter (it registers the /mcp command and takes
# precedence over the built-in mcp extension), so the
# codebase-memory-mcp server entry has to land in mcp-adapter.json
# for sage's MCP clients to see it. mcp.json is left alone unless the
# user opted in by creating one themselves.
# ────────────────────────────────────────────────────────────

write_codebase_memory_mcp_config() {
  local target="$PI_DIR/agent/mcp-adapter.json"

  # NEVER-TOUCH policy: if mcp-adapter.json already exists (the user
  # created it manually, or a prior install populated it), leave it
  # alone. The user owns this file.
  if [[ -f "$target" ]]; then
    echo "  Skipped $target (already exists, user-customized — preserved as-is)"
    return 0
  fi

  mkdir -p "$PI_DIR/agent"

  # Migration from pi 0.98 to 0.99: pi-mcp-adapter now reads
  # mcp-adapter.json instead of mcp.json. If the user already has
  # mcp.json with their own MCP server entries (goodluck-data,
  # MiniMax, etc.), use it as the source — that way every server
  # they configured is visible to pi-mcp-adapter, not just the
  # codebase-memory-mcp that comes with sages.
  if [[ -f "$PI_DIR/agent/mcp.json" ]]; then
    cp "$PI_DIR/agent/mcp.json" "$target"
    echo "  Wrote $target from existing mcp.json (preserves all user servers)"
    echo "  Hint: pi-mcp-adapter no longer reads mcp.json. You can"
    echo "    safely delete ~/.pi/agent/mcp.json once you have confirmed"
    echo "    every server entry is in $target."
    return 0
  fi

  # No mcp.json either — fall back to the bundled template.
  local template=""
  if [[ -f "$PI_CODEBASE_MEMORY_DEST_DIR/templates/mcp.json" ]]; then
    template="$PI_CODEBASE_MEMORY_DEST_DIR/templates/mcp.json"
  elif [[ -f "$LOCAL_REPO_ROOT/$PI_CODEBASE_MEMORY_SRC_REL/templates/mcp.json" ]]; then
    template="$LOCAL_REPO_ROOT/$PI_CODEBASE_MEMORY_SRC_REL/templates/mcp.json"
  fi
  [[ -z "$template" ]] && { echo "  Warning: codebase-memory-mcp mcp.json template not found"; return 0; }

  cp "$template" "$target"
  echo "  Wrote $target from template"
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
# and `reviewer` agents are both built-in to pi-subagents (GC-2026-091
# renamed `auditor` → `reviewer`). Pre-existing user-level
# `developer.md` and `auditor.md` files
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

# Clean stale lockfiles in the npm-prefix dir before any npm install.
#
# Background: npm 11.x arborist throws `TypeError: Invalid Version` from
# `Node.canDedupe` whenever the prefix dir carries a `.package-lock.json`
# written by an older npm that embedded version specifiers (e.g. with a
# `npm:` alias prefix) which npm 11's SemVer parser cannot round-trip.
# The dir accumulates such files across pi upgrades — once poisoned,
# every subsequent `npm install --prefix ~/.pi/agent/npm` aborts.
#
# Surgical fix: drop the top-level `package-lock.json` and the interior
# `node_modules/.package-lock.json`. The installed package directories
# under `node_modules/` stay intact (we don't touch them), so a re-install
# only re-resolves the tree, not the actual deps. If a previous install
# was incomplete and the dir is fully unusable, the install below will
# surface a clear error and the user can `rm -rf ~/.pi/agent/npm` manually.
_clean_npm_prefix_dir() {
    local prefix="$1"
    [[ -d "$prefix" ]] || return 0
    rm -f \
        "$prefix/package-lock.json" \
        "$prefix/node_modules/.package-lock.json" \
        "$prefix/node_modules/.package-lock.json.tmp" \
        2>/dev/null || true
}

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

# Per-peer critical-deps verification functions — mirrors
# verify_critical_orchestrator_deps for the other sage peers.
#
# Each function lists the modules that the peer's extension entry
# imports at module-load time. The set is derived by grepping
# `^import .* from ['"]<name>['"]` across `peer/src/*.ts` against
# non-relative, non-node: imports, then filtering to anything in
# the peer's package.json dependencies (or transitively resolved).
# Anything not declared in deps but imported at load time is a
# latent bug — flag it.
#
# Critical sets (as of this commit):
#   pi-subagents:   typebox, croner, nanoid
#     typebox is in peerDependencies with "*" — pi's runtime provides
#     it. bun hoists pi-coding-agent's bundled typebox@1.x into the
#     same node_modules tree, so the runtime path is correct.
#     croner + nanoid are workspace-level non-pi deps that pi-subagents
#     uses at extension load (see src/index.ts); without them the
#     Agent tool registration throws "Cannot find module" at pi
#     session start, mirroring the original js-yaml failure.
#   pi-evaluator:   typebox (same peer story as pi-subagents).
#   pi-codebase-memory: no critical runtime deps — only peer
#     `@earendil-works/pi-coding-agent` which pi provides.

verify_critical_subagents_deps() {
  local pkg_dir="$1"
  local missing=()
  for dep in typebox croner nanoid; do
    if [[ ! -d "$pkg_dir/node_modules/$dep" ]]; then
      missing+=("$dep")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "  ERROR: pi-subagents critical deps missing after bun install:"
    for dep in "${missing[@]}"; do
      echo "    - $pkg_dir/node_modules/$dep"
    done
    echo "  Run 'cd $pkg_dir && bun install' manually to recover"
    return 1
  fi
  return 0
}

verify_critical_evaluator_deps() {
  local pkg_dir="$1"
  local missing=()
  # @sinclair/typebox resolves to either node_modules/@sinclair/typebox/
  # or node_modules/typebox/ depending on the package manager's hoisting
  # strategy (bun resolves via the package's own name field, which is
  # "typebox"). Accept either.
  if [[ ! -d "$pkg_dir/node_modules/typebox" \
     && ! -d "$pkg_dir/node_modules/@sinclair/typebox" ]]; then
    missing+=("typebox")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "  ERROR: pi-evaluator critical deps missing after bun install:"
    for dep in "${missing[@]}"; do
      echo "    - $pkg_dir/node_modules/$dep"
    done
    echo "  Run 'cd $pkg_dir && bun install' manually to recover"
    return 1
  fi
  return 0
}

# verify_critical_codebase_memory_deps: no critical runtime deps to
# check (only the @mariozechner/pi-coding-agent peer, which pi itself
# provides). Kept as a function so the final verify-all gate has a
# uniform call surface.
verify_critical_codebase_memory_deps() {
  local pkg_dir="$1"
  # Intentional no-op. Left as a placeholder so adding a new critical
  # dep later is a one-line change.
  return 0
}

# verify_critical_tasks_deps — GC-2026-install-pi-tasks
# pi-tasks imports typebox at module-load time (for the TaskCreate /
# TaskUpdate TypeBox parameter schemas in src/index.ts). typebox is
# declared in pi-tasks/package.json#dependencies as "^1.1.34", not
# peerDependencies, so it must be installed under pi-tasks/node_modules/.
# Without it, TaskCreate throws "Cannot find module 'typebox'" at
# pi session start.
verify_critical_tasks_deps() {
  local pkg_dir="$1"
  local missing=()
  if [[ ! -d "$pkg_dir/node_modules/typebox" ]]; then
    missing+=("typebox")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "  ERROR: pi-tasks critical deps missing after bun install:"
    for dep in "${missing[@]}"; do
      echo "    - $pkg_dir/node_modules/$dep"
    done
    echo "  Run 'cd $pkg_dir && bun install' manually to recover"
    return 1
  fi
  return 0
}

# Final gate: run all per-peer critical-deps verifies and exit 1 if
# any peer is missing required modules. Called at the END of install()
# so it catches:
#   - per-peer install steps that silently failed (peer installs use
#     `bun install --silent || true`, swallowing errors)
#   - state where a peer dir was deleted out-of-band but settings.json
#     still registers it (the is_*_installed guards would skip reinstall)
#   - post-install race conditions (something wiped a peer/node_modules
#     between install_pi_*_files and the next session start)
#
# GC-2026-stale-package-entries: auto-prune stale (non-existent,
# non-managed) entries from settings.json#packages before the gates run.
# Symptom guarded: a path that points to a directory that no longer exists
# (e.g. a leftover from an older install attempt with a renamed package
# dir, or a manual edit that was never cleaned up) fails gate 2
# (verify_package_existence) AND gate 3 (verify:extension-load) with no
# obvious recovery — the user sees "1 issue(s); packages already in
# settings.json" and has to manually edit JSON. Auto-pruning keeps the
# install self-healing.
#
# Scope: only entries that are (a) local-path (not npm:), (b) missing on
# disk, and (c) NOT one of the sage packages this installer manages.
# Managed packages that go missing on disk are reinstalled by install()
# before this gate runs; if a managed package is still missing here, gate
# 2's loud failure is the correct signal — this function does NOT prune
# managed packages.
prune_stale_package_entries() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 0
  command -v python3 &>/dev/null || return 0

  # Build the managed-paths list as a colon-separated string for python.
  # `|` is safe because none of the sage dest paths contain it.
  local managed_paths=""
  for p in \
      "$PI_ORCHESTRATOR_DEST_DIR" \
      "$PI_SUBAGENTS_DEST_DIR" \
      "$PI_EVALUATOR_DEST_DIR" \
      "$PI_CODEBASE_MEMORY_DEST_DIR" \
      "$PI_TASKS_DEST_DIR"; do
    managed_paths+="|${p}"
  done

  python3 - "$settings" "$managed_paths" <<'PYEOF'
import json, os, sys
settings_path, managed_raw = sys.argv[1], sys.argv[2]
managed = set(managed_raw.split("|")[1:])  # drop leading empty before first `|`
try:
    d = json.load(open(settings_path))
except Exception:
    sys.exit(0)  # malformed settings.json — let downstream gates flag it
pkgs = d.get("packages", [])
kept, pruned = [], []
for p in pkgs:
    if not isinstance(p, str):
        kept.append(p)  # unexpected type — don't touch
        continue
    if p.startswith("npm:"):
        kept.append(p)  # npm owns lifecycle
        continue
    if os.path.isdir(p):
        kept.append(p)  # existing local-path entry — keep
        continue
    if p in managed:
        kept.append(p)  # managed but missing — let gate 2 flag loud
        continue
    pruned.append(p)  # stale: missing AND non-managed AND non-npm
if pruned:
    d["packages"] = kept
    json.dump(d, open(settings_path, "w"), indent=2)
    for p in pruned:
        print(f"    pruned stale settings.json entry: {p} (directory does not exist)")
PYEOF
}

# The function prints a clear recovery command per missing peer and
# returns non-zero so the caller exits non-zero.
# Returns non-zero so the caller exits non-zero.
verify_package_existence() {
  # GC-2026-main-agent-tool-surface: every path registered in
  # settings.json#packages must point at an existing directory.
  # The host extension loader
  #   (pi-coding-agent's loader.js:541-555, fail-soft path)
  # silently skips a missing path with zero logging, so the LLM
  # has no way to know a peer is gone. This gate catches the
  # "registered but missing" class at install time so the user
  # sees a clear recovery path (`bash install.sh --force`).
  #
  # npm: peers (e.g. `npm:pi-mcp-adapter`) are skipped — npm owns
  # their existence; install.sh only validates local-path peers.
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 0  # nothing to verify
  local missing=()
  while IFS= read -r pkg; do
    [[ "$pkg" == npm:* ]] && continue
    if [[ ! -d "$pkg" ]]; then
      missing+=("$pkg")
    fi
  done < <(python3 -c "import json; print('\n'.join(json.load(open('$settings')).get('packages', [])))" 2>/dev/null)
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "  ERROR: registered package(s) missing on disk:"
    for p in "${missing[@]}"; do
      echo "    - $p"
    done
    return 1
  fi
  return 0
}

verify_all_critical_install_deps() {
  local missing_total=0
  echo "==> Verifying critical deps for all installed packages..."

  if ! verify_critical_orchestrator_deps "$PI_ORCHESTRATOR_DEST_DIR"; then
    missing_total=$((missing_total + 1))
  fi
  if [[ -d "$PI_SUBAGENTS_DEST_DIR" ]]; then
    if ! verify_critical_subagents_deps "$PI_SUBAGENTS_DEST_DIR"; then
      missing_total=$((missing_total + 1))
    fi
  fi
  if [[ -d "$PI_EVALUATOR_DEST_DIR" ]]; then
    if ! verify_critical_evaluator_deps "$PI_EVALUATOR_DEST_DIR"; then
      missing_total=$((missing_total + 1))
    fi
  fi
  if [[ -d "$PI_CODEBASE_MEMORY_DEST_DIR" ]]; then
    if ! verify_critical_codebase_memory_deps "$PI_CODEBASE_MEMORY_DEST_DIR"; then
      missing_total=$((missing_total + 1))
    fi
  fi
  if [[ -d "$PI_TASKS_DEST_DIR" ]]; then
    if ! verify_critical_tasks_deps "$PI_TASKS_DEST_DIR"; then
      missing_total=$((missing_total + 1))
    fi
  fi

  if [[ $missing_total -gt 0 ]]; then
    echo ""
    echo "ERROR: $missing_total package(s) have missing critical deps."
    echo "Run 'bash $0 --force' to repair (re-copies files + reinstalls deps)."
    return 1
  fi
  echo "  All critical deps present."
  return 0
}

# GC-2026-110 FU1b: consolidated post-install gates. Returns 0 iff every
# gate passes. The three gates (in order):
#   1. critical_deps — every installed package has its critical
#      runtime deps in node_modules (catches silent bun install failures)
#   2. package_existence — every package registered in
#      settings.json#packages has its dest dir on disk (catches npm
#      peers uninstalled but path still registered)
#   3. extension_load — jiti-imports every registered package's entry
#      and verifies the default export is a function (catches typo in
#      package.json#pi.extensions, missing transitive deps, etc.)
# `--no-smoke` (read from $SMOKE) skips gate (3); gates (1) and (2)
# always run because they're cheap and catch real partial-failure bugs.
run_post_install_gates() {
  local failed=0

  # GC-2026-stale-package-entries: prune stale local-path entries before
  # the gates so a leftover from a previous install attempt doesn't fail
  # gate 2 (verify_package_existence) or gate 3 (verify:extension-load).
  # See prune_stale_package_entries for the full policy.
  prune_stale_package_entries || true

  # Gate 1: critical deps
  if ! verify_all_critical_install_deps; then
    failed=$((failed + 1))
  fi

  # Gate 2: registered-package existence
  if ! verify_package_existence; then
    failed=$((failed + 1))
  fi

  # Gate 3: extension-load smoke test (skippable via --no-smoke)
  if [[ "${SMOKE:-true}" == "true" ]]; then
    echo ""
    echo "==> POST-INSTALL SMOKE TEST: extension load via jiti"
    echo "    (catches silent fail-soft in pi-coding-agent's loader: typo in"
    echo "    package.json#pi.extensions, missing transitive deps, etc.)"
    if command -v bun &>/dev/null; then
      # Use $SCRIPT_DIR absolute path so the call works regardless of
      # cwd (the script is sometimes invoked as
      # `bash pi-orchestrator/scripts/install.sh` from the repo root,
      # where `bun run scripts/...` would fail with "Module not found").
      if bun run "$SCRIPT_DIR/verify-extension-load.ts"; then
        echo "==> POST-INSTALL SMOKE TEST: PASS"
      else
        echo "==> POST-INSTALL SMOKE TEST: FAIL"
        failed=$((failed + 1))
      fi
    else
      echo "  (skipped verify:extension-load — bun not on PATH)"
    fi
  else
    echo ""
    echo "==> POST-INSTALL SMOKE TEST: skipped (--no-smoke)"
  fi

  return $failed
}

is_pi_orchestrator_installed() {
  # Auto-recovery invariant: return true ONLY when both conditions hold —
  # settings.json registers the package AND the dest dir exists on disk.
  # Mirrors is_pi_codebase_memory_installed (line 237) + is_pi_subagents_installed
  # (line ~1127) + is_pi_evaluator_installed + is_pi_tasks_installed.
  # GC-2026-main-agent-tool-surface: this was the only missing guard.
  # Without it, a deleted $PI_DIR/packages/pi-orchestrator/ passed the
  # early-return at line ~2093 below, and the orchestrator's tools
  # (goal_contract_create + workflow_run) silently vanished from the
  # LLM-facing tool surface — the host's extension loader at
  # pi-coding-agent's loader.js:541-555 fail-softs with zero logging.
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1

  python3 -c "
import json, os, sys
try:
    d = json.load(open('$settings'))
    pkg = '$PI_ORCHESTRATOR_PKG'
    if pkg in d.get('packages', []) and os.path.isdir(pkg):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
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
  # below catches that case, prints a clear recovery path, AND
  # propagates the failure (return 1) so the caller's
  # `|| exit 1` actually exits the install.
  #
  # Propagation invariant: any failure of verify_critical_orchestrator_deps
  # returns 1 from this function. Without it, the verify print was a no-op
  # (the install reported success) and the user only learned about the
  # missing dep when pi failed to load the extension at next session start.
  if [[ -f "$PKG_DIR/package.json" ]] && command -v bun &>/dev/null; then
    echo "  Installing dependencies (bun install)..."
    if ! (cd "$PKG_DIR" && bun install 2>&1 | tail -10); then
      echo "  ERROR: bun install failed; deps may be missing"
      echo "  Run 'cd $PKG_DIR && bun install' manually to diagnose"
      return 1
    elif ! verify_critical_orchestrator_deps "$PKG_DIR"; then
      echo "  Run 'cd $PKG_DIR && bun install' manually to recover"
      return 1
    fi
  elif [[ -f "$PKG_DIR/package.json" ]] && ! command -v bun &>/dev/null; then
    echo "  Warning: bun not found on PATH; $PKG_DIR/node_modules not populated"
    echo "  Install bun (https://bun.sh) and re-run install.sh, or run"
    echo "  'cd $PKG_DIR && npm install' manually before starting pi."
    return 1
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
  for peer in pi-subagents pi-codebase-memory pi-evaluator pi-tasks; do
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

  # GC-2026-failure-catalog-move: pi-orchestrator owns the failure-catalog
  # data + parser as of this GC. pi-subagents/src/diagnostic.ts still
  # needs to read the catalog YAML at runtime (3 call sites: allIds,
  # matches, lookup). The data file ships in both packages' installs
  # so each can read its own copy without cross-package path resolution.
  # The canonical source is $LOCAL_REPO_ROOT/pi-orchestrator/src/data/;
  # we copy it to $PI_SUBAGENTS_DEST_DIR/src/data/ here. Drift is bounded
  # by the install.sh copy step (single source of truth on disk).
  local catalog_src="$LOCAL_REPO_ROOT/pi-orchestrator/src/data/failure-modes.v1.yaml"
  local catalog_dst_dir="$PI_SUBAGENTS_DEST_DIR/src/data"
  if [[ -f "$catalog_src" ]]; then
    mkdir -p "$catalog_dst_dir"
    cp "$catalog_src" "$catalog_dst_dir/failure-modes.v1.yaml"
    if [[ -f "$LOCAL_REPO_ROOT/pi-orchestrator/src/data/failure-modes.v1.schema.json" ]]; then
      cp "$LOCAL_REPO_ROOT/pi-orchestrator/src/data/failure-modes.v1.schema.json" \
        "$catalog_dst_dir/failure-modes.v1.schema.json"
    fi
  fi
  if [[ -f "$PI_SUBAGENTS_DEST_DIR/package.json" ]] && command -v bun &>/dev/null; then
    # Drop --silent + add verify_critical_subagents_deps — mirror of
    # the orchestrator fix at commit e2e0101. pi-subagents imports
    # @sinclair/typebox, croner, and nanoid at extension-load time
    # (see src/index.ts), so a silent install failure means the Agent
    # tool can't register and pi fails at session start.
    if ! (cd "$PI_SUBAGENTS_DEST_DIR" && bun install 2>&1 | tail -10); then
      echo "  ERROR: pi-subagents bun install failed"
      echo "  Run 'cd $PI_SUBAGENTS_DEST_DIR && bun install' manually to diagnose"
      return 1
    elif ! verify_critical_subagents_deps "$PI_SUBAGENTS_DEST_DIR"; then
      return 1
    fi
  fi
}

# NOTE: install_pi_orchestrator_files was removed — it duplicated the
# canonical install_orchestrator_files() above and still used the pre-fix
# `bun install --silent 2>&1 | tail -1 || true` pattern that originally
# caused the "Cannot find module 'js-yaml'" failure (the --silent flag
# swallowed bun install errors so js-yaml was missing from
# ~/.pi/packages/pi-orchestrator/node_modules/). The active path now
# drops --silent and runs verify_critical_orchestrator_deps after the
# install, which fails loud with a recovery command if js-yaml or
# typebox are absent. See commit e2e0101 for the original fix.

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
    # Drop --silent + add verify_critical_evaluator_deps — mirror of
    # the orchestrator fix at commit e2e0101. pi-evaluator's src imports
    # `from "typebox"` at module load (see src/tools/eval-*.ts); a silent
    # install failure leaves the dir missing and pi fails at session start.
    if ! (cd "$PI_EVALUATOR_DEST_DIR" && bun install 2>&1 | tail -10); then
      echo "  ERROR: pi-evaluator bun install failed"
      echo "  Run 'cd $PI_EVALUATOR_DEST_DIR && bun install' manually to diagnose"
      return 1
    elif ! verify_critical_evaluator_deps "$PI_EVALUATOR_DEST_DIR"; then
      return 1
    fi
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
# pi-tasks — workflow engine for pi (GC-2026-install-pi-tasks)
#
# pi-tasks exposes 7 Claude Code-compatible tools (TaskCreate, TaskList,
# TaskGet, TaskUpdate, TaskOutput, TaskStop, TaskExecute). The
# orchestrator's workflow_run tool (GC-2026-workflow-run) creates 4
# pi-tasks tasks per pipeline (Implement / Review / Fix / Merge) tagged
# with metadata.workflow_run_goal_id so the LLM can see live progress
# via TaskList (GC-2026-pi-tasks-integration).
#
# pi-tasks is file-copied from $LOCAL_REPO_ROOT/pi-tasks (the Sages
# fork of @tintinweb/pi-tasks v0.9.0). The npm upstream
# (npm:@tintinweb/pi-tasks) is intentionally NOT installed because it
# would conflict with the local fork by registering the same tool
# names. If a user previously had the npm version installed,
# uninstall_pi_tasks strips both forms.
#
# Critical runtime dep: typebox (declared in package.json#dependencies;
# pi-tasks imports it at module-load time for the TypeBox parameter
# schemas in src/index.ts). Without it, TaskCreate throws
# "Cannot find module 'typebox'" at pi session start.
# ──────────────────────────────────────────────────────────────────

is_pi_tasks_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1
  python3 -c "
import json, os, sys
try:
    d = json.load(open('$settings'))
    pkg = '$PI_TASKS_PKG'
    if pkg in d.get('packages', []) and os.path.isdir(pkg):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_pi_tasks_files() {
  local src_root="$LOCAL_REPO_ROOT/$PI_TASKS_SRC_REL"
  [[ ! -d "$src_root" ]] && {
    echo "  Warning: $src_root not found in local sages repo, skipping pi-tasks files"
    return 0
  }
  if [[ -d "$PI_TASKS_DEST_DIR" && "${FORCE:-false}" != true ]]; then
    echo "  Skipping pi-tasks files (exists, use --force)"
  else
    rm -rf "$PI_TASKS_DEST_DIR"
    mkdir -p "$PI_DIR/packages"
    cp -r "$src_root" "$PI_TASKS_DEST_DIR"
    echo "  Installed pi-tasks files to $PI_TASKS_DEST_DIR"
  fi
  if [[ -f "$PI_TASKS_DEST_DIR/package.json" ]] && command -v bun &>/dev/null; then
    if ! (cd "$PI_TASKS_DEST_DIR" && bun install 2>&1 | tail -10); then
      echo "  ERROR: pi-tasks bun install failed"
      echo "  Run 'cd $PI_TASKS_DEST_DIR && bun install' manually to diagnose"
      return 1
    elif ! verify_critical_tasks_deps "$PI_TASKS_DEST_DIR"; then
      return 1
    fi
  fi
}

install_pi_tasks() {
  echo "==> Installing pi-tasks..."
  if is_pi_tasks_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  pi-tasks already installed (use --force to reinstall)"
    return 0
  fi
  if ! install_pi_tasks_files; then
    echo "  Error: install_pi_tasks_files failed, aborting"
    return 1
  fi
  if is_pi_tasks_installed; then
    echo "  pi-tasks already registered in settings.json"
  else
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ ! -f "$settings" ]] && echo '{"packages": []}' > "$settings"
    python3 -c "
import json
f, pkg = '$settings', '$PI_TASKS_PKG'
try: d = json.load(open(f))
except: d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
    json.dump(d, open(f, 'w'), indent=2)
    print('  Registered', pkg)
"
  fi
  echo "  pi-tasks installed"
}

uninstall_pi_tasks() {
  echo "==> Uninstalling pi-tasks..."

  # 1) Strip BOTH forms from settings.json (handles legacy npm install + the local fork path).
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    new_pkgs = [p for p in pkgs if not (p == 'npm:@tintinweb/pi-tasks' or p.endswith('/pi-tasks') or p.endswith('@tintinweb/pi-tasks') or p.endswith('@sages/pi-tasks'))]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('  Removed pi-tasks entries from settings.json')
except Exception as e:
    print('  Warning:', e, file=sys.stderr)
" 2>/dev/null || true

  # 2) Remove the package directory if it exists.
  if [[ -d "$PI_TASKS_DEST_DIR" ]]; then
    rm -rf "$PI_TASKS_DEST_DIR"
    echo "  Removed $PI_TASKS_DEST_DIR"
  fi

  # 3) Remove pi-tasks task files (~/.pi/tasks/) — best-effort, only
  #    if the dir is empty after removal. We don't want to nuke a
  #    user's existing task list silently.
  local tasks_dir="$HOME/.pi/tasks"
  if [[ -d "$tasks_dir" ]] && [[ -z "$(ls -A "$tasks_dir" 2>/dev/null)" ]]; then
    rmdir "$tasks_dir" 2>/dev/null || true
  fi

  echo "  pi-tasks uninstalled"
}

# ──────────────────────────────────────────────────────────────────
# npm-peer extensions — no version pin (latest from npm registry)
#
# Both `npm:` extension sources below are unpinned on purpose. Each
# PI_*_PKG constant is the bare `npm:<name>` form (no `@version`
# suffix). npm installs latest on each run, so install.sh tracks
# upstream releases without an explicit bump. To pin a specific
# version (rollback / known-good), append `@<x.y.z>` to the constant
# and re-run install.sh --force.
#
#   pi-mcp-adapter                → latest
#
# pi's package manager still parses the `npm:` form correctly even
# without a version suffix (see parseSource in
# @earendil-works/pi-coding-agent/dist/core/package-manager.js);
# installed-vs-configured version checks fall back to a
# ">= version-or-anything" comparison when the configured spec
# carries no version.
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
# cleanup_legacy_magic_context — one-shot cleanup for users who
# installed the (now-removed) magic-context extension before
# GC-2026-remove-magic-context. Idempotent: safe to run multiple
# times, no-op when no legacy install exists.
#
# Removes:
#   - the npm package at ~/.pi/agent/npm/node_modules/@cortexkit/pi-magic-context
#   - the registration entry in ~/.pi/agent/settings.json (any form:
#     legacy version-less, pinned @version, or /path/... local-fork)
#   - the config at ~/.config/cortexkit/magic-context.jsonc (only
#     when it carries our SAGES_TEMPLATE_V1 marker; user-customized
#     configs are left alone)
# ──────────────────────────────────────────────────────────────────
cleanup_legacy_magic_context() {
  local pkg_dir="$PI_DIR/agent/npm/node_modules/@cortexkit/pi-magic-context"
  local settings="$PI_DIR/agent/settings.json"
  local config="$HOME/.config/cortexkit/magic-context.jsonc"
  local touched=0

  # 1) Remove installed package files (best-effort).
  if [[ -d "$pkg_dir" ]]; then
    rm -rf "$pkg_dir" 2>/dev/null && echo "  Removed legacy pi-magic-context package files" && touched=1
  fi

  # 2) Strip any form from settings.json.
  if [[ -f "$settings" ]]; then
    python3 -c "
import json, re, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    PKG_PATTERN = re.compile(r'^(npm:@cortexkit/pi-magic-context(@.+)?|.*/pi-magic-context)\$')
    new_pkgs = [p for p in pkgs if not PKG_PATTERN.match(p)]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open('$settings', 'w'), indent=2)
        print('  Removed legacy pi-magic-context registration from settings.json')
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null && touched=1
  fi

  # 3) NEVER-TOUCH policy: only remove config if it carries our
  #    SAGES_TEMPLATE_V1 sentinel; user-customized configs are preserved.
  if [[ -f "$config" ]] && grep -q 'SAGES_TEMPLATE_V1' "$config" 2>/dev/null; then
    rm -f "$config"
    echo "  Removed legacy magic-context config (was our template)"
    touched=1
  elif [[ -f "$config" ]]; then
    echo "  Legacy magic-context config is user-customized, leaving alone"
  fi

  if [[ $touched -eq 0 ]]; then
    echo "  No legacy pi-magic-context install found"
  fi
}
# ────────────────────────────────────────────────────────────
# pi-mcp-adapter — MCP (Model Context Protocol) server adapter for pi
# (npm-installed; see header for pinning policy)
#
# Mirrors the (now-removed) install_pi_magic_context npm-install pattern. The
# `@napi-rs/keyring` native dep compiles via node-gyp on install; the
# `--ignore-scripts` flag matches the previous magic-context onnx-postinstall skip
# (used here for parity and to keep the install offline-safe). If the
# user later needs OAuth credential storage, they can reinstall without
# --ignore-scripts to build the native binary.
# ────────────────────────────────────────────────────────────

# pi-mcp-adapter (latest, no version pin — see header above)
PI_MCP_ADAPTER_PKG="npm:pi-mcp-adapter"
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
    # cd to ${LOCAL_REPO_ROOT:-/tmp} to match the prior magic-context pattern; --prefix
    # governs the install location so cwd is incidental.
    #
    # Same `npm:` alias fix as the prior magic-context install: strip the prefix from
    # the npm install spec (npm 11's `Node.canDedupe` chokes on
    # `npm:name@version` with `Invalid Version`) and clean stale
    # `.package-lock.json` files in the prefix dir. settings.json keeps
    # the `npm:` form for pi's transport hint. Only register on success.
    _clean_npm_prefix_dir "$PI_DIR/agent/npm"
    local npm_spec="${PI_MCP_ADAPTER_PKG#npm:}"
    if (cd "${LOCAL_REPO_ROOT:-/tmp}" && \
      npm install --prefix "$PI_DIR/agent/npm" --legacy-peer-deps --ignore-scripts "$npm_spec" 2>&1 | tail -3); then
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
      echo "  Warning: npm install failed; try 'npm install --prefix ~/.pi/agent/npm --ignore-scripts $npm_spec' manually"
      echo "  Skipping settings.json registration (no dangling pointer for pi)"
    fi
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
# AFT (@cortexkit/aft-pi) — full install path baked in (GC-2026-096)
#
# Three pieces, mirroring existing precedents:
#   - AFT config (~/.config/cortexkit/aft.jsonc) — mirrors magic-context
#     cleanup_legacy_magic_context sentinel pattern
#   - AFT npm peer (@cortexkit/aft-pi) — mirrors install_pi_mcp_adapter
#   - AFT binary (~/.local/bin/aft) — mirrors install_codebase_memory_mcp_binary
#
# All three are soft-fail (warn-and-continue) so a flaky network never
# breaks the install. The one hard fail is binary checksum mismatch
# (don't install a tampered binary).
#
# Windows installers (install.ps1 / install.bat) intentionally NOT
# updated by this GC — TODO when those scripts get the same treatment.
# ────────────────────────────────────────────────────────────

is_aft_config_installed() {
  # Sentinel-based detection — same pattern as install_agent_tool_description.
  # Returns true iff the deployed config file exists AND carries the
  # SAGES_TEMPLATE_V1 sentinel we stamp into the template body. A
  # user-customized file (sentinel removed) returns false so install is
  # a no-op for it (AC-4 — never clobber user customization).
  [[ -f "$AFT_CONFIG" ]] && grep -q "$AFT_SENTINEL" "$AFT_CONFIG" 2>/dev/null
}

install_aft_config() {
  echo "==> Installing AFT config..."
  if [[ ! -f "$AFT_TEMPLATE" ]]; then
    echo "  Error: AFT config template not found at $AFT_TEMPLATE"
    echo "  (Re-download the sages repo or restore templates/aft.jsonc)"
    return 1
  fi
  if is_aft_config_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  AFT config already installed (use --force to reinstall)"
    return 0
  fi
  # User-customized detection: file exists without sentinel → leave alone
  # unless --force explicitly overrides. Mirrors the agent-tool-description
  # behavior (install_agent_tool_description).
  if [[ -f "$AFT_CONFIG" ]] && ! is_aft_config_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  AFT config is user-customized (no SAGES_TEMPLATE_V1 sentinel); leaving alone"
    echo "  Use --force to overwrite"
    return 0
  fi
  mkdir -p "$(dirname "$AFT_CONFIG")"
  cp "$AFT_TEMPLATE" "$AFT_CONFIG"
  echo "  Installed AFT config at $AFT_CONFIG"
}

uninstall_aft_config() {
  # Mirror uninstall_agent_tool_description: only remove files we
  # installed. User-customized configs (no sentinel) are preserved.
  if [[ ! -f "$AFT_CONFIG" ]]; then
    return 0
  fi
  if grep -q "$AFT_SENTINEL" "$AFT_CONFIG" 2>/dev/null; then
    rm -f "$AFT_CONFIG"
    echo "  Removed $AFT_CONFIG (was our template)"
  else
    echo "  $AFT_CONFIG is user-customized, leaving alone"
  fi
}

is_aft_pi_npm_installed() {
  # Auto-recovery invariant: require BOTH settings.json registration
  # AND node_modules dir on disk (mirrors is_pi_mcp_adapter_installed).
  # PKG_PATTERN matches three forms so a legacy version-less entry does
  # not silently no-op the install:
  #   1. npm:@cortexkit/aft-pi          (this GC's preferred form)
  #   2. npm:@cortexkit/aft-pi@X.Y.Z    (future pinned form)
  #   3. /path/to/aft-pi                (hypothetical local-fork path)
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1
  python3 -c "
import json, os, re, sys
try:
    d = json.load(open('$settings'))
    PKG_PATTERN = re.compile(r'^(npm:@cortexkit/aft-pi(@.+)?|.*/aft-pi)\$')
    registered = any(PKG_PATTERN.match(p) for p in d.get('packages', []))
    if registered and os.path.isdir('$AFT_NPM_DIR'):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

install_aft_pi_npm() {
  echo "==> Installing @cortexkit/aft-pi npm peer..."
  if is_aft_pi_npm_installed && [[ "${FORCE:-false}" != true ]]; then
    echo "  @cortexkit/aft-pi already installed (use --force to reinstall)"
    return 0
  fi
  if [[ "${FORCE:-false}" == true ]] && is_aft_pi_npm_installed; then
    echo "  Force-reinstall: removing previous @cortexkit/aft-pi first"
    uninstall_aft_pi_npm
  fi
  # Soft-fail when pi CLI is missing — mirrors install_pi_mcp_adapter.
  # Without pi on PATH we have no way to know whether the user intends
  # to use the npm-prefix install or a different path.
  if ! command -v pi &>/dev/null; then
    echo "  'pi' command not found; user must install manually"
    return 0
  fi
  _clean_npm_prefix_dir "$PI_DIR/agent/npm"
  local npm_spec="${AFT_NPM_PKG#npm:}"
  if (cd "${LOCAL_REPO_ROOT:-/tmp}" && \
    npm install --prefix "$PI_DIR/agent/npm" --legacy-peer-deps --ignore-scripts "$npm_spec" 2>&1 | tail -3); then
    local settings="$PI_DIR/agent/settings.json"
    mkdir -p "$(dirname "$settings")"
    [[ -f "$settings" ]] || echo '{"packages": []}' > "$settings"
    python3 -c "
import json, re
f, pkg = '$settings', '$AFT_NPM_PKG'
PKG_PATTERN = re.compile(r'^(npm:@cortexkit/aft-pi(@.+)?|.*/aft-pi)\$')
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
    echo "  Warning: npm install failed; AFT tools won't be available until manually installed"
    echo "  To retry: npm install --prefix $PI_DIR/agent/npm --ignore-scripts $npm_spec"
  fi
}

uninstall_aft_pi_npm() {
  # Strip any form (legacy version-less, pinned @version, or /path/...
  # local-fork) from settings.json. Mirrors uninstall_pi_mcp_adapter.
  local settings="$PI_DIR/agent/settings.json"
  [[ -f "$settings" ]] && python3 -c "
import json, re, sys
try:
    d = json.load(open('$settings'))
    pkgs = d.get('packages', [])
    PKG_PATTERN = re.compile(r'^(npm:@cortexkit/aft-pi(@.+)?|.*/aft-pi)\$')
    new_pkgs = [p for p in pkgs if not PKG_PATTERN.match(p)]
    if len(new_pkgs) != len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('  Removed @cortexkit/aft-pi from settings.json')
except Exception as e:
    sys.exit(1)
" 2>/dev/null || true

  if [[ -d "$AFT_NPM_DIR" ]]; then
    rm -rf "$AFT_NPM_DIR"
    echo "  Removed $AFT_NPM_DIR"
  fi

  echo "  @cortexkit/aft-pi uninstalled"
}

install_aft_binary() {
  echo "==> Installing AFT binary..."

  # Resolve expected version from the just-installed npm peer, falling
  # back to "latest" when the peer isn't installed yet. Reading the
  # version from package.json pins the binary to exactly what
  # @cortexkit/aft-pi bundles — avoids the "binary from one release,
  # plugin from another" version-skew trap.
  local expected_version=""
  if [[ -f "$AFT_NPM_DIR/package.json" ]]; then
    expected_version=$(python3 -c "import json; print(json.load(open('$AFT_NPM_DIR/package.json')).get('version',''))" 2>/dev/null)
  fi
  [[ -z "$expected_version" ]] && expected_version="latest"

  # Decision 1 (B2): version-pinned probe across the standard AFT
  # search path. If ANY candidate runs `aft --version` and reports
  # the expected version, skip the download even with --force —
  # preserves the user's working install across repair runs.
  # Mismatched version falls through to the curl download path.
  for candidate in \
    "$HOME/.cache/aft/bin/v$expected_version/aft" \
    "$AFT_BINARY" \
    "$HOME/.cargo/bin/aft"; do
    if [[ -x "$candidate" ]]; then
      local actual
      actual=$("$candidate" --version 2>/dev/null) || continue
      if [[ "$actual" == "aft $expected_version" ]]; then
        echo "  AFT binary v$expected_version already installed at $candidate, skipping download"
        return 0
      fi
    fi
  done

  if ! command -v curl &>/dev/null; then
    echo "  Error: curl required to install AFT binary"
    echo "  Install curl or run 'npx @cortexkit/aft setup --harness pi --yes' manually"
    return 1
  fi

  local os arch asset url checksums_url
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in linux|darwin) ;; *) echo "  Error: unsupported OS $os"; return 1 ;; esac
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "  Error: unsupported arch $arch"; return 1 ;;
  esac
  asset="aft-${os}-${arch}"
  # /releases/latest/download/ is GitHub's redirect-to-latest-tag pattern.
  # For a specific known version we hit /releases/download/vVERSION/ directly.
  if [[ "$expected_version" == "latest" ]]; then
    url="https://github.com/${AFT_RELEASE_REPO}/releases/latest/download/${asset}"
    checksums_url="https://github.com/${AFT_RELEASE_REPO}/releases/latest/download/checksums.sha256"
  else
    url="https://github.com/${AFT_RELEASE_REPO}/releases/download/v${expected_version}/${asset}"
    checksums_url="https://github.com/${AFT_RELEASE_REPO}/releases/download/v${expected_version}/checksums.sha256"
  fi

  echo "  Downloading ${asset} v${expected_version}..."
  local tmpdir; tmpdir=$(mktemp -d)
  # Defense-in-depth timeouts: --connect-timeout 10 caps the TCP/HANDSHAKE
  # phase (fast fail on unreachable hosts); --max-time 120 caps the whole
  # transfer (prevents hung downloads). Without these, a flaky network can
  # hang the install indefinitely.
  if ! curl -fSL --progress-bar --connect-timeout 10 --max-time 120 -o "$tmpdir/$asset" "$url"; then
    echo "  Warning: AFT binary download failed (network/proxy)."
    echo "  AFT CLI will lazy-download on first tool use."
    echo "  To retry manually: npx @cortexkit/aft setup --harness pi --yes"
    rm -rf "$tmpdir"
    return 0   # soft-fail per design section 4.7
  fi

  # Checksum verification — hard fail on mismatch (don't install a
  # tampered binary), soft fail on fetch failure (don't block on infra
  # issues; the GitHub release itself was the trust boundary).
  if curl -fsSL --connect-timeout 10 --max-time 30 -o "$tmpdir/checksums.sha256" "$checksums_url" 2>/dev/null; then
    if ! (cd "$tmpdir" && sha256sum -c --ignore-missing < checksums.sha256 2>&1 | grep -q "${asset}: OK"); then
      echo "  ERROR: AFT binary checksum mismatch — possible tampering. Binary NOT installed."
      rm -rf "$tmpdir"
      return 1
    fi
  else
    echo "  Warning: could not fetch checksums.sha256; skipping verification (network/proxy issue, not a security failure)"
  fi

  mkdir -p "$AFT_BINARY_DIR"
  mv "$tmpdir/$asset" "$AFT_BINARY"
  chmod +x "$AFT_BINARY"
  rm -rf "$tmpdir"
  echo "  Installed AFT binary at $AFT_BINARY (v$expected_version)"
}

uninstall_aft_binary() {
  # Mirrors uninstall_codebase_memory_mcp_binary. We treat
  # $HOME/.local/bin/aft as sages-owned; same convention as
  # codebase-memory-mcp. Users with an independent `aft` install on
  # PATH can resolve manually (rare).
  if [[ -f "$AFT_BINARY" ]]; then
    rm -f "$AFT_BINARY"
    echo "  Removed $AFT_BINARY"
  fi
  echo "  AFT binary uninstalled"
}

# ────────────────────────────────────────────────────────────
# Mode 1: full install (default)
# ────────────────────────────────────────────────────────────

# ────────────────────────────────────────────────────────────
# Mode 1: full install (default)
# ────────────────────────────────────────────────────────────
install() {
  echo "==> Installing pi-orchestrator + pi-codebase-memory + pi-mcp-adapter + pi-subagents + pi-evaluator + pi-tasks + 4-agent subagent pipeline..."

  # Pre-flight checks
  install_pi_if_needed

  # Verify pi is available
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi

  # ── Install sage-peer file-copy packages FIRST. ────────────────────────
  #
  # pi-orchestrator/package.json declares
  #   "@sages/pi-subagents": "file:../pi-subagents"
  # and bun resolves `file:` paths relative to the cwd at install time.
  # install_orchestrator_files() runs `bun install` from
  # $PI_DIR/packages/pi-orchestrator/ — so $PI_DIR/packages/pi-subagents/
  # MUST exist (and carry its own package.json) before that bun install
  # runs. Same logic for pi-evaluator and pi-codebase-memory, which
  # setup_orchestrator_peer_symlinks later exposes under
  # pi-orchestrator/node_modules/@sages/<peer>/.
  #
  # Bug this guards against (pre-fix form): install.sh ran
  # install_orchestrator_files first, then install_pi_subagents later.
  # bun walked up from file:../pi-subagents, found no package.json, and
  # aborted with:
  #   "Could not find package.json for file:../pi-subagents"
  # Commit d9e1785 made the failure propagate instead of being silently
  # swallowed — which surfaced this ordering bug loudly. The fix is to
  # land peer packages on disk first; install_orchestrator_files can
  # then resolve the file: dep, run `bun install` to completion, and
  # the reverse-direction symlinks (setup_orchestrator_peer_symlinks)
  # install on top of an already-correct node_modules/.
  #
  # Peer file-copy installs are independent of pi (the CLI), so we run
  # them before install_orchestrator_files and before the npm: peers
  # below. The is_*_installed guards keep each step idempotent —
  # already-installed peers short-circuit the file copy + bun install
  # and only the settings.json registration is no-op'd.

  # Install pi-subagents (sage peer, file-copied from $LOCAL_REPO_ROOT/pi-subagents).
  install_pi_subagents || exit 1

  # Install pi-evaluator (sage peer, file-copied from $LOCAL_REPO_ROOT/pi-evaluator).
  # Reward mode (eval_score / eval_trend) is OFF by default — opt in via
  # `sages.rewardMode: true` in ~/.pi/agent/settings.json after install.
  install_pi_evaluator || exit 1

  # Install pi-codebase-memory sage peer (file copy from $LOCAL_REPO_ROOT/pi-codebase-memory + settings.json register).
  # Old design had two steps (install_pi_codebase_memory + install_pi_codebase_memory_files); merged into one
  # after we dropped the npm:pi-codebase-memory (R-Dson) variant in favor of the local peer only.
  install_pi_codebase_memory || exit 1
  write_codebase_memory_mcp_config

  # Install pi-tasks sage peer (workflow engine for workflow_run).
  # GC-2026-install-pi-tasks: must land BEFORE install_orchestrator_files so
  # the orchestrator's `file:../pi-tasks` dep can resolve during bun install.
  install_pi_tasks || exit 1

  # Install codebase-memory-mcp binary (~50MB download from GitHub releases)
  install_codebase_memory_mcp_binary || {
    echo "  Note: codebase-memory-mcp binary install failed."
    echo "  Sage will work without it; MCP graph tools unavailable until manually installed."
    echo "  To retry: bash <(curl -fsSL https://raw.githubusercontent.com/${CBM_REPO}/main/install.sh)"
  }

  # Install pi-orchestrator (sources files from $LOCAL_REPO_ROOT/pi-orchestrator/).
  # GC-2026-073: this replaces the historical `install_sages_files()` —
  # the conductor (./pi/) is gone, and the orchestrator is now the
  # entrypoint package. Runs AFTER the sage peers above so its
  # `file:../pi-subagents` dep can resolve during bun install.
  echo "==> Installing pi-orchestrator..."
  install_orchestrator_files || exit 1

  # GC-2026-remove-magic-context: pi-magic-context is no longer installed.
  # Run cleanup_legacy_magic_context instead, for users upgrading from
  # a pre-GC-2026-remove-magic-context install.
  cleanup_legacy_magic_context || true

  # Install pi-mcp-adapter (MCP server adapter)
  install_pi_mcp_adapter || true

  # Install AFT (@cortexkit/aft-pi) — GC-2026-096. Three soft-fail steps
  # so a flaky network never breaks the install. Order: config → npm peer
  # (so install_aft_binary can read the version from $AFT_NPM_DIR/package.json)
  # → binary.
  install_aft_config || true
  install_aft_pi_npm || true
  install_aft_binary || true

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

  # GC-2026-110 FU1b: consolidated post-install gates. Three gates catch
  # partial-failure states: (1) critical deps, (2) registered-package
  # existence, (3) extension load smoke test. Any one failing exits 1
  # with a clear recovery command. --no-smoke skips gate (3) only;
  # gates (1) and (2) still run (they're cheap and catch real bugs).
  if ! run_post_install_gates; then
    echo ""
    echo "Install completed but post-install verification failed."
    echo "Re-run with --force to repair: bash $0 --force"
    exit 1
  fi

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# Mode 2: update orchestrator only (skip pi-codebase-memory and SYSTEM.md)
# ────────────────────────────────────────────────────────────
install_orchestrator_only() {
  echo "==> Installing orchestrator only (skip pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator, pi-tasks, subagent templates, skip SYSTEM.md)..."

  # Pre-flight: pi is still required (orchestrator is a pi extension)
  install_pi_if_needed
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi

  # Install only the orchestrator files
  echo "==> Installing pi-orchestrator..."
  install_orchestrator_files || exit 1

  # Verify orchestrator critical deps + verify the peer packages
  # already on disk (installed by an earlier full install run) so a
  # partial --orchestrator-only re-run can't leave the peer chain
  # silently broken. The full-mode install_orchestrator_files call
  # above already verified the orchestrator's own deps; this
  # catch-all catches any peer whose node_modules got wiped since
  # the last install.
  verify_all_critical_install_deps || {
    echo ""
    echo "Install completed but critical deps verification failed."
    echo "Re-run the full install to repair: bash $0 --force"
    exit 1
  }

  # Explicitly do NOT call install_pi_codebase_memory / install_pi_mcp_adapter / install_pi_subagents / install_pi_evaluator / install_system_prompt
  echo "  (skipped: pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator, subagent templates, SYSTEM.md)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# Mode 3: update SYSTEM.md only (skip orchestrator and pi-codebase-memory)
# ────────────────────────────────────────────────────────────
install_system_only() {
  echo "==> Installing SYSTEM.md only (skip orchestrator, pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator, pi-tasks, subagent templates)..."
  # No git / pi needed — SYSTEM.md is standalone markdown
  install_system_prompt
  echo "  (skipped: orchestrator, pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator, pi-tasks, subagent templates)"

  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# Mode 4: sync-only — file-copy pi-orchestrator + pi-tasks sources
# into $PKG_DIR without re-running bun install / npm peer setup /
# SYSTEM.md / pi CLI / pi-codebase-memory. The fast path for
# testing a local commit on a fully-installed runtime.
#
# GC-2026-pi-tasks-cascade-agentid postmortem flagged this follow-up;
# GC-2026-boundary-subagent-control reiterated it. Before this GC, the
# only way to ship a one-commit source fix to the runtime pi session
# was `--force` (full reinstall, including 90s+ bun install + AFT
# binary download). --sync-only skips all of that and force-overwrites
# just the source files, since the dependencies have not changed in
# a fix-only commit.
#
# What it does:
#   - copies pi-orchestrator/{src,skills,templates}/ + package.json
#   - copies pi-tasks/{src,test,skills}/  (no node_modules — assumes
#     the runtime already has pi-tasks's deps installed)
#   - does NOT touch: pi CLI, AFT binary / npm peer, SYSTEM.md,
#     pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator,
#     subagent templates, settings.json registration
#
# What it does NOT do (must already be installed):
#   - peer chain must be intact (pi-subagents, pi-tasks, pi-evaluator
#     already present at $PI_DIR/packages/ from a prior full install)
#   - bun / node_modules for each package must be populated
#
# Failure modes:
#   - If a peer package is missing, sync-only prints a clear recovery
#     path ("run the full install first") and exits 1 instead of
#     silently shipping a broken runtime.
# ────────────────────────────────────────────────────────────
install_sync_only() {
  echo "==> Syncing pi-orchestrator + pi-tasks source files only (no bun install, no peer setup)..."

  # Pre-flight: the runtime must already be installed. sync-only is
  # the fast path on top of a complete install, not a fresh installer.
  if [[ ! -d "$PKG_DIR" ]]; then
    echo "  Error: $PKG_DIR does not exist; sync-only needs a prior full install"
    echo "  Run: bash $0  (full install) first, then re-run with --sync-only"
    exit 1
  fi
  if [[ ! -d "$PI_TASKS_DEST_DIR" ]]; then
    echo "  Error: $PI_TASKS_DEST_DIR does not exist; sync-only needs pi-tasks installed"
    echo "  Run: bash $0  (full install) first, then re-run with --sync-only"
    exit 1
  fi

  # Force-copy orchestrator source directories (no SKIP-if-exists
  # check; sync-only is intentionally force-overwriting).
  local orch_src="$LOCAL_REPO_ROOT/pi-orchestrator"
  if [[ ! -d "$orch_src" ]]; then
    echo "  Error: pi-orchestrator source tree not found at $orch_src"
    exit 1
  fi
  for dir in skills src templates; do
    local src_dir="$orch_src/$dir"
    [[ ! -d "$src_dir" ]] && continue
    rm -rf "$PKG_DIR/$dir"
    cp -r "$src_dir" "$PKG_DIR/$dir"
    echo "  Synced $dir/"
  done
  if [[ -f "$orch_src/package.json" ]]; then
    cp "$orch_src/package.json" "$PKG_DIR/package.json"
    echo "  Synced package.json (deps preserved; bun install NOT re-run)"
  fi

  # Force-copy pi-tasks source directories (no node_modules — the
  # runtime's existing pi-tasks installation has the deps; if a
  # commit adds a new dep, full reinstall is required).
  local tasks_src="$LOCAL_REPO_ROOT/$PI_TASKS_SRC_REL"
  if [[ ! -d "$tasks_src" ]]; then
    echo "  Warning: $tasks_src not found, skipping pi-tasks sync"
  else
    rm -rf "$PI_TASKS_DEST_DIR/src" "$PI_TASKS_DEST_DIR/test" "$PI_TASKS_DEST_DIR/skills"
    cp -r "$tasks_src/src" "$PI_TASKS_DEST_DIR/src"
    cp -r "$tasks_src/test" "$PI_TASKS_DEST_DIR/test"
    [[ -d "$tasks_src/skills" ]] && cp -r "$tasks_src/skills" "$PI_TASKS_DEST_DIR/skills"
    echo "  Synced pi-tasks src/ + test/ + skills/ (deps preserved)"
  fi

  echo "  (skipped: pi CLI, AFT peer + binary, SYSTEM.md, pi-codebase-memory, pi-mcp-adapter, pi-subagents, pi-evaluator, settings.json registration, bun install)"
  echo ""
  echo "Done! Restart pi: exit && pi"
}

# ────────────────────────────────────────────────────────────
# Uninstall (removes both orchestrator and pi-codebase-memory)
# ────────────────────────────────────────────────────────────
uninstall() {
  echo "==> Uninstalling pi-orchestrator + pi-codebase-memory + pi-mcp-adapter + pi-subagents + pi-evaluator + pi-tasks + 4-agent subagent pipeline..."

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


  # GC-2026-remove-magic-context: legacy magic-context cleanup runs as part of uninstall
  cleanup_legacy_magic_context

  # Uninstall pi-mcp-adapter (MCP server adapter)
  uninstall_pi_mcp_adapter

  # Uninstall AFT (@cortexkit/aft-pi) — GC-2026-096. Reverse order from
  # install: config → npm peer → binary.
  uninstall_aft_config || true
  uninstall_aft_pi_npm || true
  uninstall_aft_binary || true



  # Uninstall pi-subagents (subagent extension)
  uninstall_pi_subagents

  # Uninstall pi-evaluator (reward-mode extension)
  uninstall_pi_evaluator

  # Uninstall pi-tasks (workflow engine) — GC-2026-install-pi-tasks
  uninstall_pi_tasks

  # Uninstall agent-tool-description.md override + subagents.json setting.
  uninstall_agent_tool_description
  uninstall_subagents_config

  echo ""
  echo "Done. Restart pi: exit && pi"
}

main() {
  local FORCE=false UNINSTALL=false ORCHESTRATOR_ONLY=false SYSTEM_ONLY=false SYNC_ONLY=false
  local SMOKE=true
  local MODE_COUNT=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix)
        PI_DIR="$2"
        PKG_DIR="$PI_DIR/packages/$PKG_NAME"
        # PI_TASKS_DEST_DIR is computed at script entry from the initial
        # PI_DIR; --prefix has to keep both in lockstep so --sync-only
        # writes to the same prefix the rest of the script targets.
        PI_TASKS_DEST_DIR="$PI_DIR/packages/pi-tasks"
        PI_TASKS_PKG="$PI_TASKS_DEST_DIR"
        shift 2
        ;;
      --force) FORCE=true; shift ;;
      --uninstall) UNINSTALL=true; MODE_COUNT=$((MODE_COUNT+1)); shift ;;
      --orchestrator-only) ORCHESTRATOR_ONLY=true; MODE_COUNT=$((MODE_COUNT+1)); shift ;;
      --system-only) SYSTEM_ONLY=true; MODE_COUNT=$((MODE_COUNT+1)); shift ;;
      --sync-only) SYNC_ONLY=true; MODE_COUNT=$((MODE_COUNT+1)); shift ;;
      --no-smoke) SMOKE=false; shift ;;
      --help|-h) usage; exit 0 ;;
      *) echo "Error: Unknown option: $1"; usage; exit 1 ;;
    esac
  done

  # Mutual-exclusion check: only one mode may be selected at a time
  if [[ "$MODE_COUNT" -gt 1 ]]; then
    echo "Error: --uninstall, --orchestrator-only, --system-only, --sync-only are mutually exclusive"
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
  elif $SYNC_ONLY; then
    install_sync_only
  else
    install
  fi
}


main "$@"
