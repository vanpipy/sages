#!/usr/bin/env bash
#
# Four Sages Installation Script for pi
# =====================================
# Installs to ~/.pi (copies extensions/, prompts/, skills/, src/)
#
# Usage:
#   ./install.sh [--prefix PATH] [--force] [--uninstall]
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PREFIX="${PI_DIR:-$HOME/.pi}"
FORCE=false
DRY_RUN=false
UNINSTALL=false
PI_DIR_PATH=""

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

show_help() {
  echo "Usage: $0 [options]"
  echo "  --prefix PATH   Set pi config directory (default: ~/.pi)"
  echo "  --force         Overwrite existing files"
  echo "  --uninstall     Remove installed files"
  echo "  --dry-run       Preview without making changes"
  echo "  --help          Show this help message"
}

check_dependencies() {
  info "Checking dependencies..."
  if ! command -v pi &> /dev/null || [[ ! -d "$HOME/.pi" ]]; then
    error "pi coding agent is not installed. Install from https://pi.dev/install.sh"
  fi
  success "Dependencies OK"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --prefix) PREFIX="$2"; shift 2 ;;
      --force) FORCE=true; shift ;;
      --dry-run) DRY_RUN=true; shift ;;
      --uninstall) UNINSTALL=true; shift ;;
      --help) show_help; exit 0 ;;
      -*) error "Unknown option: $1" ;;
      *) error "Unknown argument: $1" ;;
    esac
  done

  PI_DIR_PATH="$(eval echo "$PREFIX")"
  PI_DIR_PATH="$(cd "$PI_DIR_PATH" 2>/dev/null && pwd)" || true
}

install() {
  local src_dir="$1"

  if [[ "$DRY_RUN" == true ]]; then
    info "Installing to: $PI_DIR_PATH"
    for dir in extensions prompts skills src; do
      if [[ -d "$src_dir/$dir" ]]; then
        echo "  cp -r$([ "$FORCE" == true ] && echo "f") $src_dir/$dir $PI_DIR_PATH/"
      fi
    done
    return
  fi

  info "Installing to: $PI_DIR_PATH"

  for dir in extensions prompts skills src; do
    if [[ -d "$src_dir/$dir" ]]; then
      if [[ -d "$PI_DIR_PATH/$dir" && "$FORCE" != true ]]; then
        warn "Skipping $dir (exists). Use --force to overwrite"
      else
        cp -r$([ "$FORCE" == true ] && echo "f") "$src_dir/$dir" "$PI_DIR_PATH/"
        success "Copied $dir/"
      fi
    fi
  done

  success "Installed to $PI_DIR_PATH"
}

register_in_settings() {
  local settings_file="${PI_DIR_PATH}/agent/settings.json"

  if [[ "$DRY_RUN" == true ]]; then
    info "Registering in settings.json..."
    return
  fi

  if ! command -v python3 &> /dev/null; then
    warn "python3 not found. Skipping settings.json registration"
    return
  fi

  python3 - "$settings_file" << 'PYTHON_EOF'
import sys
import json
import os

settings_file = sys.argv[1]

try:
    with open(settings_file, 'r') as f:
        settings = json.load(f)
except:
    settings = {}

if 'packages' not in settings:
    settings['packages'] = []

settings['packages'] = [p for p in settings['packages'] if 'sages' not in p]

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
print("Updated settings.json")
PYTHON_EOF
}

show_info() {
  echo ""
  echo "========================================"
  success "Four Sages installed successfully!"
  echo "========================================"
  echo ""
  echo "Location: $PI_DIR_PATH/{extensions,prompts,skills,src}/"
  echo ""
  echo "Commands:"
  echo "  /fuxi-start, /fuxi-request, /fuxi-plan, /fuxi-recover, /fuxi-end, /fuxi-get-status"
  echo "  /qiaochui-review, /qiaochui-decompose"
  echo "  /luban-execute-task, /luban-execute-all, /luban-get-status"
  echo "  /gaoyao-review, /gaoyao-check-security"
  echo ""
  echo "Restart pi: exit && pi"
  echo ""
}

uninstall() {
  info "Uninstalling Four Sages..."

  if [[ "$DRY_RUN" == true ]]; then
    for dir in extensions prompts skills src; do
      echo "  rm -rf $PI_DIR_PATH/$dir"
    done
    return
  fi

  for dir in extensions prompts skills src; do
    [[ -d "$PI_DIR_PATH/$dir" ]] && rm -rf "$PI_DIR_PATH/$dir" && success "Removed: $dir/"
  done

  register_in_settings

  success "Uninstallation complete"
}

main() {
  echo ""
  echo "========================================"
  echo "  Four Sages Installation"
  echo "========================================"
  echo ""

  parse_args "$@"

  if [[ "$UNINSTALL" == true ]]; then
    check_dependencies
    uninstall
    exit 0
  fi

  [[ "$DRY_RUN" == true ]] && info "DRY RUN MODE"

  check_dependencies
  [[ -n "$PI_DIR_PATH" ]] && info "Install prefix: $PI_DIR_PATH"

  # Determine source directory
  local script_dir="$(cd "$(dirname "$0")" && pwd)"
  local repo_root="$(dirname "$script_dir")"
  local src_dir="$repo_root"
  [[ ! -d "$src_dir/src" ]] && src_dir="$repo_root/pi"
  [[ ! -d "$src_dir/src" ]] && error "Cannot find source in $src_dir"

  install "$src_dir"
  register_in_settings

  [[ "$DRY_RUN" == false ]] && show_info
}

main "$@"
