#!/usr/bin/env bash
#
# Build the Vibedeckx Docker image from the pack.sh platform tarball.
#
# Usage (run from anywhere):
#   ./deploy/build.sh                 # pack.sh platform + docker build
#   ./deploy/build.sh --skip-pack     # reuse the existing dist-out tarball
#
# Produces the image tagged: vibedeckx:local  (override with IMAGE=...)
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="${ROOT_DIR}/packages/vibedeckx/package.json"
IMAGE="${IMAGE:-vibedeckx:local}"

SKIP_PACK=false
[[ "${1:-}" == "--skip-pack" ]] && SKIP_PACK=true

# Detect version + platform the same way pack.sh does.
VERSION="$(node -e "console.log(require('${PKG_JSON}').version)")"
case "$(uname -s)" in linux) OS=linux ;; darwin) OS=darwin ;; *) echo "Unsupported OS"; exit 1 ;; esac
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Unsupported arch"; exit 1 ;; esac
PLATFORM="${OS}-${ARCH}"
TARBALL="vibedeckx-${VERSION}-${PLATFORM}.tar.gz"

if [[ "${SKIP_PACK}" == false ]]; then
  echo "==> Packing platform tarball..."
  "${ROOT_DIR}/scripts/pack.sh" platform
fi

if [[ ! -f "${ROOT_DIR}/dist-out/${TARBALL}" ]]; then
  echo "ERROR: ${ROOT_DIR}/dist-out/${TARBALL} not found. Run without --skip-pack." >&2
  exit 1
fi

echo "==> Building image ${IMAGE} from ${TARBALL}..."
docker build \
  -f "${ROOT_DIR}/deploy/Dockerfile" \
  -t "${IMAGE}" \
  --build-arg "TARBALL=${TARBALL}" \
  "${ROOT_DIR}"

echo "==> Done: ${IMAGE}"
echo "    Run it from your runtime dir with: docker compose up -d"
