#!/usr/bin/env bash
set -euo pipefail

if [ -z "${NPM_TOKEN:-}" ]; then
  echo "Error: NPM_TOKEN environment variable is not set"
  exit 1
fi

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: NPM_TOKEN=<token> $0 <version>"
  echo "Example: NPM_TOKEN=npm_abc123 $0 0.1.0"
  exit 1
fi

PACKAGES=(
  "vibedeckx"
  "@vibedeckx/darwin-arm64"
  "@vibedeckx/linux-x64"
  "@vibedeckx/win32-x64"
)

echo "Will unpublish version $VERSION of:"
for pkg in "${PACKAGES[@]}"; do
  echo "  - $pkg@$VERSION"
done
echo ""
read -rp "Continue? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

failed=()
for pkg in "${PACKAGES[@]}"; do
  echo ""
  echo "Unpublishing $pkg@$VERSION..."
  if NPM_CONFIG_TOKEN="$NPM_TOKEN" npm unpublish "$pkg@$VERSION"; then
    echo "  Done."
  else
    echo "  Failed to unpublish $pkg@$VERSION (may not exist or past 72h window)"
    failed+=("$pkg@$VERSION")
  fi
done

echo ""
if [ ${#failed[@]} -eq 0 ]; then
  echo "All packages unpublished successfully."
else
  echo "Failed to unpublish:"
  for f in "${failed[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
