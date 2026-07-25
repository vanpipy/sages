#!/usr/bin/env bash
# T1: install.sh 行为测试
# 验证: pi-codebase-memory 像 pi-memory 一样被安装/卸载(settings.json 注册 + package dir 清理)
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/install.sh"

# ────────────────────────────────────────────────────────────
# 静态结构测试(纯 grep,无需执行 install)
# ────────────────────────────────────────────────────────────

# 测试 1: install.sh 存在且可执行
test -x "$SCRIPT" || { echo "❌ FAIL: install.sh not executable"; exit 1; }
echo "✅ PASS: install.sh exists and is executable"

# 测试 2: bash 语法检查
bash -n "$SCRIPT" || { echo "❌ FAIL: bash syntax error"; exit 1; }
echo "✅ PASS: bash syntax OK"

# 测试 3: 新常量存在且值正确
grep -q 'PI_CODEBASE_MEMORY_PKG="$PI_CODEBASE_MEMORY_DEST_DIR"' "$SCRIPT" \
  || { echo "❌ FAIL: PI_CODEBASE_MEMORY_PKG constant missing or wrong"; exit 1; }
echo "✅ PASS: PI_CODEBASE_MEMORY_PKG constant defined"

# 测试 4: 三个新函数均已定义
for fn in is_pi_codebase_memory_installed install_pi_codebase_memory uninstall_pi_codebase_memory; do
  grep -qE "^${fn}\(\) \{$" "$SCRIPT" \
    || { echo "❌ FAIL: function $fn not defined"; exit 1; }
done
echo "✅ PASS: 3 functions defined (is_/install_/uninstall_)"

# 测试 5: install() 流程包含 install_pi_codebase_memory
sed -n '/^install() {/,/^}$/p' "$SCRIPT" | grep -q "install_pi_codebase_memory" \
  || { echo "❌ FAIL: install() does not call install_pi_codebase_memory"; exit 1; }
echo "✅ PASS: install() invokes install_pi_codebase_memory"

# 测试 6: uninstall() 流程包含 uninstall_pi_codebase_memory
sed -n '/^uninstall() {/,/^}$/p' "$SCRIPT" | grep -q "uninstall_pi_codebase_memory" \
  || { echo "❌ FAIL: uninstall() does not call uninstall_pi_codebase_memory"; exit 1; }
echo "✅ PASS: uninstall() invokes uninstall_pi_codebase_memory"

# 测试 7: --sages-only 模式注释显式说明跳过 pi-codebase-memory
grep -q "pi-codebase-memory" "$SCRIPT" \
  || { echo "❌ FAIL: pi-codebase-memory not mentioned in help/comments"; exit 1; }
echo "✅ PASS: pi-codebase-memory referenced in script"

# ────────────────────────────────────────────────────────────
# 函数行为测试(隔离 PI_DIR,直接调用函数)
# ────────────────────────────────────────────────────────────

# 提取函数体并 eval(避开 main "$@" 触发 install)
extract_fn() {
  awk -v fn="$1" '
    $0 ~ "^" fn "\\(\\) \\{" { capture=1; depth=0 }
    capture { print; for (i=1; i<=length($0); i++) { c=substr($0,i,1); if (c=="{") depth++; if (c=="}") depth-- }; if (depth==0 && NR>1 && capture>0) { capture=0 } }
  ' "$SCRIPT"
}

TMPDIR="$(mktemp -d)"
export PI_DIR="$TMPDIR"

# 把 pi 从 PATH 移除,强制 install 走 fallback(settings.json 手动写入)路径,
# 这样测试不依赖真实的 pi CLI 也不会污染全局 ~/.pi/agent/settings.json
FAKE_PATH="$(mktemp -d)"
export PATH="$FAKE_PATH:/usr/bin:/bin"

mkdir -p "$PI_DIR/agent"
echo '{"packages": []}' > "$PI_DIR/agent/settings.json"

# 加载所需函数(extract_fn 是定义在脚本里的工具函数,不需要)
# 提取所有 pi-codebase-memory 常量 + 函数 (需要 PI_CODEBASE_MEMORY_DEST_DIR 等)
{
  awk '/^PI_CODEBASE_MEMORY_.*=/,/^$/' "$SCRIPT"
  for fn in is_pi_codebase_memory_installed install_pi_codebase_memory uninstall_pi_codebase_memory; do
    extract_fn "$fn"
  done
} > "$TMPDIR/pi-codebase-memory-fns.sh"
# shellcheck disable=SC1090
source "$TMPDIR/pi-codebase-memory-fns.sh"

# ──────────────────────────────────────────────────────────────────
# T4: Subagent templates (pi/templates/agents/)
# Validates: install.sh copies software-{auditor,developer}.md from
# pi/templates/agents/ to $AGENT_DIR/agents/, with sentinel-based
# idempotency matching the AFT config flow.
# ──────────────────────────────────────────────────────────────────

SUBAGENT_TEMPLATES_DIR="$(cd "$(dirname "$SCRIPT")/.." && pwd)/templates/agents"

# Test T4.1: both template files exist
for f in software-auditor.md software-developer.md; do
  test -f "$SUBAGENT_TEMPLATES_DIR/$f" \
    || { echo "❌ FAIL: template missing: $SUBAGENT_TEMPLATES_DIR/$f"; exit 1; }
done
echo "✅ PASS: templates/agents/{software-auditor,software-developer}.md exist"

# Test T4.2: both templates carry SAGES_TEMPLATE_V1 sentinel
for f in software-auditor.md software-developer.md; do
  grep -q 'SAGES_TEMPLATE_V1' "$SUBAGENT_TEMPLATES_DIR/$f" \
    || { echo "❌ FAIL: template $f missing sentinel"; exit 1; }
done
echo "✅ PASS: both templates carry SAGES_TEMPLATE_V1 sentinel"

# Test T4.3: SUBAGENT_* constants defined
for c in SUBAGENT_TEMPLATE_DIR SUBAGENT_TARGET_DIR SUBAGENT_NAMES SUBAGENT_SENTINEL_TEXT; do
  grep -qE "^${c}=" "$SCRIPT" \
    || { echo "❌ FAIL: constant $c not defined"; exit 1; }
done
echo "✅ PASS: 4 SUBAGENT_* constants defined"

# Test T4.4: 3 subagent template functions defined
for fn in is_subagent_template_installed install_subagent_templates uninstall_subagent_templates; do
  grep -qE "^${fn}\(\) \{$" "$SCRIPT" \
    || { echo "❌ FAIL: function $fn not defined"; exit 1; }
done
echo "✅ PASS: 3 subagent template functions defined"

# Test T4.5: install() flow calls install_subagent_templates
sed -n '/^install() {/,/^}$/p' "$SCRIPT" | grep -q "install_subagent_templates" \
  || { echo "❌ FAIL: install() does not call install_subagent_templates"; exit 1; }
echo "✅ PASS: install() invokes install_subagent_templates"

# Test T4.6: uninstall() flow calls uninstall_subagent_templates
sed -n '/^uninstall() {/,/^}$/p' "$SCRIPT" | grep -q "uninstall_subagent_templates" \
  || { echo "❌ FAIL: uninstall() does not call uninstall_subagent_templates"; exit 1; }
echo "✅ PASS: uninstall() invokes uninstall_subagent_templates"

# Test T4.7: --sages-only does NOT call install_subagent_templates
# (orchestrator agents are user-level global definitions, separate from
# the sages source files --sages-only is scoped to)
sed -n '/^install_sages_only() {/,/^}$/p' "$SCRIPT" | grep -q "install_subagent_templates" \
  && { echo "❌ FAIL: install_sages_only() should NOT call install_subagent_templates"; exit 1; }
echo "✅ PASS: --sages-only mode correctly skips install_subagent_templates"

# Test T4.8: install.sh references "subagent templates" so users see what
# they're skipping in --sages-only / --system-only output
grep -q "subagent templates" "$SCRIPT" \
  || { echo "❌ FAIL: 'subagent templates' not mentioned in install.sh"; exit 1; }
echo "✅ PASS: 'subagent templates' referenced in install.sh"

# ─────────────────────────────────────────────────────────────────
# Behavioral tests for subagent template install/uninstall.
# Use SCRIPT_DIR + extracted constants/functions, point at fake
# $SUBAGENT_TARGET_DIR so we never touch the real ~/.pi/agent/agents/.
# ─────────────────────────────────────────────────────────────────

TMPDIR4="$(mktemp -d)"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"

# The extracted SUBAGENT_TARGET_DIR constant expands to $AGENT_DIR/agents.
# Set AGENT_DIR + PI_DIR so the expansion resolves to a temp dir, not
# the real ~/.pi/agent/agents (which would clobber live agent files).
PI_DIR="$TMPDIR4"
AGENT_DIR="$PI_DIR/agent"

# Extract constants + functions for behavioral test
{
  awk '/^SUBAGENT_TEMPLATE_DIR=/' "$SCRIPT"
  awk '/^SUBAGENT_TARGET_DIR=/' "$SCRIPT"
  awk '/^SUBAGENT_NAMES=/' "$SCRIPT"
  awk '/^SUBAGENT_SENTINEL_TEXT=/' "$SCRIPT"
  for fn in is_subagent_template_installed _atomic_copy install_subagent_templates uninstall_subagent_templates; do
    extract_fn "$fn"
  done
} > "$TMPDIR4/subagent-fns.sh"
# shellcheck disable=SC1090
source "$TMPDIR4/subagent-fns.sh"

# Test T4.9: SUBAGENT_TEMPLATE_DIR resolves to the real templates dir
# Compare via canonical paths (realpath-style) — SUBAGENT_TEMPLATE_DIR
# literally contains "..", so string-comparison would fail even when both
# refer to the same physical directory.
test -d "$SUBAGENT_TEMPLATE_DIR" \
  || { echo "❌ FAIL: SUBAGENT_TEMPLATE_DIR not found at $SUBAGENT_TEMPLATE_DIR"; exit 1; }
SUBAGENT_TEMPLATE_DIR_CANONICAL=$(cd "$SUBAGENT_TEMPLATE_DIR" && pwd)
SUBAGENT_TEMPLATES_DIR_CANONICAL=$(cd "$SUBAGENT_TEMPLATES_DIR" && pwd)
test "$SUBAGENT_TEMPLATE_DIR_CANONICAL" = "$SUBAGENT_TEMPLATES_DIR_CANONICAL" \
  || { echo "❌ FAIL: SUBAGENT_TEMPLATE_DIR (canonical=$SUBAGENT_TEMPLATE_DIR_CANONICAL) != $SUBAGENT_TEMPLATES_DIR_CANONICAL"; exit 1; }
echo "✅ PASS: SUBAGENT_TEMPLATE_DIR resolves to pi/templates/agents"

# Test T4.10: SUBAGENT_NAMES has the 2 expected agents in canonical order
[[ "${#SUBAGENT_NAMES[@]}" -eq 2 ]] \
  || { echo "❌ FAIL: SUBAGENT_NAMES has ${#SUBAGENT_NAMES[@]} entries, expected 2"; exit 1; }
[[ "${SUBAGENT_NAMES[0]}" = "software-auditor" ]] \
  && [[ "${SUBAGENT_NAMES[1]}" = "software-developer" ]] \
  || { echo "❌ FAIL: SUBAGENT_NAMES = (${SUBAGENT_NAMES[*]}), expected (software-auditor software-developer)"; exit 1; }
echo "✅ PASS: SUBAGENT_NAMES = (software-auditor software-developer)"

# Test T4.11: behavioral — install_subagent_templates creates both files
mkdir -p "$SUBAGENT_TARGET_DIR"
test ! -e "$SUBAGENT_TARGET_DIR/software-auditor.md" \
  || { echo "❌ FAIL: pre-test: target already has software-auditor.md"; exit 1; }

install_subagent_templates

for name in software-auditor software-developer; do
  test -f "$SUBAGENT_TARGET_DIR/$name.md" \
    || { echo "❌ FAIL: install did not create $name.md"; exit 1; }
done
echo "✅ PASS: install_subagent_templates creates both agent files when missing"

# Test T4.12: installed files match templates byte-for-byte
for name in software-auditor software-developer; do
  diff -q "$SUBAGENT_TEMPLATE_DIR/$name.md" "$SUBAGENT_TARGET_DIR/$name.md" > /dev/null \
    || { echo "❌ FAIL: $name.md content mismatch with template"; diff "$SUBAGENT_TEMPLATE_DIR/$name.md" "$SUBAGENT_TARGET_DIR/$name.md"; exit 1; }
done
echo "✅ PASS: installed files match templates byte-for-byte"

# Test T4.13: installed files carry the sentinel
for name in software-auditor software-developer; do
  is_subagent_template_installed "$SUBAGENT_TARGET_DIR/$name.md" \
    || { echo "❌ FAIL: $name.md doesn't carry sentinel"; exit 1; }
done
echo "✅ PASS: installed files carry SAGES_TEMPLATE_V1 sentinel"

# Test T4.14: idempotent — re-install doesn't change our installed file
install_subagent_templates  # no --force, sentinel present → should skip
diff -q "$SUBAGENT_TEMPLATE_DIR/software-auditor.md" "$SUBAGENT_TARGET_DIR/software-auditor.md" > /dev/null \
  || { echo "❌ FAIL: re-install changed content (should be no-op)"; exit 1; }
echo "✅ PASS: install_subagent_templates is idempotent (no --force)"

# Test T4.15: user-customized file (no sentinel) is preserved on re-install.
# NOTE: must NOT contain the literal sentinel string or the test itself
# becomes self-defeating.
cat > "$SUBAGENT_TARGET_DIR/software-auditor.md" <<'CUSTOM_EOF'
---
name: My Custom Auditor
description: User-customized — must be preserved across no-FORCE re-installs.
---
# My Custom Auditor
(custom body content; deliberately lacks the install-template marker)
CUSTOM_EOF

install_subagent_templates  # no --force → must NOT overwrite user file

grep -q "My Custom Auditor" "$SUBAGENT_TARGET_DIR/software-auditor.md" \
  || { echo "❌ FAIL: user-customized software-auditor.md was clobbered"; cat "$SUBAGENT_TARGET_DIR/software-auditor.md"; exit 1; }
is_subagent_template_installed "$SUBAGENT_TARGET_DIR/software-auditor.md" \
  && { echo "❌ FAIL: user-customized file got sentinel from re-install"; exit 1; \
} || echo "✅ PASS: user-customized agent preserved on no-FORCE install"

# Test T4.16: FORCE=true overwrites user-customized file
FORCE=true install_subagent_templates
diff -q "$SUBAGENT_TEMPLATE_DIR/software-auditor.md" "$SUBAGENT_TARGET_DIR/software-auditor.md" > /dev/null \
  || { echo "❌ FAIL: FORCE=true did not restore template"; exit 1; }
is_subagent_template_installed "$SUBAGENT_TARGET_DIR/software-auditor.md" \
  || { echo "❌ FAIL: FORCE=true install didn't add sentinel"; exit 1; }
echo "✅ PASS: FORCE=true install overwrites user-customized file"

# Test T4.17: uninstall removes files WE installed (sentinel present)
uninstall_subagent_templates
for name in software-auditor software-developer; do
  test ! -f "$SUBAGENT_TARGET_DIR/$name.md" \
    || { echo "❌ FAIL: uninstall did not remove $name.md"; exit 1; }
done
echo "✅ PASS: uninstall_subagent_templates removes our installed templates"

# Test T4.18: uninstall leaves user-customized files alone
cat > "$SUBAGENT_TARGET_DIR/software-developer.md" <<'CUSTOM_EOF'
---
name: Custom Developer
description: User-written agent — uninstall must NOT touch.
---
# Custom Developer
CUSTOM_EOF

uninstall_subagent_templates

test -f "$SUBAGENT_TARGET_DIR/software-developer.md" \
  || { echo "❌ FAIL: uninstall removed user-customized software-developer.md"; exit 1; }
grep -q "Custom Developer" "$SUBAGENT_TARGET_DIR/software-developer.md" \
  || { echo "❌ FAIL: user-written content lost"; exit 1; }
echo "✅ PASS: uninstall_subagent_templates preserves user-customized files"

# Test T4.19: mixed state — install (no FORCE) on partial state installs
# only the missing template, leaves user-customized untouched
# Setup: software-developer.md is user-customized (from T4.18 above),
# software-auditor.md does NOT exist (was uninstalled in T4.17)
test ! -e "$SUBAGENT_TARGET_DIR/software-auditor.md" \
  || { echo "❌ FAIL: pre-test: software-auditor.md unexpectedly present"; exit 1; }

install_subagent_templates  # no FORCE → install missing auditor, skip user developer

test -f "$SUBAGENT_TARGET_DIR/software-auditor.md" \
  || { echo "❌ FAIL: install didn't add missing software-auditor.md"; exit 1; }
is_subagent_template_installed "$SUBAGENT_TARGET_DIR/software-auditor.md" \
  || { echo "❌ FAIL: newly-installed auditor lacks sentinel"; exit 1; }
grep -q "Custom Developer" "$SUBAGENT_TARGET_DIR/software-developer.md" \
  || { echo "❌ FAIL: mixed-state install overwrote user developer"; exit 1; }
echo "✅ PASS: mixed-state install installs only missing; user file untouched"

# Test T4.20: mixed-state uninstall removes only our installed file
# (auditor was installed by us in T4.19; developer is user-customized)
uninstall_subagent_templates
test ! -f "$SUBAGENT_TARGET_DIR/software-auditor.md" \
  || { echo "❌ FAIL: mixed uninstall did not remove our auditor"; exit 1; }
test -f "$SUBAGENT_TARGET_DIR/software-developer.md" \
  || { echo "❌ FAIL: mixed uninstall clobbered user developer"; exit 1; }
grep -q "Custom Developer" "$SUBAGENT_TARGET_DIR/software-developer.md" \
  || { echo "❌ FAIL: user content lost in mixed uninstall"; exit 1; }
echo "✅ PASS: mixed-state uninstall only removes our installed file"

# Cleanup test 4
rm -rf "$TMPDIR4"
unset PI_DIR AGENT_DIR

# ─────────────────────────────────────────────────────────────────
# T4.21 (continued): subagent frontmatter must NOT hard-limit
# (T4.* behavioral tests above mutate TMPDIR4 PI_DIR/AGENT_DIR; this
# block re-reads the on-disk templates, so it lives outside the
# behavioral section.)
#
# Goal: each shipped subagent inherits the orchestrator's parent model,
# thinking level, and turn count instead of forcing Anthropic Sonnet 4.6
# with `thinking: high` and an absolute max_turns cap.
# ─────────────────────────────────────────────────────────────────

# Test T4.21: neither template pins a model
for f in software-auditor.md software-developer.md; do
  grep -qE '^model:' "$SUBAGENT_TEMPLATES_DIR/$f" \
    && { echo "❌ FAIL: template $f declares 'model:' (must inherit parent)"; exit 1; \
  } || echo "✅ PASS: $f has no hard-coded model — inherits parent"
done

# Test T4.22: neither template pins thinking level
for f in software-auditor.md software-developer.md; do
  grep -qE '^thinking:' "$SUBAGENT_TEMPLATES_DIR/$f" \
    && { echo "❌ FAIL: template $f declares 'thinking:' (must inherit parent)"; exit 1; \
  } || echo "✅ PASS: $f has no hard-coded thinking level — inherits parent"
done

# Test T4.23: neither template pins max_turns
for f in software-auditor.md software-developer.md; do
  grep -qE '^max_turns:' "$SUBAGENT_TEMPLATES_DIR/$f" \
    && { echo "❌ FAIL: template $f declares 'max_turns:' (must inherit parent)"; exit 1; \
  } || echo "✅ PASS: $f has no hard-coded max_turns — inherits parent"
done

# ──────────────────────────────────────────────────────────────────
# T6.x: background-default contract for "implement" + "audit" phases
# Verifies the orchestrator skill's templates + agent prompts declare
# the "foreground = explore/plan, background = implement/audit" split
# explicitly. Each test reads one or more files and grep-grep-greps for
# the contractual phrase or annotation.
# ──────────────────────────────────────────────────────────────────

ORCH_SKILL_DIR="$(cd "$(dirname "$SCRIPT")/.." && pwd)/skills/orchestrator"
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

# Test T6.2: every DAG template marks software-developer and software-auditor
# subagent tasks with `run_in_background: true`.
for dag in dag-bug-fix dag-tdd-refactor; do
  f="$DAGS_DIR/$dag.yaml"
  test -f "$f" || { echo "❌ FAIL: $dag.yaml missing"; exit 1; }
  # Each software-developer/software-auditor task must be backgrounded
  python3 -c "
import re, sys
text = open('$f').read()
# Find all top-level task blocks (lines starting with '  - id:')
# and check each task that uses software-developer/software-auditor
# has run_in_background: true somewhere in its block.
task_blocks = re.split(r'\n(?=\s*-\s+id:\s)', text)
ok = True
for blk in task_blocks:
    if 'subagent_type: software-developer' in blk or 'subagent_type: software-auditor' in blk:
        if not re.search(r'run_in_background:\s*true', blk):
            ok = False
            print(f'❌ FAIL: $dag.yaml has implement/audit task without run_in_background: true', file=sys.stderr)
            sys.exit(1)
if ok:
    print('✅ PASS: $dag.yaml backgrounds all implement/audit tasks')
"
done

# Test T6.3: SUBAGENTS.md documents the foreground/background split
# (the user-facing doc that explains WHEN to use background).
SUBAGENTS_TEMPLATE="$(cd "$(dirname "$SCRIPT")/.." && pwd)/templates/SUBAGENTS.md"
test -f "$SUBAGENTS_TEMPLATE" || { echo "❌ FAIL: SUBAGENTS.md template missing"; exit 1; }
grep -qE 'run_in_background|background' "$SUBAGENTS_TEMPLATE" \
  || { echo "❌ FAIL: SUBAGENTS.md must discuss run_in_background / background execution"; exit 1; }
# Specific contract: SUBAGENTS.md must explicitly state developer+auditor are background-default
grep -qE 'software-developer.*background|background.*software-developer' "$SUBAGENTS_TEMPLATE" \
  || { echo "❌ FAIL: SUBAGENTS.md must state software-developer runs in background by default"; exit 1; }
grep -qE 'software-auditor.*background|background.*software-auditor' "$SUBAGENTS_TEMPLATE" \
  || { echo "❌ FAIL: SUBAGENTS.md must state software-auditor runs in background by default"; exit 1; }
echo "✅ PASS: SUBAGENTS.md documents developer+auditor as background-default"

# Test T6.4: software-developer system prompt accepts being spawned in background
# (the agent's job is to behave well under background — acknowledge steers,
# do not block on stdin, etc.)
for agent in software-developer software-auditor; do
  f="$SUBAGENT_TEMPLATES_DIR/$agent.md"
  grep -qiE 'background' "$f" \
    || { echo "❌ FAIL: $agent.md must mention 'background' (acknowledges the spawn mode)"; exit 1; }
done
echo "✅ PASS: software-developer + software-auditor system prompts acknowledge background mode"

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

# Test T6.7: subagent prompt templates (subagent-software-*.md) include
# the "you may be spawned in background" guidance. Without it, subagents
# might not behave well when called with run_in_background: true.
for prompt in subagent-software-developer.md subagent-software-auditor.md; do
  f="$PROMPTS_DIR/$prompt"
  test -f "$f" || { echo "❌ FAIL: $prompt missing in $PROMPTS_DIR"; exit 1; }
  grep -qiE 'background' "$f" \
    || { echo "❌ FAIL: $prompt must mention background mode (subagent context)"; exit 1; }
done
echo "✅ PASS: subagent-software-{developer,auditor} prompts mention background mode"

# ──────────────────────────────────────────────────────────────────
# T5: SUBAGENTS.md — 4-agent pipeline doc
# Validates: install.sh ships templates/SUBAGENTS.md to $AGENT_DIR/SUBAGENTS.md,
# complementing install_subagent_templates() so the full 4-agent pipeline
# (Explore + Plan + software-developer + software-auditor) is documented
# in one discoverable place.
# ──────────────────────────────────────────────────────────────────

SUBAGENTS_TEMPLATE="$(cd "$(dirname "$SCRIPT")/.." && pwd)/templates/SUBAGENTS.md"

# Test T5.1: templates/SUBAGENTS.md exists
test -f "$SUBAGENTS_TEMPLATE" \
  || { echo "❌ FAIL: SUBAGENTS.md template missing at $SUBAGENTS_TEMPLATE"; exit 1; }
echo "✅ PASS: templates/SUBAGENTS.md exists"

# Test T5.2: SUBAGENTS.md documents all 4 pipeline agents by name
for agent in Explore Plan software-developer software-auditor; do
  grep -q "$agent" "$SUBAGENTS_TEMPLATE" \
    || { echo "❌ FAIL: SUBAGENTS.md missing agent '$agent'"; exit 1; }
done
echo "✅ PASS: SUBAGENTS.md documents all 4 pipeline agents"

# Test T5.3: SUBAGENTS.md distinguishes built-in vs custom (the install
# optimization story — only ship the 2 custom agents)
grep -q "built-in" "$SUBAGENTS_TEMPLATE" \
  || { echo "❌ FAIL: SUBAGENTS.md should mark pi-subagents built-ins"; exit 1; }
grep -q "shipped" "$SUBAGENTS_TEMPLATE" \
  || { echo "❌ FAIL: SUBAGENTS.md should mark which agents sages ships"; exit 1; }
echo "✅ PASS: SUBAGENTS.md distinguishes built-in vs custom-shipped agents"

# Test T5.4: SUBAGENTS.md contains concrete Agent(...) invocation recipes
grep -q "Agent({" "$SUBAGENTS_TEMPLATE" \
  || { echo "❌ FAIL: SUBAGENTS.md should include Agent({ ... }) invocation examples"; exit 1; }
echo "✅ PASS: SUBAGENTS.md includes Agent({ ... }) invocation recipes"

# Test T5.5: SUBAGENTS_DOC_* constants defined in install.sh
for c in SUBAGENTS_DOC_TEMPLATE SUBAGENTS_DOC_TARGET; do
  grep -qE "^${c}=" "$SCRIPT" \
    || { echo "❌ FAIL: constant $c not defined in install.sh"; exit 1; }
done
echo "✅ PASS: 2 SUBAGENTS_DOC_* constants defined"

# Test T5.6: install_subagents_doc / uninstall_subagents_doc functions defined
for fn in install_subagents_doc uninstall_subagents_doc; do
  grep -qE "^${fn}\(\) \{$" "$SCRIPT" \
    || { echo "❌ FAIL: function $fn not defined"; exit 1; }
done
echo "✅ PASS: 2 subagents_doc functions defined"

# Test T5.7: install() flow calls install_subagents_doc
sed -n '/^install() {/,/^}$/p' "$SCRIPT" | grep -q "install_subagents_doc" \
  || { echo "❌ FAIL: install() does not call install_subagents_doc"; exit 1; }
echo "✅ PASS: install() invokes install_subagents_doc"

# Test T5.8: uninstall() flow calls uninstall_subagents_doc
sed -n '/^uninstall() {/,/^}$/p' "$SCRIPT" | grep -q "uninstall_subagents_doc" \
  || { echo "❌ FAIL: uninstall() does not call uninstall_subagents_doc"; exit 1; }
echo "✅ PASS: uninstall() invokes uninstall_subagents_doc"

# Test T5.9: install summary header mentions "4-agent subagent pipeline"
# (the user-facing message that ties the 4 agents together)
grep -q "4-agent subagent pipeline" "$SCRIPT" \
  || { echo "❌ FAIL: install header doesn't mention 4-agent pipeline"; exit 1; }
echo "✅ PASS: install header advertises the 4-agent pipeline"

# ─────────────────────────────────────────────────────────────────
# Behavioral tests — install_subagents_doc / uninstall_subagents_doc.
# Use a fresh TMPDIR5 + same PI_DIR/AGENT_DIR pattern as T4 so the
# extracted $SUBAGENTS_DOC_TARGET resolves to a temp dir, not the
# real ~/.pi/agent/agents/.
# ─────────────────────────────────────────────────────────────────

TMPDIR5="$(mktemp -d)"
PI_DIR="$TMPDIR5"
AGENT_DIR="$PI_DIR/agent"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"

# Extract constants + functions for behavioral test
{
  awk '/^SUBAGENTS_DOC_TEMPLATE=/' "$SCRIPT"
  awk '/^SUBAGENTS_DOC_TARGET=/' "$SCRIPT"
  for fn in _atomic_copy install_subagents_doc uninstall_subagents_doc; do
    extract_fn "$fn"
  done
} > "$TMPDIR5/subagents-doc-fns.sh"
# shellcheck disable=SC1090
source "$TMPDIR5/subagents-doc-fns.sh"

# Test T5.10: SUBAGENTS_DOC_TEMPLATE resolves to the real template
test -f "$SUBAGENTS_DOC_TEMPLATE" \
  || { echo "❌ FAIL: SUBAGENTS_DOC_TEMPLATE not found"; exit 1; }
echo "✅ PASS: SUBAGENTS_DOC_TEMPLATE resolves to pi/templates/SUBAGENTS.md"

# Test T5.11: SUBAGENTS_DOC_TARGET resolves under our fake AGENT_DIR
# (not the real ~/.pi/agent/, which would clobber live state)
test "$SUBAGENTS_DOC_TARGET" = "$TMPDIR5/agent/SUBAGENTS.md" \
  || { echo "❌ FAIL: SUBAGENTS_DOC_TARGET=$SUBAGENTS_DOC_TARGET, expected $TMPDIR5/agent/SUBAGENTS.md"; exit 1; }
echo "✅ PASS: SUBAGENTS_DOC_TARGET resolves to fake agent dir (no clobber)"

# Test T5.12: install_subagents_doc creates SUBAGENTS.md when missing
test ! -e "$SUBAGENTS_DOC_TARGET" \
  || { echo "❌ FAIL: pre-test: SUBAGENTS.md already exists at $SUBAGENTS_DOC_TARGET"; exit 1; }

install_subagents_doc

test -f "$SUBAGENTS_DOC_TARGET" \
  || { echo "❌ FAIL: install did not create SUBAGENTS.md"; exit 1; }
echo "✅ PASS: install_subagents_doc creates SUBAGENTS.md when missing"

# Test T5.13: content matches template byte-for-byte
diff -q "$SUBAGENTS_DOC_TEMPLATE" "$SUBAGENTS_DOC_TARGET" > /dev/null \
  || { echo "❌ FAIL: installed SUBAGENTS.md content mismatch"; diff "$SUBAGENTS_DOC_TEMPLATE" "$SUBAGENTS_DOC_TARGET" | head -10; exit 1; }
echo "✅ PASS: installed SUBAGENTS.md matches template byte-for-byte"

# Test T5.14: idempotent on re-install — file untouched
# (use byte hash of leading chunk so the assertion holds regardless of which
# phrases appear in any future revision of the doc)
INSTALL_HASH_PRE="$(head -c 1024 "$SUBAGENTS_DOC_TARGET" | md5sum)"
install_subagents_doc  # no FORCE → should skip
INSTALL_HASH_POST="$(head -c 1024 "$SUBAGENTS_DOC_TARGET" | md5sum)"
test "$INSTALL_HASH_PRE" = "$INSTALL_HASH_POST" \
  || { echo "❌ FAIL: re-install changed content (should be no-op)"; exit 1; }
echo "✅ PASS: install_subagents_doc is idempotent (no --force)"

# Test T5.15: FORCE overwrites our installed file (so install --force
# cleanly resets the doc)
FORCE=true install_subagents_doc
diff -q "$SUBAGENTS_DOC_TEMPLATE" "$SUBAGENTS_DOC_TARGET" > /dev/null \
  || { echo "❌ FAIL: FORCE=true did not restore template"; exit 1; }
echo "✅ PASS: FORCE=true install_subagents_doc overwrites our installed file"

# Test T5.16: uninstall removes file matching template (byte-identical)
uninstall_subagents_doc
test ! -f "$SUBAGENTS_DOC_TARGET" \
  || { echo "❌ FAIL: uninstall did not remove our-installed SUBAGENTS.md"; exit 1; }
echo "✅ PASS: uninstall_subagents_doc removes our-installed SUBAGENTS.md"

# Test T5.17: uninstall leaves user-customized SUBAGENTS.md alone
# Re-install via FORCE, then user customizes, then uninstall
FORCE=true install_subagents_doc
cat >> "$SUBAGENTS_DOC_TARGET" <<'USER_EOF'

<!-- user notes follow: ... -->
USER_EOF

uninstall_subagents_doc

test -f "$SUBAGENTS_DOC_TARGET" \
  || { echo "❌ FAIL: uninstall removed user-customized SUBAGENTS.md"; exit 1; }
grep -q "user notes follow" "$SUBAGENTS_DOC_TARGET" \
  || { echo "❌ FAIL: user content lost"; exit 1; }
echo "✅ PASS: uninstall_subagents_doc preserves user-customized SUBAGENTS.md"

# Cleanup test 5
rm -rf "$TMPDIR5"
unset PI_DIR AGENT_DIR
# ────────────────────────────────────────────────────────────
# Pi-semantic-nudge test block removed
#
# This block previously tested install/uninstall of `pi-semantic-nudge`,
# which was a local-peer npm package. It was removed from install.sh and
# replaced by `pi-magic-context` (npm:@cortexkit/pi-magic-context) — see
# the install.sh header comments and the structural + behavioral
# coverage of pi-magic-context's replacement (`install_pi_magic_context`,
# `install_magic_context_config`, etc.) higher up in this file.
#
# If pi-semantic-nudge ever returns, restore the block from git history
# (commit pre-magic-context migration).
# ────────────────────────────────────────────────────────────



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
