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
| `--auth` | Enable Clerk authentication (requires `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`) |
| `--data-dir <path>` | Directory for the SQLite database (default: `~/.vibedeckx`) |
| `--cert <path>` | Path to TLS certificate PEM. Enables HTTPS when paired with `--key`. Env: `VIBEDECKX_TLS_CERT` |
| `--key <path>` | Path to TLS private key PEM. Required with `--cert`. Env: `VIBEDECKX_TLS_KEY` |
| `--client-ca <path>` | Client CA bundle for mTLS (e.g. Cloudflare Authenticated Origin Pulls). Requires `--cert`/`--key`. Env: `VIBEDECKX_TLS_CLIENT_CA` |

```bash
vibedeckx start --port 8080
vibedeckx start --data-dir /path/to/data    # database at /path/to/data/data.sqlite
CLERK_SECRET_KEY=... CLERK_PUBLISHABLE_KEY=... vibedeckx start --auth
```

#### HTTPS / TLS

When `--cert` and `--key` are both supplied (via CLI flag or environment variable), the server listens over HTTPS instead of HTTP. WebSocket connections automatically use `wss://`. Without these flags the default plain-HTTP behavior is unchanged.

The CLI flags take precedence over the environment variables. Values point to **file paths** on disk, not the PEM contents themselves — this keeps multi-line certs out of env strings and lets you `chmod 600` the key files normally.

| CLI flag | Environment variable | Purpose |
|----------|----------------------|---------|
| `--cert` | `VIBEDECKX_TLS_CERT` | Server certificate (PEM) |
| `--key` | `VIBEDECKX_TLS_KEY` | Server private key (PEM) |
| `--client-ca` | `VIBEDECKX_TLS_CLIENT_CA` | Client CA bundle for mTLS (optional) |

**Recommended setup behind Cloudflare** — use a Cloudflare Origin Certificate (valid up to 15 years, no ACME / auto-renewal needed) plus Authenticated Origin Pulls so the origin only accepts connections from Cloudflare:

```bash
# 1. Origin Cert only — encrypts CF ↔ origin, but a leaked origin IP can still be hit directly
vibedeckx start \
  --cert /etc/vibedeckx/cf-origin.pem \
  --key  /etc/vibedeckx/cf-origin.key

# 2. Origin Cert + Authenticated Origin Pulls (mTLS) — origin rejects any request that
#    doesn't present Cloudflare's client cert, so direct hits on the origin IP are dropped
#    at the TLS layer. Download the CA from:
#    https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem
vibedeckx start \
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
- TLS mode skips the auto-open-browser step on launch — the certificate is for the public hostname, so opening `https://localhost:<port>` would just trigger a cert-mismatch warning. Visit your public URL through Cloudflare instead.

### `vibedeckx connect`

Runs in reverse-connect mode: starts a local server bound to `127.0.0.1` and tunnels it to a remote vibedeckx instance. Useful when the remote machine can't be reached directly (e.g. behind NAT) but can dial out.

| Flag | Description |
|------|-------------|
| `--connect-to <url>` | URL of the remote vibedeckx server (required) |
| `--token <value>` | Authentication token for the reverse connection (required) |
| `--port <number>` | Local port (default: random) |
| `--data-dir <path>` | Directory for the SQLite database (default: `~/.vibedeckx`) |

```bash
vibedeckx connect --connect-to https://example.com --token abc123
```

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
- **Remote Projects**: Connect to remote vibedeckx servers to manage projects on remote machines

## Remote Project Support

Vibedeckx supports connecting to remote vibedeckx servers, allowing you to manage projects on remote machines through a local UI.

### Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│  Browser UI  │◄───►│  Local vibedeckx    │◄───►│ Remote vibedeckx │
│  (Next.js)   │     │  (Management)       │     │  (Execution)     │
└──────────────┘     └─────────────────────┘     └──────────────────┘
                            │                           │
                            ▼                           ▼
                      Local SQLite                Remote Agent
                    (all project data)           (execution only)
```

**Data Storage** (managed locally, executed remotely):
- **Local SQLite**: stores all project configuration (the local database is the source of truth)
  - Project info (name, path, remote connection config)
  - Executor config (command, working directory)
  - Remote connection info (URL, API key)
- **Remote Server**: handles execution only
  - Runs agent sessions (accessing the remote filesystem)
  - Executes Executor commands
  - Browses remote directories

### Setting Up a Remote Server

1. Start vibedeckx on the remote machine with an API key:

```bash
# On the remote server
VIBEDECKX_API_KEY=your-secret-key vibedeckx start --port 5174
```

The `VIBEDECKX_API_KEY` environment variable enables API authentication. All API requests must include the `X-Vibedeckx-Api-Key` header.

2. Ensure the port is accessible from your local machine (firewall rules, SSH tunneling, etc.)

### Connecting to a Remote Server

1. In the UI, click "Create Project" and select the **Remote** tab

2. Enter the remote server details:
   - **Remote Server URL**: e.g., `http://192.168.1.100:5174`
   - **API Key**: The key set via `VIBEDECKX_API_KEY` on the remote server

3. Click **Test** to verify the connection

4. Once connected, browse the remote filesystem and select a project directory

5. Enter a project name and click **Create Project**

### How It Works

- **Connection Config**: Remote project connection details (URL, API key) are stored locally
- **Request Proxying**: All API requests for remote projects are proxied through your local vibedeckx server
- **WebSocket Proxying**: Agent session WebSocket connections are transparently proxied to the remote server
- **Data Locality**: Project files and agent processes run on the remote server; only the UI runs locally

### Security Considerations

- API keys are stored in plain text in the local SQLite database
- Use HTTPS in production environments
- Consider SSH tunneling for secure connections over untrusted networks:

```bash
# Create an SSH tunnel to the remote server
ssh -L 5174:localhost:5174 user@remote-server

# Then connect to http://localhost:5174 in the UI
```

### Remote Project Indicators

Remote projects are visually distinguished in the UI:
- A **Remote** badge appears next to the project name
- The path shows the remote URL prefix (e.g., `http://server:5174:/path/to/project`)

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
