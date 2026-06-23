#!/usr/bin/env bash
set -euo pipefail

# ─── glibc baseline guard ────────────────────────────────────────────
# Fails the build if any shipped native module (.node) requires a glibc
# version higher than the baseline. This catches the silent failure mode
# where `npm rebuild better-sqlite3` can't find a prebuilt for the current
# Node ABI and falls back to compiling from source against the build
# host's (newer) glibc — producing an artifact that won't run on common
# LTS distros.
#
# Usage: scripts/check-glibc.sh <staging-node_modules-dir> [baseline]
#   e.g. scripts/check-glibc.sh ./node_modules 2.31
# ─────────────────────────────────────────────────────────────────────

MODULES_DIR="${1:?usage: check-glibc.sh <node_modules dir> [baseline]}"
BASELINE="${2:-2.31}"  # Ubuntu 20.04 / Debian 11 floor

# Only meaningful on Linux (glibc) builds.
if [ "$(uname -s)" != "Linux" ]; then
  echo "    [glibc-guard] skipped (not Linux)"
  exit 0
fi

# Pick an available symbol reader.
if command -v objdump >/dev/null 2>&1; then
  READER="objdump -T"
elif command -v readelf >/dev/null 2>&1; then
  READER="readelf -V -W"
else
  echo "    [glibc-guard] WARNING: neither objdump nor readelf found; cannot verify glibc baseline" >&2
  exit 0
fi

max_ver() {
  # Highest GLIBC_x.y symbol required by a binary, or empty if none.
  # Trailing `|| true` keeps this non-fatal under `set -e`/`pipefail` for
  # binaries with no GLIBC symbols (e.g. node-pty's bundled win32/darwin
  # prebuilts), which grep reports as no-match.
  { $READER "$1" 2>/dev/null \
    | grep -oE 'GLIBC_[0-9]+\.[0-9]+' \
    | sed 's/GLIBC_//' \
    | sort -V | tail -1; } || true
}

fail=0
while IFS= read -r -d '' f; do
  v="$(max_ver "$f")"
  [ -z "$v" ] && continue
  # If the larger of {baseline, v} is not the baseline, then v > baseline.
  higher="$(printf '%s\n%s\n' "$BASELINE" "$v" | sort -V | tail -1)"
  if [ "$higher" != "$BASELINE" ]; then
    echo "    [glibc-guard] FAIL: $(basename "$f") requires GLIBC_$v (> baseline $BASELINE)" >&2
    echo "                  path: $f" >&2
    fail=1
  else
    echo "    [glibc-guard] ok: $(basename "$f") max GLIBC_$v (<= $BASELINE)"
  fi
done < <(find "$MODULES_DIR" -name '*.node' -print0)

if [ "$fail" -ne 0 ]; then
  cat >&2 <<EOF

    [glibc-guard] A shipped native module requires a glibc newer than $BASELINE.
    This almost always means a native module was compiled from source on this
    build host instead of using an official prebuilt binary — typically because
    the build Node version has no matching prebuilt.

    Fix one of:
      * Build with Node 22 LTS (has better-sqlite3 prebuilts), or
      * Bump better-sqlite3 to a version that ships prebuilts for your Node, or
      * Build native modules inside an old-glibc image (e.g. ubuntu:20.04).

    Current build Node: $(node -v 2>/dev/null || echo unknown) (ABI $(node -p process.versions.modules 2>/dev/null || echo '?'))
EOF
  exit 1
fi

echo "    [glibc-guard] all native modules within GLIBC <= $BASELINE"
