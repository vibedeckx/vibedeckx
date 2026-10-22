#!/usr/bin/env bash
#
# Build the Vibedeckx worker image from the pack.sh platform tarball.
#
# Usage (run from anywhere):
#   ./deploy/worker/build.sh                 # pack.sh platform + docker build
#   ./deploy/worker/build.sh --skip-pack     # reuse the existing dist-out tarball
#
# Produces the image tagged: vibedeckx-worker:local  (override with IMAGE=...)
# Agent CLI versions: CLAUDE_CODE_VERSION=... CODEX_VERSION=... (default: latest)
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_JSON="${ROOT_DIR}/packages/vibedeckx/package.json"
IMAGE="${IMAGE:-vibedeckx-worker:local}"

SKIP_PACK=false
[[ "${1:-}" == "--skip-pack" ]] && SKIP_PACK=true

VERSION="$(node -e "console.log(require('${PKG_JSON}').version)")"
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "Unsupported arch"; exit 1 ;; esac
# The image is always Linux, so the tarball must be a Linux build.
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: build the worker image on Linux (the tarball carries Linux native modules)." >&2
  exit 1
fi
TARBALL="vibedeckx-${VERSION}-linux-${ARCH}.tar.gz"

if [[ "${SKIP_PACK}" == false ]]; then
  echo "==> Packing platform tarball..."
  "${ROOT_DIR}/scripts/pack.sh" platform
fi

if [[ ! -f "${ROOT_DIR}/dist-out/${TARBALL}" ]]; then
  echo "ERROR: ${ROOT_DIR}/dist-out/${TARBALL} not found. Run without --skip-pack." >&2
  exit 1
fi

# The Dockerfile uses RUN --mount (BuildKit).
export DOCKER_BUILDKIT=1
echo "==> Building image ${IMAGE} from ${TARBALL}..."
docker build \
  -f "${ROOT_DIR}/deploy/worker/Dockerfile" \
  -t "${IMAGE}" \
  --build-arg "VIBEDECKX_PACKAGE=/tmp/dist-out/${TARBALL}" \
  --build-arg "CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION:-latest}" \
  --build-arg "CODEX_VERSION=${CODEX_VERSION:-latest}" \
  "${ROOT_DIR}"

echo "==> Done: ${IMAGE}"
echo "    Run it with deploy/worker/docker-compose.yml: docker compose up -d"
