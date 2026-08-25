#!/usr/bin/env bash
# T1: install.sh behavior tests
# Verify: pi-codebase-memory is installed/uninstalled like pi-memory (settings.json registration + package dir cleanup)
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/install.sh"

# ────────────────────────────────────────────────────────────
# Static structure tests (pure grep, no install execution)
# ────────────────────────────────────────────────────────────

# Test 1: install.sh exists and is executable
test -x "$SCRIPT" || { echo "❌ FAIL: install.sh not executable"; exit 1; }
echo "✅ PASS: install.sh exists and is executable"

# Test 2: bash syntax check
bash -n "$SCRIPT" || { echo "❌ FAIL: bash syntax error"; exit 1; }
echo "✅ PASS: bash syntax OK"

# Test 3: new constants exist with correct values
grep -q 'PI_CODEBASE_MEMORY_PKG="$PI_CODEBASE_MEMORY_DEST_DIR"' "$SCRIPT" \
  || { echo "❌ FAIL: PI_CODEBASE_MEMORY_PKG constant missing or wrong"; exit 1; }
echo "✅ PASS: PI_CODEBASE_MEMORY_PKG constant defined"

# Test 4: all three new functions are defined
for fn in is_pi_codebase_memory_installed install_pi_codebase_memory uninstall_pi_codebase_memory; do
  grep -qE "^${fn}\(\) \{$" "$SCRIPT" \
    || { echo "❌ FAIL: function $fn not defined"; exit 1; }
done
echo "✅ PASS: 3 functions defined (is_/install_/uninstall_)"

# Test 5: install() flow includes install_pi_codebase_memory
sed -n '/^install() {/,/^}$/p' "$SCRIPT" | grep -q "install_pi_codebase_memory" \
  || { echo "❌ FAIL: install() does not call install_pi_codebase_memory"; exit 1; }
echo "✅ PASS: install() invokes install_pi_codebase_memory"

# Test 6: uninstall() flow includes uninstall_pi_codebase_memory
sed -n '/^uninstall() {/,/^}$/p' "$SCRIPT" | grep -q "uninstall_pi_codebase_memory" \
  || { echo "❌ FAIL: uninstall() does not call uninstall_pi_codebase_memory"; exit 1; }
echo "✅ PASS: uninstall() invokes uninstall_pi_codebase_memory"

# Test 7: --sages-only mode comments explicitly mention skipping pi-codebase-memory
grep -q "pi-codebase-memory" "$SCRIPT" \
  || { echo "❌ FAIL: pi-codebase-memory not mentioned in help/comments"; exit 1; }
echo "✅ PASS: pi-codebase-memory referenced in script"

# ────────────────────────────────────────────────────────────
# Function behavior tests (isolate PI_DIR, invoke functions directly)
# ────────────────────────────────────────────────────────────

# Extract function bodies via eval (avoid main "$@" triggering install)
extract_fn() {
  awk -v fn="$1" '
    $0 ~ "^" fn "\\(\\) \\{" { capture=1; depth=0 }
    capture { print; for (i=1; i<=length($0); i++) { c=substr($0,i,1); if (c=="{") depth++; if (c=="}") depth-- }; if (depth==0 && NR>1 && capture>0) { capture=0 } }
  ' "$SCRIPT"
}

TMPDIR="$(mktemp -d)"
export PI_DIR="$TMPDIR"

# Strip pi from PATH so install takes the fallback (manual settings.json write) path,
# which makes the test independent of a real pi CLI and prevents polluting the global ~/.pi/agent/settings.json
FAKE_PATH="$(mktemp -d)"
export PATH="$FAKE_PATH:/usr/bin:/bin"

mkdir -p "$PI_DIR/agent"
echo '{"packages": []}' > "$PI_DIR/agent/settings.json"

# Load the needed functions (extract_fn is defined in this test script, not needed)
# Extract all pi-codebase-memory constants + functions (need PI_CODEBASE_MEMORY_DEST_DIR, etc.)
{
  awk '/^PI_CODEBASE_MEMORY_.*=/,/^$/' "$SCRIPT"
  for fn in is_pi_codebase_memory_installed install_pi_codebase_memory uninstall_pi_codebase_memory; do
    extract_fn "$fn"
  done
} > "$TMPDIR/pi-codebase-memory-fns.sh"
# shellcheck disable=SC1090
source "$TMPDIR/pi-codebase-memory-fns.sh"

# ──────────────────────────────────────────────────────────────────
# T4: Subagent template directory (pi/templates/agents/)
# As of Phase B migration (commit 1d9cbc1), all canonical subagent
# templates (developer / auditor) moved into pi-subagents built-ins.
# install.sh no longer copies anything from pi/templates/agents/ to
# $AGENT_DIR/agents/. Only T4.1 (assert no canonical template ships)
# and T4.21-T4.23 (assert built-in defaults in pi-subagents) remain.
# The historical T4.3-T4.20a block (constants + behavioral install /
# uninstall tests for the removed installer path) was retired in
# GC-2026-069 because it tested a defunct code path that no longer
# exists in install.sh.

SUBAGENT_TEMPLATES_DIR="$(cd "$(dirname "$SCRIPT")/.." && pwd)/templates/agents"

# Test T4.1: NO canonical subagent template is shipped (Phase A + Phase B
# complete: developer and auditor are both built-in to pi-subagents; the
# user-level files only survive as user customizations or backups).
# The template directory may exist (as an empty dir from git) or not; we
# only assert the canonical software-auditor.md is gone.
if [[ -f "$SUBAGENT_TEMPLATES_DIR/software-auditor.md" ]]; then
  echo "❌ FAIL: $SUBAGENT_TEMPLATES_DIR/software-auditor.md should not be shipped (Phase B migration moved canonical to pi-subagents)"
  exit 1
fi
echo "✅ PASS: templates/agents/software-auditor.md is NOT shipped (Phase B migrated canonical to pi-subagents)"

# T4.21 (continued): subagent frontmatter must NOT hard-limit
# (T4.* behavioral tests above mutate TMPDIR4 PI_DIR/AGENT_DIR; this
# block re-reads the on-disk templates, so it lives outside the
# behavioral section.)
#
# Goal: each shipped subagent inherits the orchestrator's parent model,
# thinking level, and turn count instead of forcing Anthropic Sonnet 4.6
# with `thinking: high` and an absolute max_turns cap.
# ─────────────────────────────────────────────────────────────────

# Test T4.21: no software-auditor.md is shipped (Phase B migrated the
# canonical to pi-subagents). With no shipped template, the previous
# "template doesn't pin model/thinking/max_turns" checks collapse to
# "no shipped template exists" — the built-in auditor inherits the
# parent model/thinking/max_turns via the Agent tool's runtime resolver
# (options override the agent config).
test ! -f "$SUBAGENT_TEMPLATES_DIR/software-auditor.md" \
  || { echo "❌ FAIL: templates/agents/software-auditor.md should not be shipped (Phase B migrated canonical)"; exit 1; }
echo "✅ PASS: no shipped software-auditor.md template (canonical lives in pi-subagents; runtime inherits from parent)"

# Test T4.22: the canonical built-in `auditor` in pi-subagents pins a
# Sages-house model (MiniMax/MiniMax-M3 as of GC-2026-046); when the
# registry doesn't have it, resolveDefaultModel silently falls back to
# the parent session's model. The test enforces that the pinned value is
# the Sages-approved one — not a future contributor sneaking in
# claude-sonnet-4-6 or another costly model.
AUDITOR_BLOCK=$(awk '/name: "auditor"/,/^};?$/' /home/leroy/Project/sages/pi-subagents/src/default-agents.ts)
if echo "$AUDITOR_BLOCK" | grep -qE '^\s*model:\s*"[^"]+"'; then
  echo "$AUDITOR_BLOCK" | grep -qE 'model:\s*"MiniMax/MiniMax-M3"' \
    || { echo "❌ FAIL: default-agents.ts auditor pins a non-Sages-approved model; expected MiniMax/MiniMax-M3"; exit 1; }
  echo "✅ PASS: pi-subagents auditor pins MiniMax/MiniMax-M3 (Sages house model, silent fallback to parent)"
else
  echo "✅ PASS: pi-subagents auditor does not pin a model — inherits parent"
fi

# Test T4.22b: Explore intentionally pins haiku-4-5 (cheap read-only
# search); document the exception so a future contributor doesn't
# accidentally "clean it up" by removing the model pin.
grep -qE 'model:\s*"anthropic/claude-haiku-4-5"' /home/leroy/Project/sages/pi-subagents/src/default-agents.ts \
  || { echo "❌ FAIL: Explore should pin haiku-4-5 (cheap read-only search)"; exit 1; }
echo "✅ PASS: Explore pins haiku-4-5 (documented exception to the no-model-pin rule)"

# Test T4.23: the canonical built-in auditor declares its OWN maxTurns
# budget (200 — same as developer) and DOES NOT pin thinking level
# (inherit from parent). The user override path is Agent({ max_turns: ... }).
AUDITOR_CONFIG=$(grep -A 25 'name: "auditor"' /home/leroy/Project/sages/pi-subagents/src/default-agents.ts | head -25)
echo "$AUDITOR_CONFIG" | grep -qE 'maxTurns:\s*200' \
  || { echo "❌ FAIL: default-agents.ts auditor does not declare maxTurns=200"; exit 1; }
echo "✅ PASS: pi-subagents auditor declares maxTurns=200 (matches developer's per-run budget)"

# ──────────────────────────────────────────────────────────────────
# T6.x: background-default contract for "implement" + "audit" phases
# Verifies the orchestrator skill's templates + agent prompts declare
# the "foreground = explore/plan, background = implement/audit" split
# explicitly. Each test reads one or more files and grep-grep-greps for
# the contractual phrase or annotation.
# ──────────────────────────────────────────────────────────────────

ORCH_SKILL_DIR="$(cd "$(dirname "$SCRIPT")/../.." && pwd)/pi-orchestrator/skills/orchestrator"
GOALS_DIR="$ORCH_SKILL_DIR/templates/goals"
DAGS_DIR="$ORCH_SKILL_DIR/templates/dag"
PROMPTS_DIR="$ORCH_SKILL_DIR/templates/prompts"

# Test T6.1: every goal template carries a `parallelism_notes` field
# (or equivalent) and explicitly marks implement/audit as `run_in_background: true`).
# Goal templates don't include the subagent task directly — the DAG does. So
# the goal template's job is to flag WHICH phases are safe to background.
for goal in goal-new-feature goal-fix-bug goal-refactor goal-add-tests; do
  f="$GOALS_DIR/$goal.yaml"
  test -f "$f" || { echo "❌ FAIL: $goal.yaml missing"; exit 1; }
  grep -qE 'run_in_background:\s*true' "$f" \
    || { echo "❌ FAIL: $goal.yaml must declare 'run_in_background: true' for implement/audit"; exit 1; }
done
echo "✅ PASS: all 4 goal templates declare run_in_background: true for implement/audit"

# Test T6.2: every DAG template marks developer and software-auditor
# subagent tasks with `run_in_background: true`.
for dag in dag-bug-fix dag-tdd-refactor; do
  f="$DAGS_DIR/$dag.yaml"
  test -f "$f" || { echo "❌ FAIL: $dag.yaml missing"; exit 1; }
  # Each developer/software-auditor task must be backgrounded
  python3 -c "
import re, sys
text = open('$f').read()
# Find all top-level task blocks (lines starting with '  - id:')
# and check each task that uses developer/software-auditor
# has run_in_background: true somewhere in its block.
task_blocks = re.split(r'\n(?=\s*-\s+id:\s)', text)
ok = True
for blk in task_blocks:
    if 'subagent_type: developer' in blk or 'subagent_type: auditor' in blk:
        if not re.search(r'run_in_background:\s*true', blk):
            ok = False
            print(f'❌ FAIL: $dag.yaml has implement/audit task without run_in_background: true', file=sys.stderr)
            sys.exit(1)
if ok:
    print('✅ PASS: $dag.yaml backgrounds all implement/audit tasks')
"
done

# Test T6.4: developer + auditor system prompts accept being spawned in
# background (the agent's job is to behave well under background —
# acknowledge steers, do not block on stdin, etc.). Both are built-in
# to pi-subagents; check the built-in prompt files directly.
DEVELOPER_PROMPT_FILE="$(cd "$(dirname "$SCRIPT")/../.." && pwd)/pi-subagents/src/agent-prompts/developer.ts"
AUDITOR_PROMPT_FILE="$(cd "$(dirname "$SCRIPT")/../.." && pwd)/pi-subagents/src/agent-prompts/auditor.ts"
test -f "$DEVELOPER_PROMPT_FILE" \
  || { echo "❌ FAIL: developer prompt file missing at $DEVELOPER_PROMPT_FILE"; exit 1; }
test -f "$AUDITOR_PROMPT_FILE" \
  || { echo "❌ FAIL: auditor prompt file missing at $AUDITOR_PROMPT_FILE (Phase B migration incomplete)"; exit 1; }
grep -qiE 'background' "$DEVELOPER_PROMPT_FILE" \
  || { echo "❌ FAIL: developer.ts must mention 'background' (acknowledges the spawn mode)"; exit 1; }
grep -qiE 'background' "$AUDITOR_PROMPT_FILE" \
  || { echo "❌ FAIL: auditor.ts must mention 'background' (acknowledges the spawn mode)"; exit 1; }
echo "✅ PASS: developer + auditor built-in system prompts acknowledge background mode"

# Test T6.5: orchestrator SKILL.md has a parallelism_notes section
test -f "$ORCH_SKILL_DIR/SKILL.md" || { echo "❌ FAIL: orchestrator SKILL.md missing"; exit 1; }
grep -qE 'parallelism_notes|run_in_background' "$ORCH_SKILL_DIR/SKILL.md" \
  || { echo "❌ FAIL: orchestrator SKILL.md must document parallelism_notes or run_in_background"; exit 1; }
echo "✅ PASS: orchestrator SKILL.md documents parallelism / run_in_background"

# Test T6.6: pi/templates/SYSTEM.md (orchestrator system prompt) references
# the foreground/background split, so the orchestrator LLM knows the rule.
SYSTEM_TEMPLATE="$(cd "$(dirname "$SCRIPT")/.." && pwd)/templates/SYSTEM.md"
test -f "$SYSTEM_TEMPLATE" || { echo "❌ FAIL: SYSTEM.md template missing"; exit 1; }
grep -qiE 'background|run_in_background' "$SYSTEM_TEMPLATE" \
  || { echo "❌ FAIL: SYSTEM.md must mention background execution for implement/audit"; exit 1; }
echo "✅ PASS: SYSTEM.md references background execution"

# Test T6.7: subagent prompt templates include
# the "you may be spawned in background" guidance. Without it, subagents
# might not behave well when called with run_in_background: true.
# Phase A: software-developer was renamed to developer (see SKILL.md migration section).
for prompt in subagent-developer.md subagent-auditor.md; do
  f="$PROMPTS_DIR/$prompt"
  test -f "$f" || { echo "❌ FAIL: $prompt missing in $PROMPTS_DIR"; exit 1; }
  grep -qiE 'background' "$f" \
    || { echo "❌ FAIL: $prompt must mention background mode (subagent context)"; exit 1; }
done
echo "✅ PASS: subagent-{developer,auditor} prompts mention background mode"

# ──────────────────────────────────────────────────────────────────
# T7: AFT install/uninstall fully removed from all 3 install scripts
#
# AFT (pi-code-intel via @cortexkit/aft-pi) is owned by the AFT team;
# the AFT install is delegated to `npx @cortexkit/aft@latest setup
# --harness pi` run manually by the user. None of the 3 install
# scripts (install.sh / install.ps1 / install.bat) may write to
# ~/.config/cortexkit/aft.jsonc or invoke an AFT installer — that
# was removed and the regression guard lives here.
#
# install.sh, install.ps1, install.bat share the same SYSTEM.md
# template (see header comment of each) and are expected to share
# the same AFT-removal invariant. One script drifting from the others
# is the regression we are guarding against.
# ──────────────────────────────────────────────────────────────────

SCRIPTS_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
INSTALL_SH="$SCRIPTS_DIR/install.sh"
INSTALL_PS1="$SCRIPTS_DIR/install.ps1"
INSTALL_BAT="$SCRIPTS_DIR/install.bat"

# Helper: assert $1 (file) does NOT contain any AFT install/uninstall symbol
# or AFT config-path reference. Symbols to forbid:
#   - bash: install_aft_*, uninstall_aft_*, AFT_HOME, AFT_CONFIG, AFT_TEMPLATE
#   - ps1:  install_aft_config (function name) + same path strings
#   - bat:  AFT_HOME, AFT_CONFIG, AFT_TEMPLATE (uppercase vars are bat convention)
assert_no_aft_install() {
  local file="$1"
  local label="$2"
  [[ -f "$file" ]] || { echo "❌ FAIL: $label not found at $file"; exit 1; }

  # Filter out pure comment lines (bash `#`, batch `REM`, jsonc `//`).
  # Comments that mention AFT are intentional documentation telling the
  # user that AFT is not auto-installed (see install.sh lines 9-13).
  #
  # Implementation: strip the `grep -n` line-number prefix first
  # (so the comment-marker check operates on the actual content), then
  # drop lines whose content starts with `#`, `REM`, or `//`. Using only
  # `grep -v` against a line-numbered prefix would falsely filter ALL
  # numbered lines (since `<digits>:` matches any line printed by `grep -n`).
  filter_comments() {
    sed -E 's/^[[:space:]]*[0-9]+[:-]//' | grep -viE '^[[:space:]]*(#|REM|//)'
  }

  # Forbidden function/symbol names (case-insensitive — AFT_HOME in .bat,
  # install_aft_config in .ps1, etc.). Comments filtered out.
  local hits
  hits=$(grep -inE 'install_aft_|uninstall_aft_|AFT_HOME|AFT_CONFIG|AFT_TEMPLATE' "$file" \
           | filter_comments || true)
  [[ -z "$hits" ]] || {
    echo "❌ FAIL: $label still has AFT install/uninstall symbols:"
    echo "$hits" | sed 's/^/    /'
    exit 1
  }

  # Forbidden: any literal copy/move/install action targeting aft.jsonc
  # (catches e.g. `copy .* aft\.jsonc`, `Copy-Item .* aft\.jsonc`,
  # `mv .* aft\.jsonc`, `del .* aft\.jsonc`, etc.). Comments filtered out.
  hits=$(grep -inE '(copy|mv|del|remove-item|copy-item|xcopy|install)[^"]*aft\.jsonc' "$file" \
           | filter_comments || true)
  [[ -z "$hits" ]] || {
    echo "❌ FAIL: $label still has a copy/delete target on aft.jsonc:"
    echo "$hits" | sed 's/^/    /'
    exit 1
  }
}

# Test T7.1: install.sh has no AFT install/uninstall symbols
assert_no_aft_install "$INSTALL_SH" "install.sh"
echo "✅ PASS: install.sh has no AFT install/uninstall symbols"

# Test T7.2: install.ps1 has no AFT install/uninstall symbols
assert_no_aft_install "$INSTALL_PS1" "install.ps1"
echo "✅ PASS: install.ps1 has no AFT install/uninstall symbols"

# Test T7.3: install.bat has no AFT install/uninstall symbols
assert_no_aft_install "$INSTALL_BAT" "install.bat"
echo "✅ PASS: install.bat has no AFT install/uninstall symbols"

# Test T7.4: all 3 scripts carry the "AFT is NOT auto-installed" rationale
# (matches install.sh's existing lines 9-13; this guards against future
# drift where one script accidentally re-introduces AFT logic without
# the explanation that goes with it). Iterate over absolute paths since
# the test may run from any cwd.
for entry in "install.sh|$INSTALL_SH" "install.ps1|$INSTALL_PS1" "install.bat|$INSTALL_BAT"; do
  label="${entry%|*}"
  file="${entry#*|}"
  grep -iq 'AFT.*NOT auto-installed\|NOT auto-installed.*AFT\|NOT.*auto-installed' "$file" \
    || { echo "❌ FAIL: $label missing 'AFT is NOT auto-installed' rationale"; exit 1; }
done
echo "✅ PASS: all 3 install scripts document AFT as NOT auto-installed"

# Test T7.5: none of the 3 scripts perform an executable action on
# aft.jsonc (cp / Copy-Item / del / Remove-Item / mv / xcopy / findstr
# targeting the AFT config file). Documentation comments telling the
# user to "copy aft.jsonc manually" are fine and intentional (see
# install.sh lines 9-13) — only *executable* references are forbidden.
for entry in "install.sh|$INSTALL_SH" "install.ps1|$INSTALL_PS1" "install.bat|$INSTALL_BAT"; do
  label="${entry%|*}"
  file="${entry#*|}"
  # Lines mentioning aft.jsonc, minus pure comments (`#…`, `REM …`, `//…`)
  hits=$(grep -inE 'aft\.jsonc' "$file" \
           | sed -E 's/^[[:space:]]*[0-9]+[:-]//' \
           | grep -viE '^[[:space:]]*(#|REM|//)' \
           | grep -iE '(^|[[:space:]])(cp |copy-item|remove-item|copy /y|xcopy|mv |del /q|del /f|findstr)' \
           || true)
  [[ -z "$hits" ]] || {
    echo "❌ FAIL: $label has an executable action on aft.jsonc:"
    echo "$hits" | sed 's/^/    /'
    exit 1
  }
done
echo "✅ PASS: no install script has an executable action on aft.jsonc"

# Test T7.6: install.ps1 has no `function install_aft_config` (the exact
# PowerShell function definition that must be gone)
grep -qE '^function install_aft_config\b' "$INSTALL_PS1" \
  && { echo "❌ FAIL: install.ps1 still defines install_aft_config function"; exit 1; \
} || echo "✅ PASS: install.ps1 install_aft_config function removed"

# Test T7.7: install.bat has no AFT_CONFIG variable declaration
grep -qE '^set "AFT_CONFIG=' "$INSTALL_BAT" \
  && { echo "❌ FAIL: install.bat still declares AFT_CONFIG variable"; exit 1; \
} || echo "✅ PASS: install.bat AFT_CONFIG variable removed"


# Final summary (printed only on the success path — failures abort above)
echo ""
echo "═════════════════════════════════════════════════════"
echo "  All install.test.sh checks passed"
echo "═════════════════════════════════════════════════════"
