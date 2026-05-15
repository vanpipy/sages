#!/usr/bin/env bash
#
# Four Sages Installation Script for pi
# Installs to ~/.pi/packages/sages
#

set -euo pipefail

PI_DIR="${PI_DIR:-$HOME/.pi}"
PKG_NAME="sages"
PKG_DIR="$PI_DIR/packages/$PKG_NAME"
REPO_URL="https://github.com/vanpipy/sages.git"
AGENT_DIR="$PI_DIR/agent"

usage() {
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --prefix DIR         Set pi config dir (default: ~/.pi)"
  echo "  --force              Overwrite existing files"
  echo "  --uninstall          Remove installed files"
  echo "  --install-pi         Install pi if not found"
  echo "  --with-system-prompt Install agent/SYSTEM.md"
  echo "  --help, -h           Show this help"
  echo ""
  echo "Examples:"
  echo "  $0 --install-pi --with-system-prompt"
  echo "  $0 --uninstall"
}

# -----------------------------------------------------------------------------
# Step 0: Install pi
# -----------------------------------------------------------------------------
install_pi() {
  echo "==> Installing pi..."
  
  if command -v pi &>/dev/null; then
    echo "==> Found existing pi: $(pi --version 2>/dev/null || echo 'unknown')"
    return 0
  fi
  
  if curl -fsSL https://pi.dev/install.sh | sh; then
    echo "==> pi installed successfully"
  else
    echo "Error: Failed to install pi"
    return 1
  fi
  
  if ! command -v pi &>/dev/null; then
    echo "Error: pi not in PATH. Add ~/.local/bin to PATH:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    return 1
  fi
  
  return 0
}

# -----------------------------------------------------------------------------
# Step 1: Install system prompt
# -----------------------------------------------------------------------------
install_system_prompt() {
  echo "==> Installing system prompt..."
  
  mkdir -p "$AGENT_DIR"
  
  cat > "$AGENT_DIR/SYSTEM.md" << 'EOF'
# Role: DevSecOps & Polyglot Systems Engineer

You are a strategic expert specializing in AI-driven DevOps (The Command Center), Security & Penetration Testing (The Primary Capability), and Multi-language Engineering (The Supporting Capability).

## 1. Context Prioritization & Constitution (First Priority)
**Align your behavior with the project's "Living Documentation":**
1. **Constitution & Logic**: Proactively read `.specify/memory/constitution.md` or similar "Convention" files to align with long-term logic and decision-making philosophies.
2. **Local Dominance**: Project-specific rules in `.pi/SYSTEM.md`, `CLAUDE.md`, or `AGENTS.md` override global directives.
3. **Execution Gate**: Before taking action, verify the specific constraints of the current environment to ensure architectural consistency.

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
  
  echo "==> Created $AGENT_DIR/SYSTEM.md"
}

# -----------------------------------------------------------------------------
# Register/unregister in settings.json
# -----------------------------------------------------------------------------
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

unregister_settings() {
  local settings="$PI_DIR/agent/settings.json"
  [[ ! -f "$settings" ]] && return

  python3 -c "
import json, sys
f, p = '$settings', '$PKG_DIR'
d = json.load(open(f))
d['packages'] = [x for x in d.get('packages', []) if x != p]
json.dump(d, open(f, 'w'), indent=2)
print('Unregistered', p)
"
}

# -----------------------------------------------------------------------------
# Install sages package
# -----------------------------------------------------------------------------
do_install() {
  local tmp_dir
  tmp_dir=$(mktemp -d)
  
  echo "==> Cloning sages to $tmp_dir"
  git clone "$REPO_URL" "$tmp_dir"
  
  echo "==> Installing to $PKG_DIR"
  mkdir -p "$PKG_DIR"
  
  for dir in prompts skills extensions src; do
    [[ -d "$tmp_dir/pi/$dir" ]] || continue
    if [[ -d "$PKG_DIR/$dir" && "${FORCE:-false}" != true ]]; then
      echo "  Skipping $dir/ (exists)"
    else
      cp -r${FORCE:+ -f} "$tmp_dir/pi/$dir" "$PKG_DIR/"
      echo "  Copied $dir/"
    fi
  done
  
  echo "==> Copying package.json"
  if [[ "${FORCE:-false}" != true && -f "$PKG_DIR/package.json" ]]; then
    echo "  Skipping package.json (exists)"
  else
    cp "$tmp_dir/pi/package.json" "$PKG_DIR/package.json"
    echo "  Copied package.json"
  fi
  
  register_settings
  
  rm -rf "$tmp_dir"
  echo "==> Done. Restart pi: exit && pi"
}

# -----------------------------------------------------------------------------
# Uninstall sages package
# -----------------------------------------------------------------------------
do_uninstall() {
  echo "==> Uninstalling sages..."
  [[ -d "$PKG_DIR" ]] && rm -rf "$PKG_DIR" && echo "  Removed $PKG_DIR"
  unregister_settings
  echo "==> Done."
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  local FORCE=false UNINSTALL=false INSTALL_PI=false SYSTEM_PROMPT=false
  
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prefix)
        PI_DIR="$2"
        PKG_DIR="$PI_DIR/packages/$PKG_NAME"
        shift 2
        ;;
      --force) FORCE=true; shift ;;
      --uninstall) UNINSTALL=true; shift ;;
      --install-pi) INSTALL_PI=true; shift ;;
      --with-system-prompt) SYSTEM_PROMPT=true; shift ;;
      --help|-h) usage; exit 0 ;;
      *) echo "Unknown: $1"; usage; exit 1 ;;
    esac
  done

  # Check pi
  if ! command -v pi &>/dev/null; then
    if [[ "$INSTALL_PI" == true ]]; then
      install_pi || exit 1
    else
      echo "Error: pi not found in PATH"
      echo "Install: curl -fsSL https://pi.dev/install.sh | sh"
      echo "Or run: $0 --install-pi"
      exit 1
    fi
  fi

  # Check directories
  [[ -d "$PI_DIR" ]] || { echo "Error: $PI_DIR not found"; exit 1; }
  command -v git &>/dev/null || { echo "Error: git required"; exit 1; }

  echo "==> Four Sages Installation"
  echo "==> PI_DIR: $PI_DIR"
  echo ""

  if [[ "$UNINSTALL" == true ]]; then
    do_uninstall
    return
  fi

  do_install

  if [[ "$SYSTEM_PROMPT" == true ]]; then
    echo ""
    install_system_prompt
  fi
  
  echo ""
  echo "==> Setup complete!"
}

main "$@"
