#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ───────────────────────────────────────────────────────────
# ./scripts/test-npm-uninstall.sh   Remove the test install directory
# ─────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="$ROOT_DIR/.test-install-dir"

if [ ! -f "$MARKER" ]; then
  echo "No test installation found (.test-install-dir missing)."
  exit 0
fi

TEST_DIR=$(cat "$MARKER")

if [ ! -d "$TEST_DIR" ]; then
  echo "Directory already removed: $TEST_DIR"
  rm -f "$MARKER"
  exit 0
fi

echo "==> Removing test installation at $TEST_DIR ..."
rm -rf "$TEST_DIR"
rm -f "$MARKER"
echo "==> Done."
