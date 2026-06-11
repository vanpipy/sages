#!/usr/bin/env bash
#
# ~/Project/sages/pi-yunxiao/scripts/install.sh
#
# Deploy pi-yunxiao from source to runtime (~/.pi/packages/yunxiao)
# Mirrors sages/install.sh pattern: selective cp -r + settings.json registration
#
# Usage:
#   ./scripts/install.sh              # incremental (skip existing)
#   ./scripts/install.sh --force      # overwrite
#   ./scripts/install.sh --uninstall  # remove
#   ./scripts/install.sh --prefix DIR # custom pi dir
set -euo pipefail

PI_DIR="${PI_DIR:-$HOME/.pi}"
PKG_NAME="yunxiao"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$PI_DIR/packages/$PKG_NAME"
AGENT_DIR="$PI_DIR/agent"
SETTINGS="$AGENT_DIR/settings.json"

# Decision C: scripts NOT copied to runtime
RUNTIME_DIRS=(prompts skills extensions src)

FORCE=false
UNINSTALL=false

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --force            Overwrite existing files
  --uninstall        Remove installed files
  --prefix DIR       Set pi config dir (default: ~/.pi)
  --help, -h         Show this help
EOF
}

register_settings() {
  mkdir -p "$(dirname "$SETTINGS")"
  [[ -f "$SETTINGS" ]] || echo '{"packages": []}' > "$SETTINGS"
  python3 << PYEOF
import json
f, pkg = "$SETTINGS", "$PKG_DIR"
d = json.load(open(f))
pkgs = d.get("packages", [])
pkgs = [x for x in pkgs if x != pkg]
if pkg not in pkgs:
    pkgs.append(pkg)
d["packages"] = pkgs
json.dump(d, open(f, "w"), indent=2)
print(f"Registered {pkg} in settings.json")
PYEOF
}

unregister_settings() {
  [[ -f "$SETTINGS" ]] || return 0
  python3 << PYEOF
import json
f, pkg = "$SETTINGS", "$PKG_DIR"
try:
    d = json.load(open(f))
    pkgs = [x for x in d.get("packages", []) if x != pkg]
    d["packages"] = pkgs
    json.dump(d, open(f, "w"), indent=2)
    print(f"Unregistered {pkg}")
except Exception as e:
    print(f"Warning: {e}", file=sys.stderr)
PYEOF
}

install() {
  echo "==> Installing $PKG_NAME from $SRC_DIR"
  mkdir -p "$PKG_DIR"

  for d in "${RUNTIME_DIRS[@]}"; do
    [[ -d "$SRC_DIR/$d" ]] || continue
    if [[ -d "$PKG_DIR/$d" && "$FORCE" != true ]]; then
      echo "  [skip] $d/ (use --force to overwrite)"
    else
      rm -rf "$PKG_DIR/$d"
      cp -r "$SRC_DIR/$d" "$PKG_DIR/"
      echo "  [copy] $d/"
    fi
  done

  [[ -f "$SRC_DIR/package.json" ]] && cp "$SRC_DIR/package.json" "$PKG_DIR/package.json" && echo "  [copy] package.json"
  [[ -f "$SRC_DIR/tsconfig.json" ]] && cp "$SRC_DIR/tsconfig.json" "$PKG_DIR/tsconfig.json" && echo "  [copy] tsconfig.json"

  register_settings
  echo ""
  echo "Done. Restart pi: exit && pi"
}

uninstall() {
  echo "==> Uninstalling $PKG_NAME"
  [[ -d "$PKG_DIR" ]] && rm -rf "$PKG_DIR" && echo "  [rm] $PKG_DIR"
  unregister_settings
  echo "Done."
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) FORCE=true; shift ;;
      --uninstall) UNINSTALL=true; shift ;;
      --prefix) PI_DIR="$2"; PKG_DIR="$PI_DIR/packages/$PKG_NAME"; AGENT_DIR="$PI_DIR/agent"; SETTINGS="$AGENT_DIR/settings.json"; shift 2 ;;
      --help|-h) usage; exit 0 ;;
      *) echo "Unknown: $1"; usage; exit 1 ;;
    esac
  done

  if $UNINSTALL; then
    uninstall
  else
    install
  fi
}

main "$@"
