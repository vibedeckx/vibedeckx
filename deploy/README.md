# Deploying Vibedeckx as a systemd service

Run the server under systemd so it auto-restarts on crash, starts on boot, and
logs to `journalctl` — instead of running `vibedeckx start ...` by hand.

## What's here

| File | Purpose | Committed? |
|------|---------|-----------|
| `vibedeckx.service` | systemd unit **template** (`__TOKENS__` filled by the installer) | ✅ yes — paths only, no secrets |
| `vibedeckx.env.example` | example env file for Clerk keys / TLS paths | ✅ yes — placeholders only |
| `install.sh` | one-shot installer (user, dirs, unit, perms, enable) | ✅ yes |

**Never committed** (blocked by `.gitignore`): the real TLS cert/key
(`*.pem`, `*.key`) and the real env file with Clerk secrets.

## Quick start

1. Install the `vibedeckx` CLI on the server (so `which vibedeckx` resolves).
2. Put your TLS files in the install dir (default `/opt/vibedeckx`):
   `cf-origin.pem`, `cf-origin.key`, `cloudflare-aop-ca.pem`.
3. Run the installer:

   ```bash
   sudo ./deploy/install.sh
   # or override defaults:
   sudo INSTALL_DIR=/srv/vibedeckx PORT=8444 HOST=0.0.0.0 ./deploy/install.sh
   ```

4. Edit the seeded env file with real Clerk keys, then (re)start:

   ```bash
   sudo nano /etc/vibedeckx/env
   sudo systemctl restart vibedeckx
   sudo systemctl status vibedeckx
   journalctl -u vibedeckx -f
   ```

## Equivalent command

The unit reproduces this command, run as the `vibedeckx` user with the install
dir as the working directory:

```
vibedeckx start --auth --data-dir=<dir>/data --host 0.0.0.0 --port 8444 \
  --cert <dir>/cf-origin.pem --key <dir>/cf-origin.key \
  --client-ca <dir>/cloudflare-aop-ca.pem
```

## Notes

- **Relative vs absolute paths.** The CLI resolves relative cert/`--data-dir`
  paths against the current working directory (`fs.readFileSync` / `path.resolve`),
  so `WorkingDirectory=` alone would make `./cf-origin.pem` work. The unit uses
  absolute paths anyway so they survive `ProtectSystem=strict` + `ReadWritePaths`.
- **Install dir under `/home`.** `ProtectHome=true` hides home dirs. If you install
  under `/home/...`, the installer automatically relaxes it to `ProtectHome=read-only`
  so the certs stay readable.
- **Data migration.** If you already have a SQLite db from a previous
  `--data-dir=./data`, point `INSTALL_DIR` so `<INSTALL_DIR>/data` is that same
  directory, or move the db there first — otherwise you'll start with an empty db.
- **TLS via env instead of flags.** You can set `VIBEDECKX_TLS_CERT` /
  `VIBEDECKX_TLS_KEY` / `VIBEDECKX_TLS_CLIENT_CA` in the env file and drop the
  matching flags from the unit. Functionally identical.
