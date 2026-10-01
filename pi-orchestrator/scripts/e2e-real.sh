#!/usr/bin/env bash
# e2e-real.sh — GC-2026-real-e2e
#
# Bootstrap a real test repo + goal contract for the workflow_run
# end-to-end test. Companion to docs/e2e-real.md.
#
# Usage:
#   bash pi-orchestrator/scripts/e2e-real.sh setup <target-dir>
#     Creates <target-dir>/.pi/orchestrator/goal-GC-e2e-real.yaml
#     and initializes a git repo with an initial commit on `main`.
#
#   bash pi-orchestrator/scripts/e2e-real.sh verify <target-dir>
#     Inspects the post-run artifacts in <target-dir>:
#     git log --graph, files created, workflow-{id}.yaml, etc.
#     Exits 0 if all expected artifacts are present and consistent.
#
#   bash pi-orchestrator/scripts/e2e-real.sh teardown <target-dir>
#     Removes <target-dir> and all worktrees.
#
# GC-2026-real-e2e adds this script; no production code paths
# depend on it. Designed for manual invocation by an LLM or human
# running docs/e2e-real.md.

set -euo pipefail

usage_help() {
    sed -n '2,30p' "$0" | sed 's/^# \?//'
    exit 1
}

goal_id="GC-e2e-real"
goal_filename="goal-${goal_id}.yaml"

goal_template() {
cat <<'EOF'
id: GC-e2e-real
title: "Add `src/util/hello.ts` exporting hello(name: string): string"
rationale: |
  Smoke-test the full workflow_run pipeline (Implement → Review → Merge)
  end-to-end against real subagents. The goal must be small enough to
  complete in <30 min, isolated enough to review cleanly, and trivial
  enough to merge without conflicts.
anti_goals:
  - do not modify any file outside the listed scope
  - do not add new dependencies (keep `package.json` untouched)
  - do not change any existing file except as listed in scope
scope:
  include:
    - src/util/hello.ts
    - test/util/hello.test.ts
  exclude:
    - node_modules/
    - package.json
    - bun.lock
constraints:
  typecheck_required: true
  lint_required: false
  must_use_existing_patterns: true
done_definition: |
  `src/util/hello.ts` exports a typed `hello(name: string): string`
  function that returns `"Hello, {name}!"`. A test file at
  `test/util/hello.test.ts` has at least one passing test for the
  default name and at least one for a non-default name. `bun test`
  passes; `bun run typecheck` reports zero errors.
EOF
}

cmd_setup() {
    local target_dir="${1:-}"
    if [ -z "$target_dir" ]; then
        echo "ERROR: missing target directory" >&2
        usage_help
    fi

    if [ -e "$target_dir" ]; then
        echo "ERROR: $target_dir already exists; refusing to clobber." >&2
        exit 1
    fi

    mkdir -p "$target_dir/.pi/orchestrator"

    cd "$target_dir"
    git init -q
    git checkout -q -b main

    # Configure a local user so commits work. This is a sandbox repo;
    # we never push these credentials anywhere.
    git config user.name "Sages E2E Test"
    git config user.email "e2e-real@sages.local"

    # Initial commit so the Merger has something to merge into.
    echo "# Sages E2E Real Test Repo" > README.md
    git add README.md
    git commit -q -m "chore(e2e-real): initial commit"

    goal_template > ".pi/orchestrator/${goal_filename}"

    echo "✅ Test repo ready at: $target_dir"
    echo "   branch: main (1 initial commit)"
    echo "   goal:   .pi/orchestrator/${goal_filename}"
    echo
    echo "Next steps: see docs/e2e-real.md"
    echo "   1. cd $target_dir"
    echo "   2. In a pi session: workflow_run({ goal_path: '.pi/orchestrator/${goal_filename}' })"
    echo "   3. bash scripts/e2e-real.sh verify $target_dir"
}

cmd_verify() {
    local target_dir="${1:-}"
    if [ -z "$target_dir" ] || [ ! -d "$target_dir" ]; then
        echo "ERROR: missing or invalid target directory" >&2
        usage_help
    fi

    cd "$target_dir"
    echo "=== git log --graph ==="
    git log --graph --oneline --all | head -20 || echo "no commits"
    echo
    echo "=== branches ==="
    git branch -a
    echo
    echo "=== HEAD files (top level) ==="
    git ls-tree -r HEAD --name-only | head -20
    echo
    echo "=== workflow-${goal_id}.yaml ==="
    if [ -f ".pi/orchestrator/workflow-${goal_id}.yaml" ]; then
        cat ".pi/orchestrator/workflow-${goal_id}.yaml"
    else
        echo "MISSING — workflow_run was never run, or state file not written"
        return 1
    fi
    echo
    echo "=== worktree state ==="
    if [ -d ".pi/worktree" ] && [ -n "$(ls -A .pi/worktree 2>/dev/null)" ]; then
        ls -la .pi/worktree/
    else
        echo "clean (Merger cleaned up the worktree, as expected)"
    fi
    echo
    echo "=== file check: src/util/hello.ts ==="
    if [ -f "src/util/hello.ts" ]; then
        echo "present:"
        cat src/util/hello.ts
    else
        echo "MISSING — Implement phase didn't write the file"
        return 1
    fi
    echo
    echo "=== file check: test/util/hello.test.ts ==="
    if [ -f "test/util/hello.test.ts" ]; then
        echo "present:"
        cat test/util/hello.test.ts
    else
        echo "MISSING — Implement phase didn't write the test file"
        return 1
    fi
    echo
    echo "✅ All expected artifacts present"
}

cmd_teardown() {
    local target_dir="${1:-}"
    if [ -z "$target_dir" ]; then
        echo "ERROR: missing target directory" >&2
        usage_help
    fi

    if [ ! -d "$target_dir" ]; then
        echo "nothing to do; $target_dir does not exist"
        return 0
    fi

    # Clean any remaining worktrees before rm.
    cd "$target_dir"
    git worktree list --porcelain | awk '/^worktree / {print $2}' | while read -r wt; do
        if [ "$wt" != "$target_dir" ]; then
            git worktree remove --force "$wt" 2>/dev/null || true
        fi
    done
    git worktree prune --verbose 2>&1 || true

    rm -rf "$target_dir"
    echo "✅ Removed $target_dir"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    setup)     cmd_setup "${1:-}" ;;
    verify)    cmd_verify "${1:-}" ;;
    teardown)  cmd_teardown "${1:-}" ;;
    help|--help|-h|"") usage_help ;;
    *) echo "ERROR: unknown command: $cmd" >&2; usage_help ;;
esac