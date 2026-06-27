#!/usr/bin/env bash
#
# One-shot installer for the Vibedeckx systemd service.
#
# It will: create a service user, set up the install/data dirs, render the unit
# from deploy/vibedeckx.service, seed the env file, fix permissions, and enable
# + start the service.
#
# Usage (run as root):
#   sudo ./deploy/install.sh
#
# Override any default via env vars, e.g.:
#   sudo INSTALL_DIR=/srv/vibedeckx PORT=8444 ./deploy/install.sh
#
set -euo pipefail

# ---- config (override via env) ----
SERVICE_NAME="${SERVICE_NAME:-vibedeckx}"
SERVICE_USER="${SERVICE_USER:-vibedeckx}"
INSTALL_DIR="${INSTALL_DIR:-/opt/vibedeckx}"
ENV_FILE="${ENV_FILE:-/etc/vibedeckx/env}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8444}"
BIN="${BIN:-$(command -v vibedeckx || true)}"

UNIT_DEST="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/vibedeckx.service"
ENV_EXAMPLE="${SCRIPT_DIR}/vibedeckx.env.example"

# ---- preflight ----
if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi
if [[ -z "${BIN}" ]]; then
  echo "Could not find the 'vibedeckx' binary on PATH. Install it first, or set BIN=/abs/path/to/vibedeckx." >&2
  exit 1
fi
if [[ ! -f "${TEMPLATE}" ]]; then
  echo "Missing template: ${TEMPLATE}" >&2
  exit 1
fi
echo "Using vibedeckx binary: ${BIN}"

# ---- service user ----
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "Creating system user '${SERVICE_USER}'..."
  useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

# ---- directories ----
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${INSTALL_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${INSTALL_DIR}/data"

# ---- TLS cert check (we never copy/commit these; you place them here) ----
missing_cert=0
for f in cf-origin.pem cf-origin.key cloudflare-aop-ca.pem; do
  if [[ ! -f "${INSTALL_DIR}/${f}" ]]; then
    echo "WARNING: expected TLS file not found: ${INSTALL_DIR}/${f}" >&2
    missing_cert=1
  fi
done
if [[ "${missing_cert}" -eq 1 ]]; then
  echo "  -> Place your cert/key/CA in ${INSTALL_DIR} before the service can start." >&2
fi
# Lock down the private key if present.
if [[ -f "${INSTALL_DIR}/cf-origin.key" ]]; then
  chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/cf-origin.key"
  chmod 600 "${INSTALL_DIR}/cf-origin.key"
fi

# ---- env file (secrets) ----
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Seeding env file at ${ENV_FILE} (EDIT IT with real Clerk keys)..."
  install -d -m 755 "$(dirname "${ENV_FILE}")"
  install -m 600 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${ENV_EXAMPLE}" "${ENV_FILE}"
else
  echo "Env file ${ENV_FILE} already exists — leaving it untouched."
fi

# ---- render unit from template ----
echo "Writing ${UNIT_DEST}..."
tmp_unit="$(mktemp)"
sed \
  -e "s|__USER__|${SERVICE_USER}|g" \
  -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
  -e "s|__BIN__|${BIN}|g" \
  -e "s|__HOST__|${HOST}|g" \
  -e "s|__PORT__|${PORT}|g" \
  -e "s|__ENV_FILE__|${ENV_FILE}|g" \
  "${TEMPLATE}" > "${tmp_unit}"

# ProtectHome=true would hide an install dir living under /home. Relax to read-only
# there so the certs stay readable (ReadWritePaths still re-enables the data dir).
case "${INSTALL_DIR}" in
  /home/*) sed -i "s|^ProtectHome=true|ProtectHome=read-only|" "${tmp_unit}" ;;
esac

install -m 644 "${tmp_unit}" "${UNIT_DEST}"
rm -f "${tmp_unit}"

# ---- enable + start ----
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
if [[ "${missing_cert}" -eq 1 ]]; then
  echo
  echo "Not starting yet: place TLS files and edit ${ENV_FILE}, then run:"
  echo "  sudo systemctl start ${SERVICE_NAME}"
else
  systemctl restart "${SERVICE_NAME}"
  systemctl --no-pager status "${SERVICE_NAME}" || true
fi

echo
echo "Done. Useful commands:"
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  journalctl -u ${SERVICE_NAME} -f"
