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

# ────────────────────────────────────────────────────────────
# pi-serena tests (新增于 2026-07-14)
# 验证: pi-serena 跟 pi-codebase-memory 一样被安装/卸载, 且会写 mcp.json
# ────────────────────────────────────────────────────────────

# 测试 12: PI_SERENA 常量定义
grep -q 'PI_SERENA_PKG="file:' "$SCRIPT" \
  || { echo "❌ FAIL: PI_SERENA_PKG constant missing or wrong"; exit 1; }
echo "✅ PASS: PI_SERENA_PKG constant defined"

# 测试 13: pi-serena 三个函数均已定义
for fn in is_pi_serena_installed install_pi_serena uninstall_pi_serena install_serena_files write_serena_mcp_config; do
  grep -qE "^${fn}\(\) \{$" "$SCRIPT" \
    || { echo "❌ FAIL: function $fn not defined"; exit 1; }
done
echo "✅ PASS: 5 pi-serena functions defined"

# 测试 14: install() 流程包含 install_pi_serena
sed -n '/^install() {/,/^}$/p' "$SCRIPT" | grep -q "install_pi_serena" \
  || { echo "❌ FAIL: install() does not call install_pi_serena"; exit 1; }
echo "✅ PASS: install() invokes install_pi_serena"

# 测试 15: uninstall() 流程包含 uninstall_pi_serena
sed -n '/^uninstall() {/,/^}$/p' "$SCRIPT" | grep -q "uninstall_pi_serena" \
  || { echo "❌ FAIL: uninstall() does not call uninstall_pi_serena"; exit 1; }
echo "✅ PASS: uninstall() invokes uninstall_pi_serena"

# 测试 16: 加载并执行 pi-serena 函数 (需要模拟 pi-serena/ 已存在于 TMP)
# 准备一个模拟的 pi-serena/ 目录,复制真实的模板以验证内容
PI_SERENA_MOCK="$TMPDIR/pi-serena"
mkdir -p "$PI_SERENA_MOCK/templates"
REAL_TEMPLATE="$(cd "$(dirname "$SCRIPT")/../.." && pwd)/pi-serena/templates/mcp.json"
if [[ -f "$REAL_TEMPLATE" ]]; then
  cp "$REAL_TEMPLATE" "$PI_SERENA_MOCK/templates/mcp.json"
else
  echo "❌ FAIL: real template not found at $REAL_TEMPLATE"
  exit 1
fi
mkdir -p "$PI_SERENA_MOCK/src"
echo "export default function(){}" > "$PI_SERENA_MOCK/src/index.ts"

# 加载新增的函数 (用 awk 提取 + 写到文件 + source)
# 避免 eval 的双重变量展开问题
AGENT_DIR="$PI_DIR/agent"
# 提取常量
{
  awk '/^PI_SERENA_SRC_REL=/,/^$/' "$SCRIPT"
  awk '/^PI_SERENA_DEST_DIR=/,/^$/' "$SCRIPT"
  awk '/^PI_SERENA_MCP_JSON=/,/^$/' "$SCRIPT"
  awk '/^PI_SERENA_PKG=/,/^$/' "$SCRIPT"
  for fn in is_pi_serena_installed install_pi_serena uninstall_pi_serena install_serena_files write_serena_mcp_config; do
    extract_fn "$fn"
  done
} > "$TMPDIR/pi-serena-fns.sh"
# shellcheck disable=SC1090
source "$TMPDIR/pi-serena-fns.sh"

# 手动 inject TMP_DIR 模拟 git clone 后的目录
TMP_DIR="$TMPDIR"

# 测试 17: 初始状态 — is_pi_serena_installed 返回 false
is_pi_serena_installed \
  && { echo "❌ FAIL: reported installed when settings.json has no pi-serena"; exit 1; }
echo "✅ PASS: is_pi_serena_installed returns false on empty settings"

# 测试 17b: is_pi_serena_installed 对 substring 名字(如 pi-serena-extras)不误判
# 模拟用户装了 pi-serena-extras(虚构包),应仍返回 false
python3 -c "
import json
f = '$PI_DIR/agent/settings.json'
d = {'packages': ['npm:pi-serena-extras', 'pi-serena-fork']}
json.dump(d, open(f, 'w'))
"
is_pi_serena_installed \
  && { echo "❌ FAIL: substring name 'pi-serena-extras' misdetected as pi-serena"; exit 1; } \
  || echo "✅ PASS: is_pi_serena_installed does not match substring names"

# 测试 17c: is_pi_serena_installed 对 exact match 正确识别
python3 -c "
import json
f = '$PI_DIR/agent/settings.json'
d = {'packages': ['file:$PI_SERENA_DEST_DIR']}
json.dump(d, open(f, 'w'))
"
is_pi_serena_installed \
  && echo "✅ PASS: is_pi_serena_installed matches file: prefix exact path" \
  || { echo "❌ FAIL: should match 'file:' prefixed path"; exit 1; }

# 测试 17d: uninstall 不误伤 substring name
python3 -c "
import json
f = '$PI_DIR/agent/settings.json'
d = {'packages': ['file:$PI_SERENA_DEST_DIR', 'npm:pi-serena-extras', 'pi-serena-fork']}
json.dump(d, open(f, 'w'))
"
uninstall_pi_serena
REMAINING=$(python3 -c "import json; d=json.load(open('$PI_DIR/agent/settings.json')); print(','.join(d.get('packages',[])))")
echo "  After uninstall, packages: $REMAINING"
echo "$REMAINING" | grep -q "pi-serena-extras" \
  && echo "✅ PASS: uninstall did not remove pi-serena-extras" \
  || { echo "❌ FAIL: uninstall incorrectly removed substring names"; exit 1; }
echo "$REMAINING" | grep -q "pi-serena-fork" \
  && echo "✅ PASS: uninstall did not remove pi-serena-fork" \
  || { echo "❌ FAIL: uninstall incorrectly removed substring names"; exit 1; }

# 测试 18: install_serena_files 从 TMP_DIR/pi-serena 复制到 PI_DIR/packages/pi-serena
install_serena_files || { echo "❌ FAIL: install_serena_files failed"; exit 1; }
test -d "$PI_SERENA_DEST_DIR" \
  || { echo "❌ FAIL: $PI_SERENA_DEST_DIR not created"; exit 1; }
test -f "$PI_SERENA_DEST_DIR/templates/mcp.json" \
  || { echo "❌ FAIL: templates/mcp.json not copied"; exit 1; }
echo "✅ PASS: install_serena_files copies pi-serena/ to PI_DIR/packages/pi-serena/"

# 测试 19: write_serena_mcp_config 写 mcp.json 到 PI_DIR/agent/mcp.json
write_serena_mcp_config
test -f "$PI_SERENA_MCP_JSON" \
  || { echo "❌ FAIL: $PI_SERENA_MCP_JSON not written"; exit 1; }
python3 -c "
import json
d = json.load(open('$PI_SERENA_MCP_JSON'))
assert 'serena' in d.get('mcpServers', {}), 'serena server missing in mcp.json'
serena = d['mcpServers']['serena']
assert '--enable-web-dashboard' in serena.get('args', []), 'silent flag missing'
assert 'execute_shell_command' in serena.get('excludeTools', []), 'exclude rule missing'
" || { echo "❌ FAIL: mcp.json content invalid"; exit 1; }
echo "✅ PASS: write_serena_mcp_config writes valid mcp.json with silent mode + exclude"

# 测试 20: 幂等 — 二次 write_serena_mcp_config 不覆盖 (因为文件已存在)
ORIG_CONTENT=$(cat "$PI_SERENA_MCP_JSON")
echo "{\"modified_by_user\":true}" > "$PI_SERENA_MCP_JSON"  # user 改过了
write_serena_mcp_config
MODIFIED_CONTENT=$(cat "$PI_SERENA_MCP_JSON")
[[ "$MODIFIED_CONTENT" == '{"modified_by_user":true}' ]] \
  || { echo "❌ FAIL: write_serena_mcp_config overwrote user-customized mcp.json"; exit 1; }
echo "$ORIG_CONTENT" > "$PI_SERENA_MCP_JSON"  # restore
echo "✅ PASS: write_serena_mcp_config respects user-customized mcp.json (idempotent)"

# 测试 21: uninstall_pi_serena 清理物理目录 (settings.json 还没注册 pi-serena 时)
uninstall_pi_serena
test ! -d "$PI_SERENA_DEST_DIR" \
  || { echo "❌ FAIL: uninstall did not remove $PI_SERENA_DEST_DIR"; exit 1; }
echo "✅ PASS: uninstall_pi_serena removes package dir"

# 测试 22: install_pi_serena 幂等 — 已注册时不会重跑 install_serena_files
# setup: 模拟 "已安装" 状态 (settings.json 已有 pi-serena, PI_SERENA_DEST_DIR 已有内容)
mkdir -p "$PI_SERENA_DEST_DIR"
# 在 PI_SERENA_DEST_DIR 写个 marker 文件, 验证 install 时不会被覆盖
MARKER="$PI_SERENA_DEST_DIR/INSTALL_MARKER"
echo "originally installed" > "$MARKER"
sleep 1
# 手动注册到 settings.json
python3 -c "
import json
f = '$PI_DIR/agent/settings.json'
d = {'packages': ['$PI_SERENA_PKG']}
json.dump(d, open(f, 'w'))
"

# 调 install_pi_serena — 应走幂等分支, 不重跑 install_serena_files
OUTPUT=$(install_pi_serena 2>&1)
echo "$OUTPUT" | grep -q "already installed" \
  && echo "✅ PASS: install_pi_serena is idempotent (prints 'already installed')" \
  || { echo "❌ FAIL: install_pi_serena did not detect already-installed state. Output: $OUTPUT"; exit 1; }

# 验证 marker 文件未被覆盖 (说明 install_serena_files 没被调用)
[[ -f "$MARKER" ]] && grep -q "originally installed" "$MARKER" \
  && echo "✅ PASS: install_serena_files NOT re-run on idempotent install (marker preserved)" \
  || { echo "❌ FAIL: install_serena_files was re-run (marker overwritten)"; exit 1; }

# 清理
rm -rf "$TMPDIR" "$FAKE_PATH"

echo ""
echo "════════════════════════════════════"
echo "  All install.test.sh checks passed"
echo "════════════════════════════════════"