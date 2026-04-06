#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ───────────────────────────────────────────────────────────
# ./scripts/pack.sh              Build both npm pack + platform archive
# ./scripts/pack.sh npm          Build npm pack only
# ./scripts/pack.sh platform     Build platform archive only
# ./scripts/pack.sh --skip-build Skip pnpm build (use existing dist/)
# ─────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT_DIR/packages/vibedeckx"
OUT_DIR="$ROOT_DIR/dist-out"

SKIP_BUILD=false
MODE="all"  # all | npm | platform

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    npm)          MODE="npm" ;;
    platform)     MODE="platform" ;;
    *)            echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Read version from package.json
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

echo "==> Version: $VERSION | Platform: $PLATFORM"

# ─── Build ───────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Running pnpm build..."
  cd "$ROOT_DIR"
  pnpm build
else
  echo "==> Skipping build (--skip-build)"
  if [ ! -d "$PKG_DIR/dist" ]; then
    echo "ERROR: $PKG_DIR/dist not found. Run pnpm build first."
    exit 1
  fi
fi

mkdir -p "$OUT_DIR"

# ─── npm pack ────────────────────────────────────────────────────────
if [ "$MODE" = "all" ] || [ "$MODE" = "npm" ]; then
  echo ""
  echo "==> Creating npm pack..."
  cd "$PKG_DIR"
  NPM_TGZ=$(npm pack --pack-destination "$OUT_DIR" 2>&1 | tail -1)
  echo "    Output: $OUT_DIR/$NPM_TGZ"
fi

# ─── Platform archive ───────────────────────────────────────────────
if [ "$MODE" = "all" ] || [ "$MODE" = "platform" ]; then
  echo ""
  echo "==> Creating platform archive ($PLATFORM)..."

  ARCHIVE_NAME="vibedeckx-${VERSION}-${PLATFORM}"
  STAGING="$OUT_DIR/staging/${ARCHIVE_NAME}"

  # Clean previous staging
  rm -rf "$OUT_DIR/staging"
  mkdir -p "$STAGING"

  # Copy dist (esbuild bundle + UI)
  cp -r "$PKG_DIR/dist" "$STAGING/"

  # Copy platform package.json (has native module dependencies)
  cp "$ROOT_DIR/packages/vibedeckx-${PLATFORM}/package.json" "$STAGING/"

  # Install native module dependencies and rebuild
  echo "    Installing native module dependencies..."
  cd "$STAGING"
  npm install --ignore-scripts --legacy-peer-deps 2>&1 | tail -3
  echo "    Rebuilding native modules (better-sqlite3, node-pty)..."
  npm rebuild better-sqlite3 node-pty 2>&1 | tail -5

  # Patch native module package.json: set files to runtime-only, inject bin for npx
  node -e "
    const fs = require('fs');
    const platform = '${PLATFORM}';

    const pty = JSON.parse(fs.readFileSync('node_modules/node-pty/package.json', 'utf8'));
    delete pty.scripts;
    delete pty.gypfile;
    delete pty.dependencies;
    pty.files = ['lib/', 'prebuilds/' + platform + '/'];
    fs.writeFileSync('node_modules/node-pty/package.json', JSON.stringify(pty, null, 2) + '\n');

    const bs3 = JSON.parse(fs.readFileSync('node_modules/better-sqlite3/package.json', 'utf8'));
    delete bs3.scripts;
    delete bs3.gypfile;
    bs3.dependencies = { bindings: '*' };
    bs3.files = ['lib/', 'build/Release/better_sqlite3.node'];
    fs.writeFileSync('node_modules/better-sqlite3/package.json', JSON.stringify(bs3, null, 2) + '\n');

    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.name = 'vibedeckx';
    pkg.version = '${VERSION}';
    pkg.bin = { vibedeckx: './dist/bin.js' };
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "

  # Ensure spawn-helper is executable (macOS)
  find node_modules/node-pty -name "spawn-helper" -exec chmod +x {} \; 2>/dev/null || true

  # Create archive via npm pack (respects files fields via bundleDependencies)
  npm pack --pack-destination "$OUT_DIR" 2>&1 | tail -1
  mv "$OUT_DIR/vibedeckx-${VERSION}.tgz" "$OUT_DIR/${ARCHIVE_NAME}.tar.gz"

  # Cleanup staging
  rm -rf "$OUT_DIR/staging"

  echo "    Output: $OUT_DIR/${ARCHIVE_NAME}.tar.gz"
fi

# ─── Summary ─────────────────────────────────────────────────────────
echo ""
echo "==> Done! Output files:"
ls -lh "$OUT_DIR"/vibedeckx-* 2>/dev/null
