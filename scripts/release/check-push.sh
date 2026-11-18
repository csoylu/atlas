#!/bin/sh
# CI, push to main: fail unless this push (BEFORE..HEAD) adds exactly one CHANGELOG.md entry on top (docs/updater.md).
# Usage: scripts/release/check-push.sh <before-sha>   (run from the repo root, full history fetched)
set -eu
BEFORE="${1:-}"
here=$(dirname "$0")
# The first push that brings this check (no changelog.mjs before it) starts the history: nothing to compare with.
if [ -z "$BEFORE" ] || ! git cat-file -e "$BEFORE^{commit}" 2>/dev/null || ! git cat-file -e "$BEFORE:scripts/release/changelog.mjs" 2>/dev/null; then
  echo "no release check before this push: first release"
  exit 0
fi
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
if git cat-file -e "$BEFORE:CHANGELOG.md" 2>/dev/null; then
  git show "$BEFORE:CHANGELOG.md" > "$tmp"
  exec node "$here/changelog.mjs" check "$tmp" CHANGELOG.md
fi
exec node "$here/changelog.mjs" check - CHANGELOG.md
