#!/bin/sh
# CI, push to main: fail unless this push (BEFORE..HEAD) adds exactly one entry file to changelog/ and changes no other
# changelog file (docs/updater.md, #223). Usage: scripts/release/check-push.sh <before-sha>   (repo root, full history)
set -eu
BEFORE="${1:-}"
here=$(dirname "$0")
# The first push that brings the release check (no changelog.mjs before it) starts the history: nothing to compare with.
if [ -z "$BEFORE" ] || ! git cat-file -e "$BEFORE^{commit}" 2>/dev/null || ! git cat-file -e "$BEFORE:scripts/release/changelog.mjs" 2>/dev/null; then
  echo "no release check before this push: first release"
  exit 0
fi
exec node "$here/changelog.mjs" check "$BEFORE"
