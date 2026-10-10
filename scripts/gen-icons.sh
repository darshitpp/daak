#!/usr/bin/env bash
#
# Draw every Daak icon file from the mark geometry. Needs Xcode (swift).
# The script writes only the named output paths in gen-icons.swift.
# The one temporary directory is the Swift module cache in the scratch path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${TMPDIR%/}/daak"
mkdir -p "$SCRATCH/modcache"
# Name each path. Do not use a glob. rmdir removes the scratch directory only
# when it is empty, so the files of another tool survive.
cleanup() {
  rm -rf "$SCRATCH/modcache"
  rmdir "$SCRATCH" 2>/dev/null || true
}
trap cleanup EXIT

CLANG_MODULE_CACHE_PATH="$SCRATCH/modcache" swift "$ROOT/scripts/gen-icons.swift" "$ROOT"
echo "gen-icons: done"
