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
PKG_DIR="$PI_DIR_PATH/packages/sages"

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

  if ! command -v pi &> /dev/null; then
    warn "pi command not found in PATH"
    warn "Please ensure pi coding agent is installed first"
    warn "See: https://pi.dev"
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
  PKG_DIR="$PI_DIR_PATH/packages/sages"
}

check_installation() {
  local pkg_dir="$PKG_DIR"

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

  info "Building package..."
  cd "$pi_dir"
  bun install
  bun run build

  success "Package built"
}

install_package() {
  local pi_dir="$TEMP_DIR/sages/pi"
  local pkg_dest="$PKG_DIR"

  if [[ "$DRY_RUN" == true ]]; then
    info "Installing package..."
    echo "  rm -rf $pkg_dest"
    echo "  cp -r $pi_dir $pkg_dest"
    return
  fi

  info "Installing package..."
  
  # Remove old installation
  if [[ -d "$pkg_dest" ]]; then
    rm -rf "$pkg_dest"
  fi
  
  # Copy to persistent location
  cp -r "$pi_dir" "$pkg_dest"
  
  # Disable cleanup so temp dir persists
  disable_cleanup
  
  success "Package installed to: $pkg_dest"
}

show_installation_info() {
  echo ""
  echo "========================================"
  success "Four Sages installed successfully!"
  echo "========================================"
  echo ""
  echo "Package: @sages/pi-four-sages"
  echo "Location: $PKG_DIR"
  echo ""
  echo "Commands available:"
  echo "  /fuxi <request>       Start workflow"
  echo "  /fuxi-approve         Approve current phase"
  echo "  /fuxi-reject          Reject and stop"
  echo "  /fuxi-status          View status"
  echo "  /fuxi-execute         Execute tasks"
  echo "  /fuxi-archive         Archive workflow"
  echo "  /fuxi-archives        List archives"
  echo "  /fuxi-restore         Restore archive"
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

uninstall_package() {
  info "Uninstalling Four Sages..."

  local pkg_paths=(
    "$PKG_DIR"
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

  if [[ "$DRY_RUN" == false ]]; then
    show_installation_info
  fi
}

main "$@"
