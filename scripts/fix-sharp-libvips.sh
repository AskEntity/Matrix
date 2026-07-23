#!/usr/bin/env bash
# Fix sharp's libvips discovery in Bun's global cache layout.
#
# Problem: @huggingface/transformers depends on sharp, which loads libvips
# from @img/sharp-libvips-<platform>. Bun's global cache stores the package
# at a versioned path (@1.2.4@@@1), but sharp's loader looks for it at the
# unversioned path. The fix is a symlink from the unversioned `lib/` to the
# versioned one.
#
# This script is idempotent — safe to run on every `bun install`.

set -euo pipefail

# Detect platform
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PKG="sharp-libvips-darwin-arm64" ;;
  Darwin-x86_64) PKG="sharp-libvips-darwin-x64" ;;
  Linux-x86_64) PKG="sharp-libvips-linux-x64" ;;
  Linux-aarch64) PKG="sharp-libvips-linux-arm64" ;;
  *) echo "[fix-sharp-libvips] unsupported platform $(uname -s)-$(uname -m), skipping"; exit 0 ;;
esac

BUN_CACHE="${BUN_INSTALL:-$HOME/.bun}/install/cache/@img/$PKG"

# Find the versioned directory (e.g. @img/sharp-libvips-darwin-arm64/1.2.4@@@1/lib)
VERSIONED_DIR=""
for d in "$BUN_CACHE"/*@@@*/lib; do
  if [ -d "$d" ]; then
    VERSIONED_DIR="$d"
    break
  fi
done

if [ -z "$VERSIONED_DIR" ]; then
  echo "[fix-sharp-libvips] no versioned libvips found in $BUN_CACHE, skipping"
  exit 0
fi

TARGET="$BUN_CACHE/lib"

# Already correct symlink?
if [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$VERSIONED_DIR" ]; then
  : # skip
else
  # Create or update the symlink
  mkdir -p "$BUN_CACHE"
  rm -f "$TARGET"
  ln -sf "$VERSIONED_DIR" "$TARGET"
  echo "[fix-sharp-libvips] linked $TARGET → $VERSIONED_DIR"
fi

# Fix 2: nested node_modules path (worker threads load sharp from here).
# @huggingface/transformers → sharp → @img/sharp-darwin-arm64 expects
# @img/sharp-libvips-<platform> as a sibling, but it's not installed there.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
NESTED="$PROJECT_ROOT/node_modules/@huggingface/transformers/node_modules/sharp/node_modules/@img/$PKG"

if [ -d "$PROJECT_ROOT/node_modules/@huggingface/transformers/node_modules/sharp/node_modules/@img" ]; then
  # Find a source libvips lib dir (prefer top-level node_modules)
  SOURCE_LIB=""
  for candidate in \
    "$PROJECT_ROOT/node_modules/@img/$PKG/lib" \
    "$PROJECT_ROOT/node_modules/sharp/node_modules/@img/$PKG/lib"; do
    if [ -d "$candidate" ]; then
      SOURCE_LIB="$candidate"
      break
    fi
  done

  if [ -n "$SOURCE_LIB" ] && [ ! -e "$NESTED/lib" ]; then
    mkdir -p "$NESTED"
    ln -sf "$SOURCE_LIB" "$NESTED/lib"
    echo "[fix-sharp-libvips] linked nested $NESTED/lib → $SOURCE_LIB"
  fi
fi
