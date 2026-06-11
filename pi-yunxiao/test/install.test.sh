#!/usr/bin/env bash
# T1: install.sh 行为测试
# 验证：选择性 cp-r 到 ~/.pi/packages/yunxiao/，settings.json 注册 idempotent
set -euo pipefail

# 准备临时 PI_DIR 隔离
export PI_DIR="$(mktemp -d)"
export PKG_DIR="$PI_DIR/packages/yunxiao"
export SETTINGS="$PI_DIR/agent/settings.json"

# 测试 1: install.sh 存在且可执行
test -x "./scripts/install.sh" || { echo "❌ FAIL: install.sh not executable"; exit 1; }
echo "✅ PASS: install.sh exists and is executable"

# 测试 2: install.sh 创建目标子目录
./scripts/install.sh --prefix "$PI_DIR" 2>&1 | tail -5
for d in prompts skills extensions src; do
  test -d "$PKG_DIR/$d" || { echo "❌ FAIL: $d not created"; exit 1; }
done
echo "✅ PASS: 4 subdirs created"

# 测试 3: package.json 拷贝
test -f "$PKG_DIR/package.json" || { echo "❌ FAIL: package.json missing"; exit 1; }
echo "✅ PASS: package.json copied"

# 测试 4: settings.json 注册 idempotent
test -f "$SETTINGS" || { echo "❌ FAIL: settings.json not created"; exit 1; }
grep -q "$PKG_DIR" "$SETTINGS" || { echo "❌ FAIL: yunxiao not in settings.json"; exit 1; }
echo "✅ PASS: settings.json registered"

# 测试 5: 二次运行无副作用（idempotent）
./scripts/install.sh --prefix "$PI_DIR" 2>&1 | tail -3
grep -q "$PKG_DIR" "$SETTINGS" || { echo "❌ FAIL: 2nd run broke settings"; exit 1; }
echo "✅ PASS: idempotent"

# 测试 6: --uninstall 清理
./scripts/install.sh --uninstall --prefix "$PI_DIR" 2>&1 | tail -3
test ! -d "$PKG_DIR" || { echo "❌ FAIL: --uninstall didn't remove $PKG_DIR"; exit 1; }
echo "✅ PASS: --uninstall works"

# 清理
rm -rf "$PI_DIR"

echo ""
echo "════════════════════════════════════"
echo "  All 6 install.test.sh checks passed"
echo "════════════════════════════════════"
