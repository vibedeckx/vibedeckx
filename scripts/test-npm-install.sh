#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ───────────────────────────────────────────────────────────
# ./scripts/test-npm-install.sh              Build packages + test install
# ./scripts/test-npm-install.sh --skip-build Use existing dist-out/ packages
# ─────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT_DIR/packages/vibedeckx"
OUT_DIR="$ROOT_DIR/dist-out"

SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

VERSION=$(node -e "console.log(require('$PKG_DIR/package.json').version)")

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS" in
  linux)  PLATFORM_OS="linux" ;;
  darwin) PLATFORM_OS="darwin" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac
case "$ARCH" in
  x86_64)  PLATFORM_ARCH="x64" ;;
  aarch64|arm64) PLATFORM_ARCH="arm64" ;;
  *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
esac
PLATFORM="${PLATFORM_OS}-${PLATFORM_ARCH}"

WRAPPER_TGZ="$OUT_DIR/vibedeckx-${VERSION}.tgz"
PLATFORM_TGZ="$OUT_DIR/vibedeckx-${PLATFORM}-${VERSION}.tgz"

# ─── Build packages if needed ────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Building npm-platform packages..."
  "$ROOT_DIR/scripts/pack.sh" npm-platform
fi

# Verify packages exist
if [ ! -f "$WRAPPER_TGZ" ] || [ ! -f "$PLATFORM_TGZ" ]; then
  echo "ERROR: Missing packages. Expected:"
  echo "  $WRAPPER_TGZ"
  echo "  $PLATFORM_TGZ"
  echo "Run without --skip-build or run: ./scripts/pack.sh npm-platform"
  exit 1
fi

# ─── Install in temp directory ────────────────────────────────────────
TEST_DIR=$(mktemp -d)
echo ""
echo "==> Installing in $TEST_DIR ..."
cd "$TEST_DIR"
npm init -y > /dev/null 2>&1
npm install "$WRAPPER_TGZ" "$PLATFORM_TGZ" 2>&1 | tail -5

echo ""
echo "==> Verifying installation..."
echo "    Wrapper:  $(ls node_modules/vibedeckx/bin/vibedeckx.mjs 2>/dev/null && echo 'OK' || echo 'MISSING')"
echo "    Platform: $(ls node_modules/@vibedeckx/${PLATFORM}/dist/bin.js 2>/dev/null && echo 'OK' || echo 'MISSING')"

# Save test dir path for cleanup script
echo "$TEST_DIR" > "$ROOT_DIR/.test-install-dir"
echo ""
echo "==> Test directory preserved at: $TEST_DIR"
echo "    Run ./scripts/test-npm-uninstall.sh to clean up."

