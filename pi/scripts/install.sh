#!/usr/bin/env bash
#
# Four Sages Installation Script for pi
# Installs to ~/.pi/packages/sages
#

set -euo pipefail

PI_DIR="${PI_DIR:-$HOME/.pi}"

# Source directory (script's parent or parent's parent)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"
[[ ! -d "$SRC_DIR/src" ]] && SRC_DIR="$SCRIPT_DIR/pi"
[[ ! -d "$SRC_DIR/src" ]] && { echo "Error: Cannot find source"; exit 1; }

usage() {
  echo "Usage: $0 [--prefix DIR] [--force] [--uninstall]"
  echo "  --prefix DIR   Set pi config dir (default: ~/.pi)"
  echo "  --force        Overwrite existing files"
  echo "  --uninstall    Remove installed files"
}

register_settings() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return

  python3 -c "
import json, sys
f, p = '$settings', '$PKG_DIR'
d = json.load(open(f))
d['packages'] = [x for x in d.get('packages', []) if 'sages' not in x] + [p]
json.dump(d, open(f, 'w'), indent=2)
print('Registered', p)
"
}

install() {
  echo "Installing to $PKG_DIR"
  mkdir -p "$PKG_DIR"
  for dir in prompts skills extensions src; do
    [[ -d "$SRC_DIR/$dir" ]] || continue
    if [[ -d "$PKG_DIR/$dir" && "${FORCE:-false}" != true ]]; then
      echo "  Skipping $dir (exists)"
    else
      cp -r${FORCE:+f} "$SRC_DIR/$dir" "$PKG_DIR/"
      echo "  Copied $dir/"
    fi
  done
  register_settings
  echo "Done. Restart pi: exit && pi"
}

uninstall() {
  echo "Uninstalling..."
  [[ -d "$PKG_DIR" ]] && rm -rf "$PKG_DIR" && echo "  Removed $PKG_DIR"
  register_settings
  echo "Done."
}

main() {
  FORCE=false
  UNINSTALL=false
  PKG_NAME="sages"
  PKG_DIR="$PI_DIR/packages/$PKG_NAME"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix) PI_DIR="$2"; PKG_DIR="$PI_DIR/packages/$PKG_NAME"; shift 2 ;;
      --force) FORCE=true; shift ;;
      --uninstall) UNINSTALL=true; shift ;;
      --help|-h) usage; exit 0 ;;
      *) echo "Unknown: $1"; usage; exit 1 ;;
    esac
  done

  [[ ! -d "$PI_DIR" ]] && { echo "Error: $PI_DIR not found"; exit 1; }

  $UNINSTALL && uninstall || install
}

main "$@"
