#!/usr/bin/env bash
#
# Four Sages Installation Script
# ================================
# Installs the Four Sages workflow for pi coding agent
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
#   curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash -s -- --help
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
VERSION="main"
REPO_URL="https://github.com/vanpipy/sages.git"
PI_DIR_PATH=""
SAGES_PKG_DIR=""

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
  echo "  --version REF   Git ref to install (default: main)"
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

  local missing=()
  for cmd in git bun; do
    if ! command -v "$cmd" &> /dev/null; then
      missing+=("$cmd")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Missing required commands: ${missing[*]}"
  fi

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
      --version)
        VERSION="$2"
        shift 2
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
  SAGES_PKG_DIR="${PI_DIR_PATH}/packages/sages"
}

check_installation() {
  local pkg_dir="$SAGES_PKG_DIR"

  if [[ -d "$pkg_dir" ]]; then
    if [[ "$FORCE" == true ]]; then
      warn "Overwriting existing installation..."
    else
      info "Four Sages appears to be installed at: $pkg_dir"
      echo ""
      echo "Use --force to overwrite or --uninstall to remove"
      exit 0
    fi
  fi
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}

disable_cleanup() {
  # Disable cleanup trap so temp dir persists (for manual inspection)
  trap - EXIT
  info "Temp directory kept at: $TEMP_DIR"
}

create_temp_dir() {
  info "Creating temporary directory..."
  TEMP_DIR=$(mktemp -d)
  trap cleanup EXIT
  success "Temporary directory: $TEMP_DIR"
}

clone_repo() {
  info "Cloning repository (version: $VERSION)..."

  if [[ "$DRY_RUN" == true ]]; then
    echo "  git clone --depth 1 --branch $VERSION $REPO_URL $TEMP_DIR/sages"
    return
  fi

  git clone --depth 1 --branch "$VERSION" "$REPO_URL" "$TEMP_DIR/sages"
  success "Repository cloned"
}

build_package() {
  local pi_dir="$TEMP_DIR/sages/pi"

  if [[ "$DRY_RUN" == true ]]; then
    info "Building package..."
    if [[ -d "$pi_dir" ]]; then
      echo "  cd $pi_dir"
      echo "  bun install"
      echo "  bun run build"
    else
      echo "  (pi directory will be at $pi_dir after clone)"
    fi
    success "Package built (dry-run)"
    return
  fi

  if [[ ! -d "$pi_dir" ]]; then
    error "pi directory not found in repository"
  fi

  # Check if already built (skip if dist exists)
  if [[ -d "$pi_dir/dist" && -f "$pi_dir/dist/index.js" ]]; then
    info "Package already built (skipping rebuild)"
  else
    info "Building package..."
    cd "$pi_dir"
    bun install
    bun run build
    success "Package built"
  fi
}

install_package() {
  local pi_dir="$TEMP_DIR/sages/pi"
  local pkg_dest="$SAGES_PKG_DIR"

  if [[ "$DRY_RUN" == true ]]; then
    info "Installing package..."
    echo "  mkdir -p $(dirname "$pkg_dest")"
    echo "  rm -rf $pkg_dest"
    echo "  mkdir -p $pkg_dest"
    echo "  cp $pi_dir/package.json $pkg_dest/"
    echo "  cp -r $pi_dir/dist $pkg_dest/"
    echo "  cp -r $pi_dir/extensions $pkg_dest/"
    echo "  cp -r $pi_dir/skills $pkg_dest/"
    echo "  cp -r $pi_dir/prompts $pkg_dest/"
    return
  fi

  info "Installing package..."
  
  # Ensure parent directory exists (idempotent)
  mkdir -p "$(dirname "$pkg_dest")"
  
  # Remove old installation
  rm -rf "$pkg_dest"
  
  # Create package directory
  mkdir -p "$pkg_dest"
  
  # Copy only necessary files (selective install)
  # - package.json: package metadata
  # - dist/: built JavaScript
  # - extensions/: pi extensions (TypeScript)
  # - skills/: skill definitions (MD)
  # - prompts/: workflow prompts
  cp "$pi_dir/package.json" "$pkg_dest/"
  cp -r "$pi_dir/dist" "$pkg_dest/"
  cp -r "$pi_dir/extensions" "$pkg_dest/"
  cp -r "$pi_dir/skills" "$pkg_dest/"
  cp -r "$pi_dir/prompts" "$pkg_dest/"
  
  # Disable cleanup so temp dir persists
  disable_cleanup
  
  success "Package installed to: $pkg_dest"
}

register_package_in_settings() {
  local pkg_dest="$SAGES_PKG_DIR"
  local settings_file="${PI_DIR_PATH}/agent/settings.json"
  
  if [[ ! -f "$settings_file" ]]; then
    warn "Settings file not found at $settings_file, skipping package registration"
    return
  fi

  info "Registering package in settings.json..."
  
  # Use Python for reliable JSON manipulation
  if ! command -v python3 &> /dev/null; then
    error "python3 not found. Cannot modify settings.json"
  fi
  
  python3 - "$pkg_dest" "$settings_file" << 'PYTHON_EOF'
import sys
import json
import os

package_ref = sys.argv[1]
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

# Normalize path for comparison (handle ~ expansion)
home_dir = os.path.expanduser('~')
package_ref_normalized = package_ref.replace('~', home_dir)

# Check if package already exists
needs_adding = True
for pkg in settings['packages']:
    pkg_normalized = pkg.replace('~', home_dir)
    if pkg_normalized == package_ref_normalized:
        needs_adding = False
        break

if needs_adding:
    settings['packages'].append(package_ref)
    with open(settings_file, 'w') as f:
        json.dump(settings, f, indent=2)
        f.write('\n')
    print("Package registered in settings.json")
else:
    print("Package already registered in settings.json")
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
  echo "Package: @sages/pi-four-sages"
  echo "Location: $SAGES_PKG_DIR"
  echo ""
  echo "Commands:"
  echo ""
  echo "  FUXI (☰ Design):"
  echo "    fuxi-start          Start workflow"
  echo "    fuxi-request       Create requirement draft"
  echo "    fuxi-plan           Start plan (score > 80)"
  echo "    fuxi-recover        Recover workflow"
  echo "    fuxi-end            End and archive workflow"
  echo "    fuxi-get-status     Get workflow status"
  echo ""
  echo "  QIAOCHUI (☳ Review):"
  echo "    qiaochui-review     Review draft feasibility"
  echo "    qiaochui-decompose  Decompose into tasks"
  echo ""
  echo "  LUBAN (☴ Execute):"
  echo "    luban-execute-task  Execute single task (TDD)"
  echo "    luban-execute-all   Execute all tasks"
  echo "    luban-get-status    Get execution status"
  echo ""
  echo "  GAOYAO (☲ Audit):"
  echo "    gaoyao-review       Quality audit (Xie Zhi)"
  echo "    gaoyao-check-security Security scan"
  echo ""
  echo "Workflow Phases:"
  echo "  ☰ Design → ☳ Review → 📋 Plan → ☴ Execute → ☲ Audit"
  echo ""
  echo "Skills:"
  echo "  fuxi     - MDD System Design"
  echo "  qiaochui - Technical Review"
  echo "  luban    - TDD Implementation"
  echo "  gaoyao   - Quality Audit"
  echo ""
  echo "Restart pi to load the new package:"
  echo "  exit && pi"
  echo ""
}

unregister_package_from_settings() {
  local pkg_dest="$SAGES_PKG_DIR"
  local settings_file="${PI_DIR_PATH}/agent/settings.json"
  
  if [[ ! -f "$settings_file" ]]; then
    return
  fi

  info "Unregistering package from settings.json..."
  
  if ! command -v python3 &> /dev/null; then
    warn "python3 not found. Cannot modify settings.json"
    return
  fi
  
  python3 - "$pkg_dest" "$settings_file" << 'PYTHON_EOF'
import sys
import json
import os

package_ref = sys.argv[1]
settings_file = sys.argv[2]

try:
    with open(settings_file, 'r') as f:
        settings = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    print("ERROR: Failed to read/parse settings.json")
    sys.exit(1)

if 'packages' not in settings:
    print("No packages to unregister")
    sys.exit(0)

home_dir = os.path.expanduser('~')
package_ref_normalized = package_ref.replace('~', home_dir)

# Filter out the package
original_count = len(settings['packages'])
settings['packages'] = [
    pkg for pkg in settings['packages']
    if pkg.replace('~', home_dir) != package_ref_normalized
]

if len(settings['packages']) < original_count:
    with open(settings_file, 'w') as f:
        json.dump(settings, f, indent=2)
        f.write('\n')
    print("Package unregistered from settings.json")
else:
    print("Package not found in settings.json")
PYTHON_EOF
}

uninstall_package() {
  info "Uninstalling Four Sages..."

  local pkg_paths=(
    "$SAGES_PKG_DIR"
    "$PI_DIR_PATH/agent/npm/@sages"
    "$PI_DIR_PATH/agent/npm/sages"
  )

  if [[ "$DRY_RUN" == true ]]; then
    echo "  rm -rf ${pkg_paths[*]}"
    return
  fi

  for path in "${pkg_paths[@]}"; do
    if [[ -d "$path" ]]; then
      rm -rf "$path"
      success "Removed: $path"
    fi
  done

  # Unregister from settings.json
  unregister_package_from_settings

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
    uninstall_package
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
  create_temp_dir
  clone_repo
  build_package
  install_package
  register_package_in_settings

  if [[ "$DRY_RUN" == false ]]; then
    show_installation_info
  fi
}

main "$@"