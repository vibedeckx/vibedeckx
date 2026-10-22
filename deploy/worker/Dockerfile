# syntax=docker/dockerfile:1
# Base image for a Vibedeckx reverse-connect WORKER (runs agents and builds
# projects; dials out to a hub). Not the server image — see ../Dockerfile.
#
# Published as ghcr.io/vibedeckx/worker by .github/workflows/release.yml on
# every release tag, installing vibedeckx@<version> from npm. Local build
# (from the repo root; packs the platform tarball first):
#     ./deploy/worker/build.sh
#
# Projects usually need more than this (language toolchains, build tools):
# extend it with `FROM vibedeckx-worker:<tag>` and install them there.
#
# Lifecycle is Docker's job (worker-supervision-design §5): `restart:
# unless-stopped` recovers crashes and starts it with dockerd at boot. Stop,
# restart and "keep it off" are host-side `docker` commands; inside the
# container only `vibedeckx connect status` is supported.

# glibc base, NOT alpine: the bundled better-sqlite3 / node-pty prebuilts are
# compiled against glibc.
FROM node:24-bookworm-slim

# What `npm install -g` gets for vibedeckx: an npm spec (CI passes
# vibedeckx@<version>) or a tarball under the dist-out/ bind mount (build.sh
# passes /tmp/dist-out/vibedeckx-<ver>-linux-<arch>.tar.gz).
ARG VIBEDECKX_PACKAGE=vibedeckx@latest
# Agent CLIs baked into the image: the versions current at build time. They are
# a starting point, not the only source — see the PATH note below.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates procps curl \
 && rm -rf /var/lib/apt/lists/*

# Bind-mounted, not COPY'd: the tarball stays out of the image layers, and an
# empty dist-out/ (CI) is fine.
RUN --mount=type=bind,source=dist-out,target=/tmp/dist-out \
    npm install -g "${VIBEDECKX_PACKAGE}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# Run as a normal user: Claude Code refuses --dangerously-skip-permissions as
# root. The node image's `node` user (uid 1000) is used.
#
# Everything that must survive recreating the container is a volume; the
# directories exist here (owned by `node`) so fresh named volumes inherit the
# ownership:
#   /data                         data-dir: SQLite, token, logs
#   /home/node                    agent credentials (~/.claude, ~/.claude.json,
#                                 ~/.codex), git and ssh config
#   /var/tmp/vibedeckx/worktrees  git worktrees the worker creates
#   /projects                     project checkouts
RUN mkdir -p /data /projects /var/tmp/vibedeckx/worktrees \
 && chown -R node:node /data /projects /var/tmp/vibedeckx /home/node
VOLUME ["/data", "/home/node", "/var/tmp/vibedeckx/worktrees", "/projects"]

USER node
WORKDIR /home/node

# The worker reads everything from the environment; nothing goes on argv.
#   VIBEDECKX_CONNECT_TO           hub URL (required)
#   VIBEDECKX_CONNECT_TOKEN_FILE   token file, e.g. a Docker secret (preferred)
#   VIBEDECKX_CONNECT_TOKEN        token value (alternative)
ENV VIBEDECKX_DATA_DIR=/data \
    VIBEDECKX_INSTALL_MODE=docker \
    VIBEDECKX_SUPERVISOR=docker \
    NODE_ENV=production

# Agent CLIs the user installs later live in the /home/node volume, so they
# survive recreating the container (= upgrading the image) and win over the
# baked-in copies on PATH:
#   ~/.local/bin       Claude Code's native installer (claude.ai/install.sh)
#   ~/.npm-global/bin  `npm install -g` as `node` (the default prefix,
#                      /usr/local, is root-owned)
# The worker caches a "binary not found" lookup per process, so restart the
# container after installing one.
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global \
    PATH=/home/node/.local/bin:/home/node/.npm-global/bin:$PATH

# Liveness only (local, no network): the main loop is heartbeating. An
# unhealthy container is reported, not restarted — Docker restarts on exit.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["vibedeckx", "connect", "status"]

ENTRYPOINT ["vibedeckx", "connect"]
