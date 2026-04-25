#!/bin/bash
# End-to-End Test Script for Four Divine Agents Plugin
# Tests the complete workflow from design to execution

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="/tmp/sages-e2e-test-$$"

echo "=============================================="
echo "Four Divine Agents Plugin E2E Test"
echo "=============================================="
echo "Test Directory: $TEST_DIR"
echo ""

# Cleanup on exit
cleanup() {
    echo ""
    echo "Cleaning up..."
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Setup test project
echo "Step 1: Setting up test project..."
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Create a minimal project
echo "# Test Project" > README.md
mkdir -p src
echo 'console.log("hello");' > src/index.js

# Create opencode.json to load our plugin
if [ -f "$PROJECT_ROOT/dist/index.js" ]; then
    PLUGIN_PATH="file://$PROJECT_ROOT/dist/index.js"
elif [ -f "$PROJECT_ROOT/plugin/sages.ts" ]; then
    PLUGIN_PATH="file://$PROJECT_ROOT/plugin/sages.ts"
else
    echo "❌ Plugin file not found"
    exit 1
fi

cat > opencode.json << EOF
{
  "plugin": ["$PLUGIN_PATH"]
}
EOF

echo "✓ Test project created at $TEST_DIR"
echo "✓ Plugin configured: $PLUGIN_PATH"
echo ""

# Test 1: Initialize session
echo "Step 2: Testing sages_init..."
INIT_RESULT=$(cd "$PROJECT_ROOT" && bun bin/sages.ts tool sages_init --json '{"project_path": "'"$TEST_DIR"'"}' 2>&1)
if echo "$INIT_RESULT" | grep -q '"success":true'; then
    echo "✓ sages_init passed"
else
    echo "❌ sages_init failed"
    echo "$INIT_RESULT"
    exit 1
fi
echo ""

# Test 3: Create design draft
echo "Step 3: Testing fuxi_create_draft..."
DRAFT_RESULT=$(cd "$PROJECT_ROOT" && SAGES_PROJECT_DIR="$TEST_DIR" bun bin/sages.ts tool fuxi_create_draft --json '{"name": "hello-world", "request": "Create a simple hello world application"}' 2>&1)
if echo "$DRAFT_RESULT" | grep -q '"success":true'; then
    echo "✓ fuxi_create_draft passed"
else
    echo "❌ fuxi_create_draft failed"
    echo "$DRAFT_RESULT"
    exit 1
fi

# Verify draft file exists
if [ -f "$TEST_DIR/.plan/hello-world.draft.md" ]; then
    echo "✓ Draft file created: .plan/hello-world.draft.md"
else
    echo "❌ Draft file not found"
    exit 1
fi
echo ""

# Test 4: QiaoChui review
echo "Step 4: Testing qiaochui_review..."
REVIEW_RESULT=$(cd "$PROJECT_ROOT" && SAGES_PROJECT_DIR="$TEST_DIR" bun bin/sages.ts tool qiaochui_review --json '{"draft_path": "'"$TEST_DIR/.plan/hello-world.draft.md"'"}' 2>&1)
if echo "$REVIEW_RESULT" | grep -q '"success":true'; then
    echo "✓ qiaochui_review passed"
    if echo "$REVIEW_RESULT" | grep -q '"verdict":"APPROVED"'; then
        echo "✓ Design approved by QiaoChui"
    fi
else
    echo "❌ qiaochui_review failed"
    echo "$REVIEW_RESULT"
    exit 1
fi
echo ""

# Test 5: QiaoChui decompose
echo "Step 5: Testing qiaochui_decompose..."
DECOMPOSE_RESULT=$(cd "$PROJECT_ROOT" && SAGES_PROJECT_DIR="$TEST_DIR" bun bin/sages.ts tool qiaochui_decompose --json '{"draft_path": "'"$TEST_DIR/.plan/hello-world.draft.md"'"}' 2>&1)
if echo "$DECOMPOSE_RESULT" | grep -q '"success":true'; then
    echo "✓ qiaochui_decompose passed"
else
    echo "❌ qiaochui_decompose failed"
    echo "$DECOMPOSE_RESULT"
    exit 1
fi

# Verify plan and execution files exist
if [ -f "$TEST_DIR/.plan/hello-world.plan.md" ]; then
    echo "✓ Plan file created: .plan/hello-world.plan.md"
else
    echo "❌ Plan file not found"
    exit 1
fi

if [ -f "$TEST_DIR/.plan/hello-world.execution.yaml" ]; then
    echo "✓ Execution file created: .plan/hello-world.execution.yaml"
else
    echo "❌ Execution file not found"
    exit 1
fi
echo ""

# Test 6: LuBan execute task
echo "Step 6: Testing luban_execute_task..."
EXEC_RESULT=$(cd "$PROJECT_ROOT" && SAGES_PROJECT_DIR="$TEST_DIR" bun bin/sages.ts tool luban_execute_task --json '{"task_id": "T1", "task_description": "Add main function", "files": ["src/main.js"], "test_command": "echo test"}' 2>&1)
if echo "$EXEC_RESULT" | grep -q '"success":true'; then
    echo "✓ luban_execute_task passed"
else
    echo "❌ luban_execute_task failed"
    echo "$EXEC_RESULT"
    exit 1
fi
echo ""

# Test 7: GaoYao review
echo "Step 7: Testing gaoyao_review..."
GAOYAO_RESULT=$(cd "$PROJECT_ROOT" && SAGES_PROJECT_DIR="$TEST_DIR" bun bin/sages.ts tool gaoyao_review --json '{"plan_name": "hello-world", "review_mode": "quick"}' 2>&1)
if echo "$GAOYAO_RESULT" | grep -q '"success":true'; then
    echo "✓ gaoyao_review passed"
else
    echo "❌ gaoyao_review failed"
    echo "$GAOYAO_RESULT"
    exit 1
fi
echo ""

# Test 8: Workflow state
echo "Step 8: Testing sages_get_workflow_state..."
WORKFLOW_RESULT=$(cd "$PROJECT_ROOT" && SAGES_PROJECT_DIR="$TEST_DIR" bun bin/sages.ts tool sages_get_workflow_state --json '{"plan_name": "hello-world"}' 2>&1)
if echo "$WORKFLOW_RESULT" | grep -q '"success":true'; then
    echo "✓ sages_get_workflow_state passed"
else
    echo "❌ sages_get_workflow_state failed"
    echo "$WORKFLOW_RESULT"
    exit 1
fi
echo ""

# Test 9: Confirm approval
echo "Step 9: Testing sages_confirm_approval..."
APPROVE_RESULT=$(cd "$PROJECT_ROOT" && SAGES_PROJECT_DIR="$TEST_DIR" bun bin/sages.ts tool sages_confirm_approval --json '{"plan_name": "hello-world", "confirmed": true}' 2>&1)
if echo "$APPROVE_RESULT" | grep -q '"success":true'; then
    echo "✓ sages_confirm_approval passed"
else
    echo "❌ sages_confirm_approval failed"
    echo "$APPROVE_RESULT"
    exit 1
fi
echo ""

# Summary
echo "=============================================="
echo "✅ ALL E2E TESTS PASSED"
echo "=============================================="
echo ""
echo "Workflow tested:"
echo "  1. ✓ Initialize session"
echo "  2. ✓ Create design draft"
echo "  3. ✓ QiaoChui review"
echo "  4. ✓ QiaoChui decompose"
echo "  5. ✓ LuBan execute task"
echo "  6. ✓ GaoYao review"
echo "  7. ✓ Get workflow state"
echo "  8. ✓ Confirm approval"
echo ""
echo "Files created:"
ls -la "$TEST_DIR/.plan/" 2>/dev/null || true