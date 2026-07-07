#!/usr/bin/env bash
set -euo pipefail

# ─── Bundle better-sqlite3 prebuilts for every supported Node ABI ─────
# Downloads the official better-sqlite3 prebuilt for each Node ABI on the
# given platform and lays them out as
#   build/Release/better_sqlite3-<abi>.node
# then patches the loader (scripts/patch-bs3-loader.mjs) to select the
# right one at runtime by process.versions.modules.
#
# This replaces the previous `npm rebuild better-sqlite3` step, which
# produced a single binary locked to the build host's Node ABI (and, when
# no prebuilt matched the build Node, silently compiled from source
# against the host glibc — see scripts/check-glibc.sh).
#
# Usage: scripts/bundle-bs3-prebuilds.sh <better-sqlite3 pkg dir> <platform>
#   e.g. scripts/bundle-bs3-prebuilds.sh node_modules/better-sqlite3 linux-x64
#
# Env overrides:
#   BS3_ABIS          space-separated ABI list to try (default below)
#   BS3_REQUIRED_ABIS ABIs that MUST be present or the build fails
# ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BS3_DIR="${1:?usage: bundle-bs3-prebuilds.sh <better-sqlite3 pkg dir> <platform>}"
PLATFORM="${2:?usage: bundle-bs3-prebuilds.sh <better-sqlite3 pkg dir> <platform>}"
BS3_DIR="$(cd "$BS3_DIR" && pwd)"

# Node ABIs (NODE_MODULE_VERSION) to bundle. 127=Node22, 137=Node24,
# 141=Node25, 147=Node26. 115=Node20 is attempted but better-sqlite3 12.x
# publishes no Node-20 prebuilt, so it is skipped automatically.
ABIS="${BS3_ABIS:-115 127 131 137 141 147}"
# These must succeed (current + previous LTS users); missing => hard fail.
REQUIRED_ABIS="${BS3_REQUIRED_ABIS:-127 137}"
# Max glibc a bundled binary may require, so every shipped binary runs on
# old machines (Ubuntu 20.04 / Debian 11 floor). Newer-Node prebuilts that
# upstream built against a higher glibc are skipped (those users are on
# new systems and can use Node 22/24, or raise this to opt in).
GLIBC_BASELINE="${BS3_GLIBC_BASELINE:-2.31}"

VERSION="$(BS3_DIR="$BS3_DIR" node -e "
  const fs = require('fs');
  const path = require('path');
  const pkg = JSON.parse(fs.readFileSync(path.join(process.env.BS3_DIR, 'package.json'), 'utf8'));
  console.log(pkg.version);
")"
BASE_URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}"

echo "    Bundling better-sqlite3@${VERSION} prebuilts for ${PLATFORM} (ABIs: ${ABIS})"

# Optional GitHub auth to avoid rate limits in CI.
AUTH_ARGS=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

# Reader for glibc symbol versions (Linux only; other platforms skip the check).
READER=""
if [ "$(uname -s)" = "Linux" ]; then
  if command -v objdump >/dev/null 2>&1; then READER="objdump -T";
  elif command -v readelf >/dev/null 2>&1; then READER="readelf -V -W"; fi
fi
max_glibc() {
  # Highest GLIBC_x.y required by a binary, or empty if none/no reader.
  [ -z "$READER" ] && return 0
  { $READER "$1" 2>/dev/null \
    | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/GLIBC_//' \
    | sort -V | tail -1; } || true
}
exceeds_baseline() {
  # exit 0 if $1 (a version) > $GLIBC_BASELINE
  [ -z "$1" ] && return 1
  [ "$(printf '%s\n%s\n' "$GLIBC_BASELINE" "$1" | sort -V | tail -1)" != "$GLIBC_BASELINE" ]
}

# Start from a clean Release dir so no stale/source-built binary lingers.
RELEASE_DIR="$BS3_DIR/build/Release"
rm -rf "$BS3_DIR/build"
mkdir -p "$RELEASE_DIR"

bundled=""
skipped=""
for abi in $ABIS; do
  asset="better-sqlite3-v${VERSION}-node-v${abi}-${PLATFORM}.tar.gz"
  url="${BASE_URL}/${asset}"
  tmp="$(mktemp -d)"
  if curl -fsSL "${AUTH_ARGS[@]}" "$url" -o "$tmp/pb.tar.gz" 2>/dev/null; then
    tar xzf "$tmp/pb.tar.gz" -C "$tmp"
    src="$(find "$tmp" -name 'better_sqlite3.node' | head -1)"
    if [ -z "$src" ]; then
      echo "    [bs3]   ABI $abi: downloaded but no .node inside (skipped)"
      skipped="$skipped $abi"
    else
      glibc="$(max_glibc "$src")"
      if exceeds_baseline "$glibc"; then
        # Upstream built this prebuilt against a too-new glibc. Required ABIs
        # must meet the baseline; others are skipped (new-Node, new-system).
        if printf '%s ' $REQUIRED_ABIS | grep -qw "$abi"; then
          echo "    [bs3] FAIL: required ABI $abi prebuilt needs GLIBC_$glibc (> baseline $GLIBC_BASELINE)" >&2
          rm -rf "$tmp"; exit 1
        fi
        echo "    [bs3]   ABI $abi: prebuilt needs GLIBC_$glibc (> baseline $GLIBC_BASELINE) — skipped for old-machine compat"
        skipped="$skipped $abi"
      else
        cp "$src" "$RELEASE_DIR/better_sqlite3-${abi}.node"
        echo "    [bs3]   ABI $abi: bundled${glibc:+ (GLIBC_$glibc)}"
        bundled="$bundled $abi"
      fi
    fi
  else
    echo "    [bs3]   ABI $abi: no prebuilt published (skipped)"
    skipped="$skipped $abi"
  fi
  rm -rf "$tmp"
done

echo "    [bs3] bundled ABIs:$bundled | skipped:$skipped"

# Verify the required ABIs are present.
missing=""
for req in $REQUIRED_ABIS; do
  if [ ! -f "$RELEASE_DIR/better_sqlite3-${req}.node" ]; then
    missing="$missing $req"
  fi
done
if [ -n "$missing" ]; then
  echo "    [bs3] FAIL: required ABI prebuilt(s) missing:$missing" >&2
  echo "    [bs3] (better-sqlite3@${VERSION} may not publish them for ${PLATFORM}; adjust BS3_REQUIRED_ABIS or pin a version that does)" >&2
  exit 1
fi
if [ -z "$bundled" ]; then
  echo "    [bs3] FAIL: no prebuilts could be downloaded (network/version issue)" >&2
  exit 1
fi

# Patch the loader + rewrite package.json files field.
node "$SCRIPT_DIR/patch-bs3-loader.mjs" "$BS3_DIR"
