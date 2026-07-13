# Connect Daemon Design

Date: 2026-07-13
Status: Approved

## Problem

SaaS users start a remote node with one command:

```bash
npx vibedeckx@latest connect --connect-to <url> --token <token>
```

When that command runs in an SSH session, closing the session also stops the
remote node. `nohup` solves only the immediate terminal problem, while a manual
systemd setup undermines the one-command onboarding experience.

## Scope

The first version adds built-in daemon management for Linux:

```bash
npx vibedeckx@latest connect --connect-to <url> --token <token> --daemon
npx vibedeckx@latest connect status [--data-dir <path>]
npx vibedeckx@latest connect stop [--data-dir <path>]
```

The daemon survives SSH disconnection. It does not restart after a crash and
does not start automatically after a machine reboot. Those guarantees require
an external service manager and are intentionally out of scope.

Only one connect daemon may use a data directory. Users who need multiple
connections must give each one a distinct `--data-dir`.

## CLI compatibility

Foreground behavior remains unchanged:

```bash
npx vibedeckx@latest connect --connect-to <url> --token <token>
```

The `connect` route becomes a route map whose default command is the existing
connect operation. `status` and `stop` are nested commands. Therefore existing
`connect --flag ...` invocations continue to select the default command, while
`connect status` and `connect stop` do not require connection credentials.

`--daemon`, `connect status`, and `connect stop` fail with a clear unsupported
platform message outside Linux in this first version.

## Process architecture

The real platform CLI process daemonizes itself. It does not invoke `npx`, the
thin wrapper package, `nohup`, a shell, or systemd.

When the connect handler receives `--daemon`, it:

1. Resolves the data directory and inspects its daemon state.
2. Rejects a live existing daemon and safely removes a verified stale state.
3. Removes `--daemon` and the token value from the child argument list.
4. Spawns `process.execPath` with the current platform `dist/bin.js` and the
   remaining connect arguments.
5. Sets `detached: true` and uses ignored stdin/stdout/stderr plus one temporary
   IPC channel.
6. Passes the token in an internal environment variable and marks the child as
   the internal daemon process.
7. Waits up to 15 seconds for a structured IPC `ready` or `error` message.
8. On `ready`, disconnects IPC, unreferences the child, prints the PID, target,
   and log path, then exits successfully.

The detached child reads and immediately deletes the internal token environment
variable before it can be inherited by agent or executor processes. It then
runs the normal connect startup. The child sends `ready` after SQLite and the
local Fastify server are ready and the reverse-connect client has begun its
connection attempt.

`ready` does not mean the SaaS endpoint is currently reachable. Temporary
upstream unavailability is not an initialization failure because the existing
`ReverseConnectClient` reconnects indefinitely.

The child runs the platform `dist/bin.js` directly. The initial npx and thin
wrapper processes exit after the handshake and are not part of the daemon
process tree.

## State and process identity

Each data directory has one state file:

```text
<data-dir>/run/connect.json
```

It is created with mode `0600` and contains no credentials:

```json
{
  "schemaVersion": 1,
  "pid": 12345,
  "processStartTicks": "987654321",
  "startedAt": "2026-07-13T10:00:00.000Z",
  "connectTo": "https://app.example.com",
  "version": "0.2.0"
}
```

The daemon child creates the file with exclusive `wx` semantics before opening
the database. This is the final duplicate-start guard: if two daemon commands
race after the parent-side preflight, only one child can claim the data
directory.

Linux may reuse a dead process's PID. Every operation therefore compares both
the PID and field 22 (`starttime`) from `/proc/<pid>/stat` with the stored
`processStartTicks`. A signal is sent only when both match. A missing process or
mismatched start time makes the state stale, never live.

On graceful exit, a daemon removes the state file only if it still contains its
own PID and start time. A crash or `SIGKILL` may leave stale state, which the
next daemon start validates and removes. Invalid JSON or an unrecognized schema
is not deleted automatically because ownership cannot be established safely.

## Command behavior

### Start

A successful start prints:

```text
Vibedeckx connect started in background (PID 12345).
Target: https://app.example.com
Logs: /home/user/.vibedeckx/logs/vibedeckx.log
```

A duplicate start names the existing PID and returns a non-zero exit code. If
the child exits before readiness, reports an initialization error, or does not
become ready within 15 seconds, the parent reports failure and returns non-zero.
On timeout the parent terminates the child so a command that reports failure
does not silently leave a daemon behind.

### Status

`connect status` validates the state against `/proc`.

A running daemon returns exit code zero and prints its PID, start time, target,
and log path. A missing, stale, corrupt, or unsupported state returns non-zero.
Status describes only the daemon process; it does not claim that the
reverse-connect tunnel is online.

### Stop

`connect stop` validates the PID and start time before sending `SIGTERM`. It
waits for the process to exit, allowing the existing connect cleanup to close
the reverse client, Fastify server, SQLite storage, and logging streams. A
second stop of an already stopped daemon is idempotent, prints that it is not
running, and returns zero.

No signal is sent for stale, malformed, or mismatched state. In particular, a
reused PID can never cause an unrelated process to be stopped.

## Secrets

The original interactive npx command necessarily contains the token supplied
by the user. The long-running daemon does not:

- the parent removes `--token` and its value from the child argv;
- the token travels through a private internal environment variable;
- the child captures and deletes that variable immediately;
- state, IPC responses, startup output, and logs never include it.

The connect token CLI parameter becomes runtime-resolved: the public flag is
preferred, and the internal environment variable is accepted only for the
daemon child. A missing token still fails before server initialization.

## Code organization

A new `connect-daemon.ts` module owns:

- daemon state parsing, exclusive creation, and conditional removal;
- `/proc` start-time parsing and process identity validation;
- detached spawn and IPC readiness handling;
- status formatting and stop behavior;
- removal of sensitive arguments from the child invocation.

`command.ts` retains CLI definitions and the normal connect lifecycle. It calls
the daemon module for start/status/stop and notifies the daemon parent once the
normal child initialization has completed.

The existing npm thin wrapper continues to forward signals for foreground use.
Daemon children bypass it, so no wrapper changes are required unless tests show
that the published platform entrypoint cannot be reliably resolved from
`process.argv[1]`.

## Error handling

- Unsupported platform: fail before reading or writing daemon state.
- Live duplicate: show the PID and refuse to start.
- Verified stale state: remove it during daemon start, then proceed.
- Malformed or unknown state: refuse automatic cleanup and print its path.
- Child error/exit before `ready`: return non-zero and do not report success.
- Readiness timeout: terminate the child and return non-zero.
- Missing daemon during stop: return zero.
- PID/start-time mismatch: return safely without sending a signal.
- Graceful shutdown failure: preserve the existing five-second forced-exit
  behavior; later commands treat any leftover state as stale.

## Testing

Unit tests cover:

- parsing Linux `/proc/<pid>/stat`, including process names with spaces or
  parentheses;
- live, missing, stale, reused-PID, malformed, and unknown-schema states;
- exclusive state creation under concurrent startup;
- conditional state cleanup that cannot delete another daemon's state;
- token removal from child argv and immediate environment cleanup;
- status exit codes and output;
- idempotent stop and the no-signal guarantee for identity mismatch;
- IPC ready, child-exit, child-error, and timeout paths;
- Linux-only guards.

Subprocess integration tests cover:

- existing foreground connect syntax remains accepted;
- `--daemon` returns while the detached child remains alive;
- a second daemon for the same data directory is rejected;
- `connect status` finds the correct instance;
- `connect stop` terminates it and removes state;
- the daemon command line, state file, and user-visible output do not contain
  the token.

Build and type-check verification ensure the new module is included in the
single-file platform bundle and the published thin-wrapper layout still starts
the correct platform entrypoint.
