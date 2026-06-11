#!/usr/bin/env bash
# T10: End-to-end smoke test
#
# Validates:
# 1. install.sh runs clean on a fresh state
# 2. typecheck passes (tsc --noEmit)
# 3. all bun tests pass
# 4. SKILL.md is present
# 5. extensions/yunxiao-extension.ts is valid TS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_DIR"

echo "════════════════════════════════════════════"
echo "  T10 smoke test"
echo "════════════════════════════════════════════"

echo ""
echo "▶ 1. Check required files exist"
for f in \
  package.json \
  tsconfig.json \
  src/index.ts \
  src/tools/index.ts \
  src/tools/mcp-server.ts \
  src/tools/mcp-call.ts \
  src/tools/high-level/branch.ts \
  src/tools/high-level/task.ts \
  src/tools/high-level/subtask.ts \
  src/tools/high-level/bug.ts \
  src/tools/high-level/change-request.ts \
  src/tools/high-level/pipeline.ts \
  src/services/mcp-server-manager.ts \
  src/services/token-store.ts \
  src/services/repo-resolver.ts \
  src/services/response-parser.ts \
  src/services/config.ts \
  src/utils/flock.ts \
  src/utils/logger.ts \
  src/utils/env-detect.ts \
  src/state/types.ts \
  extensions/yunxiao-extension.ts \
  skills/yunxiao/SKILL.md \
  skills/yunxiao/references/tool-catalog.md \
  skills/yunxiao/references/patterns.md \
  skills/yunxiao/references/troubleshooting.md \
  prompts/yunxiao-quickstart.md \
  scripts/install.sh \
  test/install.test.sh \
; do
  if [[ ! -f "$f" ]]; then
    echo "  ❌ MISSING: $f"
    exit 1
  fi
done
echo "  ✅ All $(echo 'package.json tsconfig.json src/index.ts src/tools/index.ts src/tools/mcp-server.ts src/tools/mcp-call.ts src/tools/high-level/branch.ts src/tools/high-level/task.ts src/tools/high-level/subtask.ts src/tools/high-level/bug.ts src/tools/high-level/change-request.ts src/tools/high-level/pipeline.ts src/services/mcp-server-manager.ts src/services/token-store.ts src/services/repo-resolver.ts src/services/response-parser.ts src/services/config.ts src/utils/flock.ts src/utils/logger.ts src/utils/env-detect.ts src/state/types.ts extensions/yunxiao-extension.ts skills/yunxiao/SKILL.md skills/yunxiao/references/tool-catalog.md skills/yunxiao/references/patterns.md skills/yunxiao/references/troubleshooting.md prompts/yunxiao-quickstart.md scripts/install.sh test/install.test.sh' | wc -w) required files present"

echo ""
echo "▶ 2. Typecheck (tsc --noEmit)"
if npx tsc --noEmit 2>&1 | head -5; then
  echo "  ✅ typecheck clean"
else
  echo "  ❌ typecheck failed"
  exit 1
fi

echo ""
echo "▶ 3. Unit tests (bun test)"
set +e
bun test 2>&1 | tail -8
TEST_EXIT=${PIPESTATUS[0]}
set -e
if [[ $TEST_EXIT -eq 0 ]]; then
  echo "  ✅ all unit tests pass"
else
  echo "  ❌ tests failed (exit $TEST_EXIT)"
  exit 1
fi

echo ""
echo "▶ 4. install.sh syntax check"
bash -n scripts/install.sh && echo "  ✅ install.sh syntax OK"
bash -n scripts/install-mcp-server.sh && echo "  ✅ install-mcp-server.sh syntax OK"

echo ""
echo "▶ 5. End-to-end install test (in temp PI_DIR)"
TMP_PI=$(mktemp -d)
"$PKG_DIR/scripts/install.sh" --prefix "$TMP_PI" 2>&1 | tail -3
test -d "$TMP_PI/packages/yunxiao/prompts" || { echo "  ❌ prompts not installed"; exit 1; }
test -d "$TMP_PI/packages/yunxiao/src" || { echo "  ❌ src not installed"; exit 1; }
test -d "$TMP_PI/packages/yunxiao/extensions" || { echo "  ❌ extensions not installed"; exit 1; }
test -d "$TMP_PI/packages/yunxiao/skills" || { echo "  ❌ skills not installed"; exit 1; }
test ! -d "$TMP_PI/packages/yunxiao/scripts" || { echo "  ❌ scripts should NOT be installed (decision C)"; exit 1; }
grep -q "yunxiao" "$TMP_PI/agent/settings.json" || { echo "  ❌ settings.json not registered"; exit 1; }
"$PKG_DIR/scripts/install.sh" --uninstall --prefix "$TMP_PI" 2>&1 | tail -1
rm -rf "$TMP_PI"
echo "  ✅ install.sh end-to-end works"

echo ""
echo "════════════════════════════════════════════"
echo "  ✅ ALL SMOKE CHECKS PASSED"
echo "════════════════════════════════════════════"
