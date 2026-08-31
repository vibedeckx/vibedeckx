# Vibedeckx

AI-powered app generator with project management support.

## Development

```bash
# Install dependencies
pnpm install

# Run frontend in development mode
pnpm dev

# Run CLI in watch mode
pnpm dev:server
```

## Build

```bash
# Build everything (CLI + UI)
pnpm build

# Build individual parts
pnpm build:main    # Build CLI package
pnpm build:ui      # Build UI (static export)
pnpm copy:ui       # Copy UI to CLI dist
```

## Testing & Protocol Compatibility

Vibedeckx spawns the Claude Code (`claude`) and Codex (`codex`) CLIs and depends on
their external protocols (stream-json / JSON-RPC wire formats, CLI flags). The
protocol contract lives in `packages/vibedeckx/src/protocol/` and is guarded by
three layers of tests:

### 1. Offline tests — run automatically on every PR

```bash
pnpm --filter vibedeckx test
```

Free, deterministic, no network or agent CLIs required. Includes the protocol
contract tests: recorded real CLI transcripts (`__fixtures__/*.jsonl`) are
validated against the zod schemas in `src/protocol/*/schema.ts`. CI runs this on
every pull request and push to main (`.github/workflows/test.yml`). This layer
catches regressions **we** introduce in the protocol layer.

### 2. Live compat probes — run manually, locally or via workflow dispatch

```bash
pnpm --filter vibedeckx test:compat                                        # all 16 probes
pnpm --filter vibedeckx test:compat src/protocol/live/claude.live.test.ts # one agent only
```

Spawns the **real** `claude`/`codex` CLIs through the production spawn builders and
validates every protocol line against the contracts (16 scenarios: tool calls,
background-task lifecycle events, plan mode, MCP config, interrupts, approval
round-trips, exec modes). This layer catches protocol drift in **new upstream
releases**.

- **Locally: no configuration needed.** The probes inherit your machine's existing
  CLI logins (Claude subscription / ChatGPT login). Costs cents per full sweep
  (~3–4 min). To pre-check a new release by hand:

  ```bash
  npm i -g @anthropic-ai/claude-code@latest && pnpm --filter vibedeckx test:compat
  ```

- **On GitHub Actions:** trigger `protocol-compat` from the Actions tab
  (`workflow_dispatch`; requires the workflow file on the default branch). CI
  runners have no login state, so two repo secrets are required:
  `ANTHROPIC_API_KEY` (claude headless auth, API billing) and `OPENAI_API_KEY`
  (codex authenticates via `codex login --with-api-key`). The matrix tests each
  agent at both the `pinned` version (from `.github/agent-versions.json`) and
  `latest`: a `pinned` failure means our bug; a `latest` failure means upstream
  drift. Failures auto-open a deduplicated GitHub issue.

### 3. Scheduled drift watch — currently disabled, opt-in later

`protocol-compat.yml` contains a commented-out daily cron. Once enabled, a cheap
version-check job compares npm's latest `@anthropic-ai/claude-code` /
`@openai/codex` versions against `.github/agent-versions.json` every day and runs
the paid live matrix **only when a new upstream version appears**. It stays
disabled until a `lastSeen` write-back step is added after matrix runs — without
it, any upstream release would make the daily cron re-run the paid matrix forever.
Enable by uncommenting the `schedule:` block after a few clean manual runs.

## Installation

The fastest way to install is via npx (requires Node.js 22+):

```bash
npx vibedeckx@latest
```

Alternatively, download a precompiled archive for your platform from the [GitHub Releases page](https://github.com/vibedeckx/vibedeckx/releases) and run it directly with npx:

```bash
# Linux / Windows
npx -y ./vibedeckx-<version>-<platform>.tar.gz

# macOS — install globally first, then run
npm install -g ./vibedeckx-<version>-darwin-arm64.tar.gz
vibedeckx
```

See the [Release](#release) section below for the list of supported platforms.

## Usage

Once installed (see [Installation](#installation)), invoke the CLI directly:

```bash
vibedeckx              # same as `vibedeckx start`
vibedeckx start        # start the server (default command)
vibedeckx --help       # show help
vibedeckx --version    # show version
```

The server opens in your browser automatically.

### `vibedeckx start`

Starts the local server. All flags are optional.

| Flag | Description |
|------|-------------|
| `--port <number>` | Port to bind (default: `5173`) |
| `--host <address>` | Interface to bind (default: `127.0.0.1`, loopback only). Use `0.0.0.0` to expose on all interfaces — only do so behind `--auth` or an authenticating proxy. |
| `--auth` | Enable Clerk authentication (requires `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`) |
| `--data-dir <path>` | Directory for the SQLite database (default: `~/.vibedeckx`) |
| `--cert <path>` | Path to TLS certificate PEM. Enables HTTPS when paired with `--key`. Env: `VIBEDECKX_TLS_CERT` |
| `--key <path>` | Path to TLS private key PEM. Required with `--cert`. Env: `VIBEDECKX_TLS_KEY` |
| `--client-ca <path>` | Client CA bundle for mTLS (e.g. Cloudflare Authenticated Origin Pulls). Requires `--cert`/`--key`. Env: `VIBEDECKX_TLS_CLIENT_CA` |

```bash
vibedeckx start --port 8080
vibedeckx start --data-dir /path/to/data    # database at /path/to/data/data.sqlite
vibedeckx start --host 0.0.0.0 --auth       # expose on the LAN, gated by Clerk auth
CLERK_SECRET_KEY=... CLERK_PUBLISHABLE_KEY=... vibedeckx start --auth
```

> By default the server binds to `127.0.0.1` (loopback only), so a no-auth instance
> is reachable only from the same machine. The executor API runs commands on the
> host and is not authenticated per-route in no-auth mode, so widen the bind with
> `--host 0.0.0.0` only behind `--auth` or an authenticating reverse-proxy.
> A Cloudflare tunnel (`cloudflared`) dials `127.0.0.1` locally and needs no
> `--host` change; binding `0.0.0.0` is only required when something off-box
> (a reverse proxy, or Cloudflare reaching the origin IP directly) must connect.
> Note that a tunnel exposes the instance just as a wide bind does — loopback is
> not a safety margin once a public hostname points at it.

#### HTTPS / TLS

When `--cert` and `--key` are both supplied (via CLI flag or environment variable), the server listens over HTTPS instead of HTTP. WebSocket connections automatically use `wss://`. Without these flags the default plain-HTTP behavior is unchanged.

The CLI flags take precedence over the environment variables. Values point to **file paths** on disk, not the PEM contents themselves — this keeps multi-line certs out of env strings and lets you `chmod 600` the key files normally.

| CLI flag | Environment variable | Purpose |
|----------|----------------------|---------|
| `--cert` | `VIBEDECKX_TLS_CERT` | Server certificate (PEM) |
| `--key` | `VIBEDECKX_TLS_KEY` | Server private key (PEM) |
| `--client-ca` | `VIBEDECKX_TLS_CLIENT_CA` | Client CA bundle for mTLS (optional) |

**Recommended setup behind Cloudflare** — use a Cloudflare Origin Certificate (valid up to 15 years, no ACME / auto-renewal needed) plus Authenticated Origin Pulls so the origin only accepts connections from Cloudflare, and protect the public Cloudflare route with Cloudflare Access, `--auth`, or an equivalent user-authentication layer:

```bash
# These bind --host 0.0.0.0 because Cloudflare reaches the origin IP over the
# network. With a cloudflared tunnel instead, drop --host (cloudflared dials the
# default 127.0.0.1 locally) for a tighter origin that isn't directly reachable.

# 1. Cloudflare Access protected route + Origin Cert — encrypts CF ↔ origin, but
#    a leaked origin IP can still be hit directly. This no-auth Vibedeckx mode is
#    safe only when the public Cloudflare hostname is protected by Cloudflare
#    Access or an equivalent user-authentication policy.
vibedeckx start --host 0.0.0.0 \
  --cert /etc/vibedeckx/cf-origin.pem \
  --key  /etc/vibedeckx/cf-origin.key

# 2. Built-in Clerk auth + Origin Cert — use when you want Vibedeckx to enforce
#    application-layer user authentication itself.
CLERK_SECRET_KEY=... CLERK_PUBLISHABLE_KEY=... vibedeckx start --host 0.0.0.0 --auth \
  --cert /etc/vibedeckx/cf-origin.pem \
  --key  /etc/vibedeckx/cf-origin.key

# 3. Origin Cert + Authenticated Origin Pulls (mTLS) — origin rejects any request
#    that doesn't present Cloudflare's client cert, so direct hits on the origin
#    IP are dropped at the TLS layer. You still need Cloudflare Access, --auth,
#    or equivalent user authentication for the public URL.
#    Download the CA from:
#    https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem
vibedeckx start --host 0.0.0.0 \
  --cert      /etc/vibedeckx/cf-origin.pem \
  --key       /etc/vibedeckx/cf-origin.key \
  --client-ca /etc/vibedeckx/cloudflare-aop-ca.pem
```

Same configuration via environment (e.g. `systemd` `EnvironmentFile` or `docker -e`):

```ini
VIBEDECKX_TLS_CERT=/etc/vibedeckx/cf-origin.pem
VIBEDECKX_TLS_KEY=/etc/vibedeckx/cf-origin.key
VIBEDECKX_TLS_CLIENT_CA=/etc/vibedeckx/cloudflare-aop-ca.pem
```

Notes:
- If only one of `--cert` / `--key` is supplied, startup fails with a clear error.
- `--client-ca` requires `--cert`/`--key` (mTLS needs server identity first).

> [!WARNING]
> TLS, Cloudflare Origin Certificates, and Authenticated Origin Pulls do not authenticate end users. If this Vibedeckx URL is Internet-reachable, protect it with Cloudflare Access, `--auth`, or an equivalent user-authentication layer. Do not expose a no-auth Vibedeckx instance directly to the public Internet.

- TLS mode skips the auto-open-browser step on launch — the certificate is for the public hostname, so opening `https://localhost:<port>` would just trigger a cert-mismatch warning. Visit your public URL through Cloudflare instead.

#### `VIBEDECKX_API_KEY`

The operator's shared secret. It authenticates the operator-only endpoints under
`/api/admin/*` — fleet-wide aggregates that span tenants and that no end user,
Clerk or otherwise, may read. Pass it as an `x-vibedeckx-api-key` header; a
request with the wrong value, or none, gets a 404 rather than a 401, so the
endpoint never confirms it exists. An empty value (`VIBEDECKX_API_KEY=`) counts
as unset, not as a key that matches the empty string.

Who counts as the operator depends on the deployment:

| Deployment | `/api/admin/*` |
|---|---|
| Key set | Requires the header — everyone else gets a 404 |
| `--auth`, no key | Closed: no Clerk tenant qualifies, so every request 404s |
| Solo, no auth, no key | Open to anyone who can reach the server — the sole local user *is* the operator, exactly as the rest of the API already is |

It gates nothing else. Ordinary `/api/` routes, and therefore the web UI, behave
exactly as if it were unset — setting it can never lock you out of your own
instance. It also grants no identity: with `--auth` enabled, a Clerk session
token is still required everywhere it was before.

For protecting the instance itself, use `--auth` or an authenticating proxy in
front. To keep someone who discovers your origin IP from bypassing that proxy,
use Authenticated Origin Pulls (`--client-ca`, above).

### `vibedeckx connect`

Runs in reverse-connect mode: starts a local server bound to `127.0.0.1` and tunnels it to a remote vibedeckx instance. Useful when the remote machine can't be reached directly (e.g. behind NAT) but can dial out.

| Flag | Description |
|------|-------------|
| `--connect-to <url>` | URL of the remote vibedeckx server (required) |
| `--token <value>` | Authentication token for the reverse connection (required) |
| `--daemon` | Run in the background after initialization (Linux only) |
| `--daemon-ready-timeout-ms <number>` | Maximum daemon startup wait in milliseconds (default: `15000`; env: `VIBEDECKX_CONNECT_DAEMON_READY_TIMEOUT_MS`) |
| `--port <number>` | Local port (default: random) |
| `--data-dir <path>` | Directory for the SQLite database (default: `~/.vibedeckx`) |

```bash
vibedeckx connect --connect-to https://example.com --token abc123
```

To keep a remote node running after disconnecting SSH on Linux:

```bash
npx -y vibedeckx@latest connect --connect-to https://example.com --token abc123 --daemon
```

Manage the background process with the same CLI. `--prefer-offline` reuses the
already-downloaded CLI instead of checking npm for a newer version first —
status and stop don't need an update (`connect status` reports whether one is
available, and the next `connect ... --daemon` start picks it up via `@latest`):

```bash
npx -y --prefer-offline vibedeckx connect status
npx -y --prefer-offline vibedeckx connect stop
```

Daemon status is scoped by `--data-dir`; when using a custom directory, pass
the same `--data-dir` to the start, status, and stop commands. The first version
survives SSH disconnection but does not restart after a crash or machine reboot.
Logs remain available at `~/.vibedeckx/logs/vibedeckx.log` by default (or
`<data-dir>/logs/vibedeckx.log` for a custom data directory).

### Running from source

For development against a local checkout:

```bash
pnpm start                              # runs the built CLI
node packages/vibedeckx/dist/bin.js --port 8080
```

## Distribution

### Local Packaging

Use `scripts/pack.sh` to build distribution packages. Output is written to the `dist-out/` directory:

```bash
./scripts/pack.sh                  # Build npm package + platform archives
./scripts/pack.sh npm              # Build the main npm tarball only
./scripts/pack.sh platform         # Build platform archives only (for npx / direct download)
./scripts/pack.sh npm-platform     # Build npm platform packages (matches the npmjs release)
./scripts/pack.sh <mode> --skip-build  # Skip pnpm build (reuse the existing dist/)
```

Three kinds of packages are produced:

| Type | Example file | Description |
|------|-------------|-------------|
| Main npm package | `vibedeckx-0.1.0.tgz` | Lightweight wrapper (only `bin/vibedeckx.mjs`) |
| Platform archive | `vibedeckx-0.1.0-linux-x64.tar.gz` | Precompiled dependencies, ready to use, for GitHub Releases |
| npm platform package | `vibedeckx-linux-x64-0.1.0.tgz` | Matches `@vibedeckx/linux-x64` published on npmjs |

### Publishing to npm

Push a `v*` tag to trigger an automated CI release (see the Release section below), or publish manually:

```bash
cd packages/vibedeckx
npm publish
```

Users can then run it directly:

```bash
npx vibedeckx
```

## Features

- **Project Management**: Create and manage multiple workspace projects
- **Folder Selection**: Native OS folder picker (macOS, Windows, Linux)
- **SQLite Storage**: Project data stored in `~/.vibedeckx/data.sqlite`
- **Static UI**: Frontend bundled with CLI for easy distribution
- **Remote Projects**: Connect remote worker machines (via `vibedeckx connect`) to manage their projects from one UI

## Remote Project Support

Vibedeckx supports connecting remote worker machines to a central server, allowing you to manage projects on remote machines through one UI. Workers connect **outward** to the server (reverse-connect) — the worker machine never needs a public URL or an open port.

### Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│  Browser UI  │◄───►│  vibedeckx Server   │◄────│ Remote worker    │
│  (Next.js)   │     │  (Management)       │  ▲  │ (vibedeckx       │
└──────────────┘     └─────────────────────┘  │  │  connect)        │
                            │                 │  └──────────────────┘
                            ▼                 │        │
                      Server SQLite    reverse-connect ▼
                    (all project data)   WebSocket   Agent execution
```

**Data Storage** (managed on the server, executed on the worker):
- **Server SQLite**: stores all project configuration (the server database is the source of truth)
  - Project info (name, path, linked remote servers)
  - Executor config (command, working directory)
- **Remote worker**: handles execution only
  - Runs agent sessions (accessing its local filesystem)
  - Executes Executor commands
  - Serves directory browsing over the tunnel

### Connecting a Remote Worker

1. In the UI, open **Settings → Remote Servers** and click **Add Server** (a name is all that's needed).

2. Click the key icon to **generate a connect token**. Copy the printed command, e.g.:

```bash
npx vibedeckx@latest connect --connect-to https://your-server.example.com --token <token>
```

3. Run that command on the remote machine. It establishes a persistent reverse WebSocket connection to the server; the server row flips to **Connected**.

4. When creating or editing a project, click **Add Remote**, pick the server, and browse to the project directory on the worker.

### How It Works

- **Reverse connect**: the worker dials out to the server and keeps a WebSocket tunnel open; all API and streaming traffic to the worker rides this tunnel. No inbound connectivity to the worker is required.
- **Request proxying**: API requests for remote projects are proxied by the server through the tunnel.
- **WebSocket proxying**: agent session and executor log streams are carried over virtual channels multiplexed on the same tunnel.
- **Machine identity**: on first connect the worker's Ed25519 machine identity is pinned to the token's owner, so a leaked token cannot be silently replayed from another machine.
- **Data locality**: project files and agent processes stay on the worker; only management state lives on the server.

### Security Considerations

- Connect tokens are shown once at generation time; revoke a token to immediately disconnect and invalidate it.
- Use HTTPS on the server in production — the token and all tunneled traffic ride the WebSocket connection.

## Release

The project uses GitHub Actions for automated builds and releases. Pushing a tag in the `v*` format triggers a release from any branch.

```bash
# 1. Make sure all changes are committed
git add .
git commit -m "release: v0.1.0"

# 2. Create the tag
git tag v0.1.0

# 3. Push the tag to trigger the build
git push origin v0.1.0
```

Once the build completes, a Release is created automatically on the GitHub Releases page, including precompiled packages for the following platforms:

| Platform | File format |
|----------|-------------|
| Linux x64 | `.tar.gz` |
| macOS ARM (Apple Silicon) | `.tar.gz` |
| Windows x64 | `.tar.gz` |

After downloading, run directly with npx (Node.js 22+):

```bash
npx -y ./vibedeckx-<version>-<platform>.tar.gz
```

On macOS, install globally first, then run `vibedeckx`:

```bash
npm install -g ./vibedeckx-<version>-darwin-arm64.tar.gz
vibedeckx
```

## CLI Commands

```
vibedeckx start [options]        Start the server
  --port <value>                 Port to run the server on (default: 3000)
  --host <address>               Interface to bind (default: 127.0.0.1; use 0.0.0.0 to expose)
  --auth                         Enable Clerk authentication
  --data-dir <path>              Directory for storing database file (default: ~/.vibedeckx)
  --cert <path>                  TLS certificate PEM (enables HTTPS with --key)
  --key <path>                   TLS private key PEM (required with --cert)
  --client-ca <path>             Client CA PEM for mTLS / Cloudflare AOP (optional)
vibedeckx --help                 Show help
vibedeckx --version              Show version
```

### Custom Data Directory

Use `--data-dir` to specify a custom directory for the database file:

```bash
vibedeckx --data-dir /path/to/data
# Database will be stored at /path/to/data/data.sqlite
```

## Observability (optional)

Vibedeckx ships with Langfuse tracing for every Vercel AI SDK call —
chat sessions, session-title generation, translate, and task-suggest.
Each trace carries `sessionId` (chat-session only), `userId`, `tags`,
`projectId`, and `branch` metadata.

### Environment variables

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...           # required
LANGFUSE_SECRET_KEY=sk-lf-...           # required
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # optional; defaults to EU cloud
LANGFUSE_TRACING_ENVIRONMENT=production # optional; e.g. production / staging / development
```

Regional `LANGFUSE_BASE_URL` options:

- `https://cloud.langfuse.com` — EU (default)
- `https://us.cloud.langfuse.com` — US
- `https://hipaa.cloud.langfuse.com` — HIPAA
- self-hosted: your own Langfuse base URL

When the keys are unset, tracing is silently disabled at startup and AI
SDK calls behave identically to a non-instrumented run. Look for
`[Langfuse] tracing enabled` (or `tracing disabled (LANGFUSE_PUBLIC_KEY
not set)`) in the server log on boot to confirm.

### userId resolution

- `vibedeckx start --auth` (Clerk enabled) → trace `userId` is the real
  Clerk user id when the requestor is logged in
- otherwise (no-auth CLI mode, or unauthenticated request paths) →
  `userId` is the literal string `"local"`

### Reverse-connect (`vibedeckx connect`) nodes

Remote nodes started with `vibedeckx connect` automatically suppress
local session-title generation. The upstream server (the one users
actually open in a browser) handles title generation and pushes the
result back, so the remote setting `LANGFUSE_*` keys would only produce
duplicate traces tagged `userId="local"`. If you want title traces
attributed to real users, set the keys on the upstream server only.

## Troubleshooting

### `ENOTEMPTY` error when running with npx

If you see an error like:

```
npm error code ENOTEMPTY
npm error syscall rename
npm error path /home/user/.npm/_npx/...
npm error dest /home/user/.npm/_npx/...
npm error ENOTEMPTY: directory not empty, rename ...
```

This is caused by npm cache corruption. Fix it by clearing the npx cache:

```bash
rm -rf ~/.npm/_npx/
```

Then retry:

```bash
npx vibedeckx-0.1.0.tgz
```

## Data Storage

- **Global config**: `~/.vibedeckx/`
- **Database**: `~/.vibedeckx/data.sqlite`
