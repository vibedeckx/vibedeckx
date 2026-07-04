# Logging Design — Rotating File Logs for Server & Remote

Date: 2026-07-04
Status: Approved (defaults confirmed: 14 files × 10MB; console-bridge only this phase)

## Problem

The backend has no logging infrastructure:

- Fastify is created without a `logger` option (`server.ts:132`) — its logger is disabled.
- ~355 bare `console.log/warn/error` calls across `packages/vibedeckx/src` write to stdout/stderr with no level control, no structure, and no persistence.
- Docker deployment (`deploy/`) captures stdout only via Docker's default json-file driver — logs vanish with the container and are unbounded on disk.
- Remote nodes (`vibedeckx connect`, same package/binary) run in the background where stdout is easily lost entirely.

## Goals

1. All existing log output persists to rotating files, surviving restarts and container recreation.
2. Zero changes required at the 355 existing `console.*` call sites.
3. One mechanism covers all three deployment shapes: local CLI, Docker hub, remote reverse-connect node.
4. Log level configurable per instance (`--log-level` flag, `VIBEDECKX_LOG_LEVEL` env).
5. stdout behavior stays useful: `docker logs` and terminal output remain human-readable.

Non-goals (phase 2): `/api/logs` endpoint, UI log viewer, pulling remote logs to the hub through the reverse-connect tunnel, migrating hot files to per-module child loggers.

## Decision

**pino + `pino.multistream` with an in-process `rotating-file-stream` destination, plus a global console bridge installed at startup.**

Alternatives rejected:

- *Docker logging driver only* — doesn't cover non-Docker remote nodes or local CLI; no levels or structure.
- *winston/log4js* — second ecosystem; Fastify already ships pino.
- *pino worker-thread transports (`pino.transport({target: "pino-roll"})`)* — **not viable here**: `dist/bin.js` is a single esbuild bundle (`esbuild.config.mjs`, `bundle: true`, only native modules external). Worker transports resolve their target by module name at runtime, which fails inside a bundle. In-process streams bundle cleanly.

## Architecture

### 1. `src/logger.ts` (new)

- `setupLogging({ dataDir, level }): pino.Logger`
  - Creates `<dataDir>/logs/` (default dataDir: `~/.vibedeckx`, Docker: `/data`).
  - Root pino logger over `pino.multistream`:
    - **stdout**: `pino-pretty` inline stream (`sync: true`, colorize only when TTY, `ignore: pid,hostname`) — keeps terminal and `docker logs` line-oriented and readable.
    - **file**: `rotating-file-stream` writing NDJSON to `<dataDir>/logs/vibedeckx.log`, rotated **daily and at 10MB**, keeping **14 rotated files** (uncompressed — bounded at ~140MB worst case; avoids compression edge cases in slim containers).
  - Level: `--log-level` flag > `VIBEDECKX_LOG_LEVEL` env > `info`. Invalid values fall back to `info` with a warning.
  - Installs the **console bridge**: replaces `console.log/info` → `logger.info`, `console.warn` → `logger.warn`, `console.error` → `logger.error`, `console.debug` → `logger.debug`. Arguments are rendered with `util.format` (Error objects keep their stacks).
  - Installs `uncaughtException` / `unhandledRejection` handlers: log at `fatal`, then `process.exit(1)` — preserves current crash semantics while capturing the trace to file.
- `getLogger()` — returns the root logger; before `setupLogging` runs (e.g. unit tests importing `createServer`) it lazily returns a plain stdout pino so nothing crashes.

### 2. Wiring

- `command.ts`: both `start` and `connect` handlers call `setupLogging` first thing, using the same dataDir resolution as the DB path; both commands gain a `--log-level` flag. Output printed before this point (load-env messages) remains stdout-only — accepted.
- `server.ts`: `fastify({ loggerInstance: getLogger().child({ mod: "http" }), disableRequestLogging: true, ... })` — Fastify's own errors (hook/handler failures, currently silent or manually consoled) flow into the same sinks; per-request access logging stays off to avoid noise.

### 3. Docker

- File logs land in `/data/logs` — **already inside the existing `/data` volume**; no new mounts. Visible on the host at `<runtime-dir>/data/logs/`.
- `deploy/docker-compose.yml` additionally caps the stdout copy: `logging: { driver: json-file, options: { max-size: 10m, max-file: "3" } }` so the duplicate stdout stream can't grow unbounded.

### 4. Remote nodes

Nothing extra: `connect` shares `setupLogging`, so each remote machine writes its own `<data-dir>/logs/vibedeckx.log` with the same rotation policy. Hub-side viewing of remote logs is phase 2; until then `tail -f ~/.vibedeckx/logs/vibedeckx.log` on the remote host.

## Error handling & edge cases

- Logs dir creation failure (read-only FS): warn to stdout, continue with stdout-only logging — logging must never prevent boot.
- Process exit: file stream is buffered; a hard `process.exit` may drop the last few lines. Fatal-path handlers log before exiting, which covers the important case (crashes). Accepted trade-off.
- The bridge must never recurse: pino writes directly to streams, never through `console`.

## Testing

- Unit test (`src/logger.test.ts`, vitest): `setupLogging` against a temp dir → console bridge writes an NDJSON line with expected level/msg to the file; level filtering drops below-threshold lines; `getLogger()` works pre-init. Console globals restored after each test.
- Build verification: `pnpm build` (esbuild bundle must include pino/pino-pretty/rotating-file-stream without errors), backend `tsc --noEmit`.
- Smoke: run `dist/bin.js start` with a temp `--data-dir`, confirm `logs/vibedeckx.log` receives startup lines, stdout stays readable.

## Dependencies added

`pino` (direct, was transitive via fastify), `pino-pretty`, `rotating-file-stream` — all pure JS, bundle-safe.
