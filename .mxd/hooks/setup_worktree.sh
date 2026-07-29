#!/bin/bash
# Runs once per agent worktree, immediately after `git worktree add`.
# $1 is the new worktree's root. Non-zero exit rolls the worktree back.
set -e
cd "$1"

# node_modules is .gitignore'd, so a fresh worktree has none.
bun install --frozen-lockfile

# Git hooks for this worktree. `.hooks/worktree` holds prepare-commit-msg and
# nothing else — it stamps `Task-Id: <matrix.taskId>` on every commit made here,
# which is what lets `git blame` reach the task that wrote a line.
#
# Deliberately NOT `.hooks` itself: that directory also holds pre-commit
# (typecheck + a test subset), and agents commit far too often to gate every
# one of them. Recording provenance and gating a commit are different jobs;
# whether the lint gate should come back to worktrees is a separate decision.
git config --worktree core.hooksPath "$1/.hooks/worktree"
