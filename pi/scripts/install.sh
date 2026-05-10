#!/usr/bin/env bash
#
# Four Sages Installation Script for pi
# =====================================
# Installs the Four Sages workflow for pi coding agent
# No build step required - pi loads TypeScript directly
#
# Usage:
#   ./install.sh [--prefix PATH] [--force] [--uninstall]
#
# Options:
#   --prefix PATH   Set pi config directory (default: ~/.pi)
#   --force         Overwrite existing installation
#   --uninstall     Remove installed files
#   --dry-run       Preview without making changes
#   --help          Show this help message
#
# Online Install:
#   curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
PREFIX="${PI_DIR:-$HOME/.pi}"
FORCE=false
DRY_RUN=false
UNINSTALL=false
REPO_URL="https://github.com/vanpipy/sages.git"
PI_DIR_PATH=""
EXT_DEST=""

# Functions
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

show_help() {
  echo "Usage: $0 [options]"
  echo ""
  echo "Options:"
  echo "  --prefix PATH   Set pi config directory (default: ~/.pi)"
  echo "  --force         Overwrite existing installation"
  echo "  --uninstall     Remove installed files"
  echo "  --dry-run       Preview without making changes"
  echo "  --help          Show this help message"
  echo ""
  echo "Examples:"
  echo "  $0                    # Install with defaults"
  echo "  $0 --prefix /custom   # Install to custom directory"
  echo "  $0 --force            # Overwrite existing"
  echo "  $0 --uninstall        # Remove installation"
  echo ""
  echo "Online Install:"
  echo "  curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | sh"
}

check_dependencies() {
  info "Checking dependencies..."

  if ! command -v pi &> /dev/null || [[ ! -d "$HOME/.pi" ]]; then
    error "pi coding agent is not installed."
    echo ""
    echo "Please install pi first:"
    echo "  curl -fsSL https://pi.dev/install.sh | sh"
    echo ""
    echo "Then run this installation script again."
  fi

  success "Dependencies OK"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --prefix)
        PREFIX="$2"
        shift 2
        ;;
      --force)
        FORCE=true
        shift
        ;;
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --uninstall)
        UNINSTALL=true
        shift
        ;;
      --help)
        show_help
        exit 0
        ;;
      -*)
        error "Unknown option: $1"
        ;;
      *)
        error "Unknown argument: $1"
        ;;
    esac
  done

  PI_DIR_PATH="$(eval echo "$PREFIX")"
  PI_DIR_PATH="$(cd "$PI_DIR_PATH" 2>/dev/null && pwd)" || true
  EXT_DEST="${PI_DIR_PATH}/agent/extensions/sages"
}

check_installation() {
  if [[ -d "$EXT_DEST" ]]; then
    if [[ "$FORCE" == true ]]; then
      warn "Overwriting existing installation..."
    else
      info "Four Sages appears to be installed at: $EXT_DEST"
      echo ""
      echo "Use --force to overwrite or --uninstall to remove"
      exit 0
    fi
  fi
}

install() {
  local src_dir="$1"

  if [[ "$DRY_RUN" == true ]]; then
    info "Installing to: $EXT_DEST"
    echo "  mkdir -p $EXT_DEST"
    echo "  cp -r $src_dir/src/extensions/sages-extension.ts $EXT_DEST/"
    echo "  cp -r $src_dir/src/tools $EXT_DEST/"
    echo "  cp -r $src_dir/src/state $EXT_DEST/"
    echo "  cp -r $src_dir/src/executor $EXT_DEST/"
    echo "  cp -r $src_dir/src/orchestrator $EXT_DEST/"
    echo "  cp -r $src_dir/src/utils $EXT_DEST/"
    echo "  cp -r $src_dir/src/index.ts $EXT_DEST/"
    echo "  cp -r $src_dir/skills $EXT_DEST/"
    echo "  cp -r $src_dir/prompts $EXT_DEST/"
    return
  fi

  info "Installing to: $EXT_DEST"
  mkdir -p "$EXT_DEST"

  # Copy extension and source files (TypeScript - no build needed for pi)
  # All files are placed directly under extensions/sages/
  cp "$src_dir/src/extensions/sages-extension.ts" "$EXT_DEST/"
  cp -r "$src_dir/src/tools" "$EXT_DEST/"
  cp -r "$src_dir/src/state" "$EXT_DEST/"
  cp -r "$src_dir/src/executor" "$EXT_DEST/"
  cp -r "$src_dir/src/orchestrator" "$EXT_DEST/"
  cp -r "$src_dir/src/utils" "$EXT_DEST/"
  cp "$src_dir/src/index.ts" "$EXT_DEST/"

  # Copy skills and prompts for discovery
  cp -r "$src_dir/skills" "$EXT_DEST/"
  cp -r "$src_dir/prompts" "$EXT_DEST/"

  success "Extension installed"
}

register_in_settings() {
  local settings_file="${PI_DIR_PATH}/agent/settings.json"

  if [[ "$DRY_RUN" == true ]]; then
    info "Registering in settings.json..."
    echo "  python3 update_settings"
    return
  fi

  if ! command -v python3 &> /dev/null; then
    warn "python3 not found. Cannot register in settings.json"
    return
  fi

  python3 - "$EXT_DEST" "$settings_file" << 'PYTHON_EOF'
import sys
import json
import os

ext_path = sys.argv[1]
settings_file = sys.argv[2]

try:
    with open(settings_file, 'r') as f:
        settings = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    print("ERROR: Failed to read/parse settings.json")
    sys.exit(1)

# Initialize packages array if it doesn't exist
if 'packages' not in settings:
    settings['packages'] = []

# Normalize path for comparison
home_dir = os.path.expanduser('~')
ext_normalized = os.path.normpath(ext_path.replace('~', home_dir))

# Filter out any existing sages entries (deduplicate)
filtered = []
for pkg in settings['packages']:
    pkg_normalized = os.path.normpath(pkg.replace('~', home_dir))
    if 'sages' not in pkg_normalized:
        filtered.append(pkg)
settings['packages'] = filtered

# Add the extension path
settings['packages'].append(ext_path)

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print("Registered in settings.json")
PYTHON_EOF

  if [[ $? -eq 0 ]]; then
    success "Package registration complete"
  fi
}

show_installation_info() {
  echo ""
  echo "========================================"
  success "Four Sages installed successfully!"
  echo "========================================"
  echo ""
  echo "Location: $EXT_DEST"
  echo ""
  echo "Commands:"
  echo ""
  echo "  FUXI (Design):"
  echo "    /fuxi-start          Start workflow"
  echo "    /fuxi-request       Create requirement draft"
  echo "    /fuxi-plan           Start plan (score > 80)"
  echo "    /fuxi-recover        Recover workflow"
  echo "    /fuxi-end            End and archive workflow"
  echo "    /fuxi-get-status     Get workflow status"
  echo ""
  echo "  QIAOCHUI (Review):"
  echo "    /qiaochui-review     Review draft feasibility"
  echo "    /qiaochui-decompose  Decompose into tasks"
  echo ""
  echo "  LUBAN (Execute):"
  echo "    /luban-execute-task  Execute single task (TDD)"
  echo "    /luban-execute-all   Execute all tasks"
  echo "    /luban-get-status    Get execution status"
  echo ""
  echo "  GAOYAO (Audit):"
  echo "    /gaoyao-review       Quality audit (Xie Zhi)"
  echo "    /gaoyao-check-security Security scan"
  echo ""
  echo "Restart pi to load the extension:"
  echo "  exit && pi"
  echo ""
}

uninstall() {
  info "Uninstalling Four Sages..."

  if [[ "$DRY_RUN" == true ]]; then
    echo "  rm -rf $EXT_DEST"
    echo "  python3 unregister"
    return
  fi

  # Remove extension directory
  if [[ -d "$EXT_DEST" ]]; then
    rm -rf "$EXT_DEST"
    success "Removed: $EXT_DEST"
  fi

  # Unregister from settings.json
  if command -v python3 &> /dev/null; then
    python3 - "$EXT_DEST" "${PI_DIR_PATH}/agent/settings.json" << 'PYTHON_EOF'
import sys
import json
import os

try:
    settings_file = sys.argv[1]
    with open(settings_file, 'r') as f:
        settings = json.load(f)
except:
    sys.exit(0)

if 'packages' not in settings:
    sys.exit(0)

settings['packages'] = [
    pkg for pkg in settings['packages']
    if 'sages' not in pkg
]

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
print("Unregistered from settings.json")
PYTHON_EOF
  fi

  success "Uninstallation complete"
}

main() {
  echo ""
  echo "========================================"
  echo "  Four Sages Installation Script"
  echo "========================================"
  echo ""

  parse_args "$@"

  if [[ "$UNINSTALL" == true ]]; then
    check_dependencies
    uninstall
    exit 0
  fi

  if [[ "$DRY_RUN" == true ]]; then
    info "DRY RUN MODE - No changes will be made"
  fi

  check_dependencies

  if [[ -n "$PI_DIR_PATH" ]]; then
    info "Install prefix: $PI_DIR_PATH"
  fi

  check_installation

  # Determine source directory
  # If running from repo: ./pi/scripts/install.sh -> ../../ (sages root)
  local script_dir="$(cd "$(dirname "$0")" && pwd)"
  local repo_root="$(dirname "$script_dir")"
  local src_dir="$repo_root"

  # If src/extensions doesn't exist, assume we're in the pi subdirectory
  if [[ ! -d "$src_dir/src/extensions" ]]; then
    src_dir="$repo_root/pi"
  fi

  if [[ ! -d "$src_dir/src/extensions" ]]; then
    error "Cannot find extension source in $src_dir"
  fi

  install "$src_dir"
  register_in_settings

  if [[ "$DRY_RUN" == false ]]; then
    show_installation_info
  fi
}

main "$@"
