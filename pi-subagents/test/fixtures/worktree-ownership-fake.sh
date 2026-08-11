#!/usr/bin/env bash
set -euo pipefail

base_dir="$1"
repo_root="$base_dir/repo"
foreign_root="$base_dir/foreign"
foreign_worktree="$base_dir/foreign-worktree"

mkdir -p "$base_dir"
git init --quiet --initial-branch=main "$repo_root"
git -C "$repo_root" config user.name "Ownership Fixture"
git -C "$repo_root" config user.email "ownership-fixture@example.invalid"
git -C "$repo_root" config commit.gpgsign false
git -C "$repo_root" commit --quiet --allow-empty -m "fixture: seed"
git clone --quiet "$repo_root" "$foreign_root"
git -C "$foreign_root" worktree add --quiet --detach "$foreign_worktree" HEAD

printf '%s\n%s\n%s\n' "$repo_root" "$foreign_root" "$foreign_worktree"
