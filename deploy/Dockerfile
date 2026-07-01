# Runtime image for Vibedeckx, built FROM the pack.sh platform tarball.
#
# Build the tarball on the host first:
#     ./scripts/pack.sh platform        # -> dist-out/vibedeckx-<ver>-linux-x64.tar.gz
# then:
#     docker compose -f deploy/docker-compose.yml build
#
# IMPORTANT: glibc base, NOT alpine. The bundled better-sqlite3 / node-pty
# prebuilts are compiled against glibc; musl (alpine) would fail to load them.
# Node 24 matches the ABI the tarball is currently built/run with.
FROM node:24-bookworm-slim

# Tarball filename under dist-out/. Override with --build-arg TARBALL=...
ARG TARBALL=vibedeckx-0.1.0-linux-x64.tar.gz

# Install the self-contained app globally -> /usr/local/bin/vibedeckx.
# bundleDependencies:true in the platform package means NO native rebuild here.
COPY dist-out/${TARBALL} /tmp/vibedeckx.tar.gz
RUN npm install -g /tmp/vibedeckx.tar.gz && rm -f /tmp/vibedeckx.tar.gz

# SQLite data dir — mounted as a volume at runtime so writes bypass overlayfs
# (overlay + SQLite/WAL is slow and fragile; a volume gives native disk perf).
VOLUME ["/data"]

# Documentation only; with host networking this is moot but kept for clarity.
EXPOSE 8444

# TLS paths and secrets come from the environment (see docker-compose.yml):
#   VIBEDECKX_TLS_CERT / VIBEDECKX_TLS_KEY / VIBEDECKX_TLS_CLIENT_CA
#   CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY
ENTRYPOINT ["vibedeckx", "start"]
CMD ["--auth", "--no-local-projects", "--host", "0.0.0.0", "--port", "8444", "--data-dir", "/data"]
