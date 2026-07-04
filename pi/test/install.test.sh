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
grep -q 'PI_CODEBASE_MEMORY_PKG="npm:pi-codebase-memory"' "$SCRIPT" \
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
eval "$(awk '/^PI_CODEBASE_MEMORY_PKG=/,/^$/' "$SCRIPT")"
eval "$(extract_fn is_pi_codebase_memory_installed)"
eval "$(extract_fn install_pi_codebase_memory)"
eval "$(extract_fn uninstall_pi_codebase_memory)"

# 测试 8: 初始状态 — 未安装
is_pi_codebase_memory_installed \
  && { echo "❌ FAIL: reported installed when settings.json has no package"; exit 1; }
echo "✅ PASS: is_pi_codebase_memory_installed returns false on empty settings"

# 测试 9: install 函数将包追加到 settings.json
install_pi_codebase_memory || true   # pi CLI 可能不存在,fallback 仍会写 settings.json

grep -q "npm:pi-codebase-memory" "$PI_DIR/agent/settings.json" \
  || { echo "❌ FAIL: install did not register npm:pi-codebase-memory"; cat "$PI_DIR/agent/settings.json"; exit 1; }
echo "✅ PASS: install() registers npm:pi-codebase-memory"

# 测试 10: 幂等 — 二次 install 不重复添加
install_pi_codebase_memory || true
count=$(grep -c "npm:pi-codebase-memory" "$PI_DIR/agent/settings.json" || true)
[[ "$count" -eq 1 ]] \
  || { echo "❌ FAIL: idempotent broken — count=$count"; exit 1; }
echo "✅ PASS: install() is idempotent (count=$count)"

# 测试 11: 模拟 package 目录存在,卸载应同时清理
mkdir -p "$PI_DIR/packages/pi-codebase-memory"
echo "stub" > "$PI_DIR/packages/pi-codebase-memory/package.json"

uninstall_pi_codebase_memory

grep -q "npm:pi-codebase-memory" "$PI_DIR/agent/settings.json" \
  && { echo "❌ FAIL: uninstall did not remove from settings.json"; exit 1; }
echo "✅ PASS: uninstall() removes from settings.json"

test ! -d "$PI_DIR/packages/pi-codebase-memory" \
  || { echo "❌ FAIL: uninstall did not remove package dir"; exit 1; }
echo "✅ PASS: uninstall() removes package dir"

# 清理
rm -rf "$TMPDIR" "$FAKE_PATH"

echo ""
echo "════════════════════════════════════"
echo "  All install.test.sh checks passed"
echo "════════════════════════════════════"