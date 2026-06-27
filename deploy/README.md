# Deploying Vibedeckx

Two interchangeable ways to run the server as a managed, auto-restarting
service: **systemd** (lighter, native) or **Docker** (bundles the node runtime,
no host node/fnm to manage). Pick one.

## What's here

| File | Purpose | Committed? |
|------|---------|-----------|
| `vibedeckx.service` | systemd unit **template** (`__TOKENS__` filled by the installer) | ✅ yes — paths only |
| `vibedeckx.env.example` | systemd env file example (Clerk keys / TLS paths) | ✅ yes — placeholders |
| `install.sh` | systemd one-shot installer (user, dirs, unit, perms, enable) | ✅ yes |
| `Dockerfile` | runtime image built from the `pack.sh platform` tarball | ✅ yes |
| `build.sh` | builds the image `vibedeckx:local` (packs tarball + `docker build`) | ✅ yes |
| `docker-compose.yml` | **run-only** compose; references the image by name (bind-mounted data + certs, host net) | ✅ yes |
| `docker.env.example` | Docker secrets example | ✅ yes — placeholders |

**Never committed** (blocked by `.gitignore`): the real TLS cert/key
(`*.pem`, `*.key`), the systemd env file, and `deploy/docker.env`.

## Option A — systemd

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

The TLS paths aren't on the unit's `ExecStart` line — they live in the env file
as `VIBEDECKX_TLS_CERT` / `VIBEDECKX_TLS_KEY` / `VIBEDECKX_TLS_CLIENT_CA`
(read at `command.ts:15-17`), so `ExecStart` stays as just
`vibedeckx start --auth --host 0.0.0.0 --port 8444 --data-dir=<dir>/data`.
`--data-dir` has no env fallback, so it remains a flag.

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
- **TLS via env (default here).** The TLS paths live in the env file as
  `VIBEDECKX_TLS_CERT` / `VIBEDECKX_TLS_KEY` / `VIBEDECKX_TLS_CLIENT_CA` rather
  than as `--cert/--key/--client-ca` flags. Functionally identical; you can move
  them back onto `ExecStart` if you prefer flags.

## Option B — Docker

The container carries its own node runtime (no host node/fnm to manage).
**Build** (needs the source repo) and **run** (needs only the image + your
data/certs/secrets) are separate steps — the image lives in Docker's store as
`vibedeckx:local`, so the runtime dir needs no source tree.

### 1. Build the image (from the repo)

```bash
./deploy/build.sh          # pack.sh platform + docker build -> vibedeckx:local
# already have a fresh dist-out tarball? skip packing:
./deploy/build.sh --skip-pack
```

Re-run this on every update.

### 2. Set up a standalone runtime dir, e.g. `/opt/vibedeckx/`

```
/opt/vibedeckx/
├── docker-compose.yml        # = deploy/docker-compose.yml
├── docker.env                # Clerk secrets, chmod 600
├── certs/                    # cf-origin.pem, cf-origin.key, cloudflare-aop-ca.pem
└── data/                     # your existing SQLite db
```

```bash
sudo mkdir -p /opt/vibedeckx/{certs,data}
sudo cp deploy/docker-compose.yml /opt/vibedeckx/docker-compose.yml
sudo cp deploy/docker.env.example /opt/vibedeckx/docker.env   # then edit in Clerk keys
# copy your certs into /opt/vibedeckx/certs and the db into /opt/vibedeckx/data
```

The compose defaults `data/` and `certs/` to dirs next to it, so this layout
works as-is (override with `VIBEDECKX_DATA_DIR` / `VIBEDECKX_CERTS_DIR`).

### 3. Run

```bash
cd /opt/vibedeckx
docker compose up -d
docker compose logs -f
```

To deploy on a **different machine** than the build, ship the image with
`docker save vibedeckx:local | gzip > img.tgz` → `docker load < img.tgz` (or push
to a registry and set `VIBEDECKX_IMAGE`).

### Docker notes

- **glibc base, not alpine.** The bundled `better-sqlite3` / `node-pty`
  prebuilts are glibc; the image uses `node:24-bookworm-slim` to match the
  tarball's node ABI. Switch the tag only if you rebuild against another major.
- **SQLite via bind mount.** The compose mounts your existing host data dir
  straight into the container — same file you already run with, still on the
  host for backups. Bind mounts bypass overlayfs, so disk perf is native (the
  overlayfs/WAL warning only applies to writing into the container layer).
- **File ownership.** The container runs as root, so db/WAL files it creates in
  the bind-mounted dir will be root-owned on the host. Harmless, but if you want
  them owned by your user, add `user: "1000:1000"` to the service and make sure
  the data dir is writable by that uid.
- **Host networking.** `network_mode: host` binds `0.0.0.0:8444` directly with
  no NAT hop, so network perf matches native. (With host mode, `ports:` is
  ignored and must stay unset.)
- **Performance vs systemd:** negligible for this app (CPU/RAM within noise)
  with a bind-mounted data dir and host networking. The choice is operational,
  not performance.
