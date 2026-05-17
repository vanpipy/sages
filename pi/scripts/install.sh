#!/usr/bin/env bash
#
# Four Sages Installation Script for pi
# Installs to ~/.pi/packages/sages
#
# Also installs pi-memory for persistent memory capabilities
#

set -euo pipefail

# Core paths
PI_DIR="${PI_DIR:-$HOME/.pi}"
PKG_NAME="sages"
PKG_DIR="$PI_DIR/packages/$PKG_NAME"
REPO_URL="https://github.com/vanpipy/sages.git"
AGENT_DIR="$PI_DIR/agent"

# pi-memory package info
PI_MEMORY_PKG="npm:@samfp/pi-memory"

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
  echo "  --help, -h         Show this help message"
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

is_pi_memory_installed() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return 1
  
  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    packages = d.get('packages', [])
    if '$PI_MEMORY_PKG' in packages or '@samfp/pi-memory' in packages:
        sys.exit(0)
    sys.exit(1)
except:
    sys.exit(1)
" 2>/dev/null
}

install_pi_memory() {
  echo "==> Installing pi-memory..."
  
  # Check if already installed
  if is_pi_memory_installed; then
    echo "  pi-memory already installed"
    return 0
  fi
  
  # Try using pi install command first
  if command -v pi &>/dev/null; then
    echo "  Installing via 'pi install $PI_MEMORY_PKG'..."
    if pi install "$PI_MEMORY_PKG"; then
      echo "  Installed pi-memory"
      return 0
    fi
    echo "  pi install failed, trying manual..."
  fi
  
  # Fallback: manually add to settings.json
  echo "  Adding to settings.json..."
  local settings="$PI_DIR/agent/settings.json"
  mkdir -p "$(dirname "$settings")"
  
  if [[ ! -f "$settings" ]]; then
    echo '{"packages": []}' > "$settings"
  fi
  
  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_MEMORY_PKG'
try:
    d = json.load(open(f))
except (json.JSONDecodeError, FileNotFoundError):
    d = {'packages': []}
if pkg not in d.get('packages', []):
    d['packages'] = d.get('packages', []) + [pkg]
json.dump(d, open(f, 'w'), indent=2)
print('  Added', pkg)
"
  
  echo "  Installed pi-memory"
}

uninstall_pi_memory() {
  echo "==> Uninstalling pi-memory..."
  
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && { echo "  No settings file"; return 0; }
  
  local removed=false
  python3 -c "
import json, sys
f, pkg = '$settings', '$PI_MEMORY_PKG'
try:
    d = json.load(open(f))
    pkgs = d.get('packages', [])
    # Remove exact match or @samfp/pi-memory variant
    new_pkgs = [x for x in pkgs if x != pkg and x != 'pi-memory' and x != '@samfp/pi-memory']
    if len(new_pkgs) < len(pkgs):
        d['packages'] = new_pkgs
        json.dump(d, open(f, 'w'), indent=2)
        print('Removed', pkg)
    else:
        print('Not found in settings')
except Exception as e:
    print('Warning:', e, file=sys.stderr)
    sys.exit(1)
"
  
  # Remove package directory if exists
  local memory_dir="$PI_DIR/packages/pi-memory"
  if [[ -d "$memory_dir" ]]; then
    rm -rf "$memory_dir"
    echo "  Removed $memory_dir"
  fi
  
  echo "  pi-memory uninstalled"
}

install_system_prompt() {
  mkdir -p "$AGENT_DIR"
  
  cat > "$AGENT_DIR/SYSTEM.md" << 'EOF'
# Role: DevSecOps & Polyglot Systems Engineer

You are a strategic expert specializing in AI-driven DevOps (The Command Center), Security & Penetration Testing (The Primary Capability), and Multi-language Engineering (The Supporting Capability).

## 1. Context Prioritization & Constitution (First Priority)
**At the START of EVERY session, before any implementation work:**

1. **Scan for and read these files IN ORDER:**
   - `.specify/memory/constitution.md` - project constitution
   - `.pi/SYSTEM.md` or `CLAUDE.md` - project-specific overrides
   - `AGENTS.md` - agent instructions
   - `SPEC.md` or `SPECIFY.md` - project specifications

2. **Local Dominance**: Project-specific rules in these files override global directives.

3. **Store in memory**: Use `memory_remember` to persist project-specific rules, conventions, and patterns for future sessions.

4. **Execution Gate**: Before taking action, verify the specific constraints of the current environment to ensure architectural consistency.

## 2. TDD Enforcement Hook (Protocol)
**Every implementation request MUST follow this strict sequence:**
1. **Red Stage**: Write the test case first. Define edge cases and expected failure.
2. **Verification Stage**: Execute or simulate the test to confirm failure.
3. **Green Stage**: Write the minimal code necessary to pass the test.
4. **Refactor Stage**: Optimize for readability and performance.
**VIOLATION BLOCKER**: You are strictly prohibited from providing implementation code without first providing the test.

## 3. The Core: AI-DevOps & Go
- **Command Logic**: Use Go for high-performance orchestration and TUI (TEA architecture) systems.
- **Architectural Integrity**: Favor composition over inheritance. Prioritize explicit error handling and "zero-value usable" code.
- **Minimalism**: Strictly avoid over-engineering and unnecessary abstractions.

## 4. Primary Power: Security & Python
- **Offensive Mindset**: Use Python for exploit development, automation, and deep security auditing.
- **Threat Awareness**: Perform continuous threat modeling (Injection, Race Conditions, Access Control) by default.
- **Audit Standard**: Provide Technical Principle, PoC Path, and Remediation Code for all findings.

## 5. Supporting Power: Software Engineering
- **Java**: Provide type-safe backend support. Maintain clean code without framework bloat.
- **Node.js**: Handle event-driven tasks focusing on asynchronous safety and memory efficiency.
- **Context Switching**: Respect the unique philosophy of each language; do not leak design patterns across ecosystems.

## 6. Universal Protocol
- **Version Control**: Mandatory adherence to Conventional Commits.
- **Automation First**: Think in terms of Unix-pipe philosophy and state persistence.
- **Communication**: Be direct and technical. Use Markdown tables or Mermaid flowcharts for complex logic.
- **Compliance**: All activities must follow ethical guidelines within authorized scopes.
EOF
  
  echo "  Installed SYSTEM.md"
}

get_settings_packages() {
  local settings="$PI_DIR/agent/settings.json"
  python3 -c "
import json, sys
try:
    d = json.load(open('$settings'))
    print(json.dumps(d.get('packages', [])))
except:
    print('[]')
" 2>/dev/null
}

is_sages_installed() {
  [[ -d "$PKG_DIR" && -f "$PKG_DIR/package.json" ]]
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

install() {
  echo "==> Installing sages + pi-memory..."
  
  # Pre-flight checks
  check_git
  install_pi_if_needed
  
  # Verify pi is available
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not found after installation"
    exit 1
  fi
  
  # Install pi-memory first
  install_pi_memory
  
  # Clone sages
  echo "==> Installing sages..."
  TMP_DIR=$(mktemp -d)
  echo "  Cloning from $REPO_URL..."
  git clone "$REPO_URL" "$TMP_DIR" || {
    echo "Error: Failed to clone sages repository"
    exit 1
  }
  
  # Install sages
  mkdir -p "$PKG_DIR"
  for dir in prompts skills extensions src; do
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
  
  # Register in settings
  register_settings
  
  # Install system prompt
  if [[ ! -f "$AGENT_DIR/SYSTEM.md" || "${FORCE:-false}" == true ]]; then
    install_system_prompt
  fi
  
  echo ""
  echo "Done! Restart pi: exit && pi"
}

uninstall() {
  echo "==> Uninstalling sages + pi-memory..."
  
  # Remove sages
  if [[ -d "$PKG_DIR" ]]; then
    rm -rf "$PKG_DIR"
    echo "  Removed sages"
  fi
  
  # Unregister sages
  unregister_settings
  
  # Uninstall pi-memory
  uninstall_pi_memory
  
  echo ""
  echo "Done. Restart pi: exit && pi"
}

main() {
  local FORCE=false UNINSTALL=false
  
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix)
        PI_DIR="$2"
        PKG_DIR="$PI_DIR/packages/$PKG_NAME"
        shift 2
        ;;
      --force) FORCE=true; shift ;;
      --uninstall) UNINSTALL=true; shift ;;
      --help|-h) usage; exit 0 ;;
      *) echo "Error: Unknown option: $1"; usage; exit 1 ;;
    esac
  done

  if $UNINSTALL; then
    uninstall
  else
    install
  fi
}

main "$@"
