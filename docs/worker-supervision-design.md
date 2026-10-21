# Worker Supervision Design

Date: 2026-10-19
Status: Draft (rev 2: incorporates review feedback)

## 1. Problem

On 2026-10-19, around 02:55 UTC, the host hard-reset the worker3 VM. The
reverse-connect worker (`vibedeckx connect`) stayed down until someone logged
in and started it by hand. Earlier incidents on the same machine looked
similar: earlyoom SIGTERMed the worker and nothing restarted it.

`connect --daemon` ([design](plans/2026-07-13-connect-daemon-design.md)) only
keeps the worker alive after the SSH session closes. It explicitly does not
restart after a crash or start on boot, and it only works on Linux.

Workers need to run on Linux, macOS, Windows (later) and in Docker. We want one
approach for all of them, not a separate design per platform.

## 2. Principle: separate the worker from its supervisor

The worker promises a single runtime contract (§3) that does not depend on the
platform. Starting on boot and recovering from crashes are handled by thin
adapters over each platform's native service manager (§4). Apart from the
install-mode marker (§6.4), the worker does not know or care what supervises
it.

We do **not** build our own supervisor or watchdog parent process. It could
recover from crashes, but it cannot start anything on boot. Only the OS can do
that, so the OS service manager is involved either way, and it already handles
both jobs.

## 3. Worker runtime contract

### 3.1 Supervisor semantics (required of every adapter)

The adapters have to provide the same lifecycle semantics. They do not have to
use the same mechanism:

| Situation | Required behavior |
|---|---|
| Machine boots | Worker starts if auto-start is enabled (subject to the platform limits in §4) |
| Abnormal exit (crash, SIGKILL, OOM/earlyoom SIGTERM) | Worker restarts after a delay. Crash loops back off and are never permanently abandoned. This includes repeated *startup* failures: the adapter must not end up in a terminal "failed" state (§4.2) |
| Stop (`connect stop`) | Worker stops and **stays stopped until the next boot or an explicit start**. Auto-start is unchanged |
| Disable (`connect disable`) | Worker stops **and auto-start is paused**, so it stays stopped across reboots until `connect enable` |
| Controlled restart (config reload, later upgrade) | Worker restarts at the user's or worker's request |

"Stop" and "disable" are deliberately separate, because the native tools
differ on this. `systemctl stop` does not touch the boot-time enablement, and a
`launchctl bootout` of a LaunchAgent lasts only until the next login. `docker stop` on an `unless-stopped` container
does persist across a daemon restart. We only promise semantics for our own
`connect stop` / `connect disable` commands, which each adapter maps to the
right native operation (§4). Running the native tool directly (for example
`systemctl stop`) gets that tool's documented behavior, not ours.

Today a SIGTERM cleanup exits with code 0 ([`command.ts`](../packages/vibedeckx/src/command.ts),
connect `cleanup` handler). An earlyoom kill therefore looks like a clean exit,
and an "on-failure" policy would not recover from it. Each adapter must map
these rows correctly. For example, the worker can exit with a reserved
non-zero code for a controlled restart, or the adapter can restart on any exit
not caused by an explicit stop. The adapter-by-adapter mapping is in §4.

### 3.2 Foreground, configure once

- The worker runs in the foreground and the supervisor owns its lifecycle.
  `--daemon` remains, but only for starting a worker by hand over SSH.
- `vibedeckx connect setup` saves the configuration in `<data-dir>`. After
  that, `vibedeckx connect` with no flags runs from the saved config.
- **The running worker never has the token on its command line.** `setup` /
  `install` take it from `--token` (the command copied from Settings → Remote
  Servers), a hidden interactive prompt, stdin (`--token-stdin`), or
  `--token-file <path>`, and store it in its own file: mode `0600` on Unix, an
  ACL limited to the user on Windows. `--token` on these short-lived commands
  is visible in `ps` only for the seconds they run (the same shell-history
  exposure as before). On a long-running foreground `connect --token`
  ([`resolveConnectToken`](../packages/vibedeckx/src/connect-daemon.ts)) it
  keeps working for compatibility, with a warning. Generated service files
  never contain a token.
- **Precedence**, from highest to lowest: CLI flags > environment variables >
  saved config. Environment variables: `VIBEDECKX_CONNECT_TO`,
  `VIBEDECKX_CONNECT_TOKEN`, `VIBEDECKX_CONNECT_TOKEN_FILE` (Docker secrets
  convention), `VIBEDECKX_DATA_DIR`. If more than one token source is set *at
  the same level* (e.g. `--token` and `--token-file`, or `_TOKEN` and
  `_TOKEN_FILE`), the command fails with an error rather than picking one.

### 3.3 Failure classes: stay alive, but always have a way back

Once started, the worker stays alive through the failures below, so the
supervisor never sees a config problem as a crash loop. Each class also has an
explicit way to recover:

| Class | Behavior | How it recovers |
|---|---|---|
| Network / hub unreachable | Reconnect with exponential backoff and random jitter, without limit (today's `ReverseConnectClient` behavior plus jitter) | Automatic |
| Token rejected (revoked / invalid) | State `auth-failed`. Retry slowly (e.g. every 10 min) and log each attempt. **Every retry re-reads the token file**, so recovery does not depend on the file watcher | Faster recovery when the token file changes (watch below), or `connect setup` / `connect restart` with a new token |
| Pinned identity mismatch ([preflight](../packages/vibedeckx/src/connect-preflight.ts)) | State `blocked`. **No retry**, because retrying cannot fix a token that belongs to a different remote | Explicit re-pin: `connect setup --force` (today's `--force`), then restart |

The token watch is only an accelerator:

- It watches the **containing directory**, not the file, so that an atomic
  replace (write-temp + rename, which is how Docker/Kubernetes secrets and
  `setup` update the token) is still seen.
- If the watch errors or is lost, the worker falls back to the periodic re-read
  above and re-establishes the watch.
- A changed token goes through the **same identity-pin preflight as a fresh
  start** before it is used to reconnect. A token for a different remote moves
  the worker to `blocked`; it is never connected under it.

Today the pin mismatch throws during preflight and the process exits. Under an
always-recover supervisor that becomes a crash loop that also calls the hub on
every attempt. This change is required.

`connect status` must report the state (`connected` / `connecting` /
`auth-failed` / `blocked`) together with the reason and the fix, so that
"alive but permanently offline" is always visible and actionable.

### 3.4 Graceful shutdown

On SIGTERM the worker shuts down gracefully, including its agent child
processes. In Docker it runs with `init: true` (tini) so orphaned processes get
reaped.

### 3.5 Single instance per data-dir: defined by behavior, not by mechanism

Requirements:

- At most one worker may hold a data-dir. This has to work across processes
  **and across PID namespaces on the same host**, i.e. two containers sharing
  one volume.
- The lock is released automatically when the worker process dies, including
  on SIGKILL.
- **Agent and executor child processes must not inherit or hold the lock.** A
  surviving child must never keep a data-dir locked after the worker has died.
- Version 1 supports **local filesystems only**. NFS/SMB data-dirs are not
  supported, and the docs say so.
- **Lock first, then touch anything.** Every entry point (foreground, `--daemon`
  child, service, Docker) must take the data-dir lock **before** it:
  - opens the main database,
  - runs the identity-pin preflight (the pin lives in the data-dir's settings),
  - writes `run/connect.json` or any other run state,
  - connects to the hub.

  An instance that loses the race exits with a clear "data-dir in use" error
  and must not modify any shared state. Read-only commands (`status`) never
  take the lock.

Implementation is chosen per platform. Node's `fs` has no `flock`, so a
dependency or native call is required. Candidates:

- Unix: `fcntl`/`flock` through a small native helper.
- Windows: `LockFileEx`.
- Possible single implementation: an exclusive lock on a dedicated lock file
  held through `better-sqlite3`, which we already ship. SQLite uses `fcntl` on
  Unix and `LockFileEx` on Windows, and `fcntl` locks are not inherited across
  `fork`.

Whatever is chosen must be tested against the inheritance requirement.

The lock **only provides mutual exclusion**. `status` and `stop` still need a
verified process identity to know *which* process to query or signal.
`run/connect.json` (PID + start-time identity) stays for that purpose, and it
is valid **only inside the PID namespace that wrote it**. Version 1 therefore
scopes CLI lifecycle control as follows:

- **Native installs:** `connect status/stop/start/restart` work as specified
  in §3.7.
- **Docker:** the container's lifecycle is managed **from the host with the
  Docker CLI** (`docker start/stop/restart`, `compose up/down`). Inside the
  container, `docker exec <c> vibedeckx connect status` is supported, because
  `exec` joins the worker's own PID namespace. Container-side
  `connect stop/start/disable` are not supported and print a pointer to the
  Docker commands; a stopped container cannot run its own CLI anyway. A *second*
  container on the same volume can only learn that the data-dir is locked. It
  cannot query or control the holder.
- A local control channel (Unix socket / named pipe in the data-dir) that would
  lift these limits is out of scope for version 1.

### 3.6 Health: liveness vs readiness

- **Liveness** ("the process is healthy"): local, fast, no network. A check
  over the control channel or a short-lived status file that the event loop
  rewrites periodically.
- **Readiness** ("connected to the hub"): reports the state from §3.3. Also
  local; it reads what the worker already knows and never dials the hub.
- Health checks must **never** trigger the npm version query.
  `describeConnectDaemon` currently calls `fetchLatestPublishedVersion` on
  every `status` call. That query moves behind an explicit flag, e.g.
  `status --check-update`.
- In Docker, `HEALTHCHECK` only *reports* health. An `unhealthy` container is
  **not** restarted by `restart: unless-stopped`, which reacts only to the
  process exiting.
- **Version 1 detects and reports a wedged worker; it does not promise to
  recover it automatically.**
  - Liveness turns stale when the main event loop stops updating it, and
    `status` and the Docker health status both show this.
  - A timer on the main event loop cannot fix a stalled main loop, because the
    timer would stall too.
  - Automatic recovery is a separate follow-up. The likely mechanism is a
    `worker_threads` watchdog that sees main-loop heartbeats stop and sends
    SIGKILL to its own process, letting the supervisor restart it.

### 3.7 Lifecycle commands

| Command | Semantics |
|---|---|
| `connect start` | Start the worker. Under a service, delegate to the service manager; otherwise behave like `--daemon` |
| `connect stop` | Stop it until the next boot or `start`. Under a service, stop it through the service manager so the crash-recovery policy does not immediately restart it. Auto-start is unchanged |
| `connect disable` / `enable` | Pause / resume auto-start. `disable` also stops the worker; `enable` also starts it. Persists across reboots |
| `connect restart` | Controlled restart (§3.1) |
| `connect status` | Identity, version, state (§3.3), how it is supervised, log path. No network unless `--check-update` |
| `connect install` | Register auto-start (§4.1) |
| `connect uninstall` | Remove auto-start only. **Keeps the data-dir, token and runtime by default** |

## 4. Supervisor adapters

The worker always runs **as a specified, non-root user**. That is normally the
installing user, because it needs that user's `claude`/`codex` credentials,
`HOME`, `PATH` and git config. Where the platform runs the *service
definition* (user-level or system-level) is a separate, per-platform choice.

| | Linux | macOS | Windows | Docker |
|---|---|---|---|---|
| Mechanism | systemd user unit + `loginctl enable-linger` | launchd LaunchAgent (opt-in LaunchDaemon with `UserName` for unattended Macs) | per-user scheduled task that launches `connect supervise` (§4.3) | dockerd |
| Boot start | via linger | LaunchAgent: after the user logs in. LaunchDaemon: at boot | after the user logs in (logon trigger) | dockerd enabled at boot |
| Crash recovery (§4.2) | `Restart=always` + rate-limit settings | `KeepAlive=true` + `ThrottleInterval` | worker: `supervise` restarts it with backoff. `supervise` itself: the task's 1-minute repetition trigger | `restart: unless-stopped` |
| `connect stop` → | `systemctl --user stop` | `launchctl bootout` (plist stays in place, so it loads again at next login/boot; a plain `kill` would be relaunched by `KeepAlive`) | stop marker for this boot + `stop` over the control pipe (not `schtasks /End`, §4.3) | host-side `docker stop` (§3.5) |
| `connect disable` → | `systemctl --user disable --now` | `launchctl bootout` + `launchctl disable` | `schtasks /Change /DISABLE` + `quit` over the control pipe | host-side `docker update --restart=no` + `docker stop` |
| Config source | file written by `setup` | same | same | env vars / secret + data volume |
| Generated by | `connect install` | same | same | published image + compose template |

### 4.1 `connect install` requirements

1. If nothing is configured yet, run `setup` first, so token input follows
   §3.2.
2. Install the runtime into the layout in §6 and generate the stable launcher.
3. Take a snapshot of `PATH` so that `claude`, `codex` and `git` resolve.
   Service environments do not load shell profiles, so fnm and nvm are not
   active there.
4. Write the platform service definition, pointing at the launcher.
5. Enable and start the service.

Also required:

- **Idempotent.** Re-running it updates the definition in place and never
  creates a second service. A running service is restarted only when
  something it uses changed (runtime build/`current`, launcher, saved token
  or hub URL, the rendered definition, or `--force`), or when its heartbeat
  shows an older version; otherwise it is left running, since a restart
  kills its agent sessions. A stopped service is always started.
- **Connected, not just running.** If the worker's first settled state is
  `blocked` or `auth-failed`, install exits non-zero with the status
  `detail`/`fix`. The service stays installed and recovers by itself.
- **Recoverable.** If it fails part-way, the data-dir and every previously
  installed runtime version stay intact, and it reports what happened.
  Re-running `connect install` brings the service up; `connect uninstall`
  cleans up whatever was left behind. A worker that was running before the
  install is **not** guaranteed to be running after a failed install.
- **Migration.** If a `--daemon` worker is already running on the same
  data-dir, it is stopped (with identity verification) only after everything
  else is in place. That stop is the last step before the service starts, so
  the two do not fight over the lock. If starting the service then fails, the
  command restarts the previous `--daemon` worker as a best effort before
  reporting the error; if that fails too, it tells the user to re-run.
- **Privilege.** On Linux, `enable-linger` needs sudo once. The command says
  so instead of failing silently.

### 4.2 Never give up: concrete restart settings

A plain "restart always" is not enough. Every adapter has to say how a crash
loop backs off and how it avoids a terminal "failed" state.

- **systemd.** Minimum supported version: **systemd 240** (Debian 10, Ubuntu
  20.04 and newer); we validate the generated unit on that version.
  - `Restart=always`, `RestartSec=5`.
  - Under `[Unit]`, `StartLimitIntervalSec=0`. This turns off the start rate
    limit, which by default (5 starts in 10 s) moves the unit to `failed` and
    stops retrying.
  - On systemd ≥ 254, the adapter also emits `RestartSteps=` /
    `RestartMaxDelaySec=` (e.g. up to 5 min) for exponential backoff.
  - On older versions, backoff falls back to the fixed `RestartSec`. That is
    acceptable: the rate limit is off and a worker that fails at start costs
    almost nothing every 5 s.
- **launchd.** `KeepAlive=true` with `ThrottleInterval` (e.g. 10 s). launchd
  keeps relaunching throttled jobs and has no terminal failed state.
- **Docker.** `restart: unless-stopped`. Docker doubles the delay between
  restarts, starting at 100 ms and capped (as documented), and never gives up.
  The delay resets after the container has been up for 10 s.
- **Windows.** `connect supervise` restarts the worker on any exit after
  1 s, 2 s, 4 s … capped at 30 s. The backoff resets once the worker has
  stayed up for 10 s. `supervise` never gives up. If `supervise` itself dies,
  the task's repetition trigger relaunches it within a minute (§4.3).

### 4.3 Windows: scheduled task + `connect supervise`

**Decision (2026-10-21, phase-1 prototype on Windows 10 22H2).** Task Scheduler
only *launches*; a small vibedeckx process, `connect supervise`, does the
supervising. Phase 2 (the real implementation) must still pass the full §8
table before this ships.

Why not the native options alone:

- **Task Scheduler.** Its restart-on-failure fires only when the task *fails*,
  has a retry count, and waits at least 1 minute
  ([RestartOnFailure](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element)).
  On its own it does not meet the "any abnormal exit, without limit" row of
  §3.1.
- **Windows Service** (WinSW, node-windows). Not ruled out, but deprioritized.
  To run as the installing user, which the worker needs (§4), a service must
  be given that user's credentials, and installing it needs admin rights. A
  scheduled task needs neither. How a service wrapper treats a clean exit was
  not tested. Revisit only if phase 2 finds the task route unacceptable.

**Shape.**

- One task per data-dir, registered for the current user without admin
  rights: `InteractiveToken`, `LeastPrivilege`.
- Triggers: at logon, plus a time trigger. Both repeat every 1 minute
  indefinitely, with `MultipleInstancesPolicy=IgnoreNew`. The repetition is the
  safety net for `supervise` itself. `RestartOnFailure` (999 × 1 min) is
  kept, but in testing it never recovered `supervise` sooner than the
  repetition did.
- Action: `conhost.exe --headless <node> <supervise>`. An interactive task
  that runs `node.exe` directly is expected to show a console window (not
  tested). Under headless conhost, `GetConsoleWindow()` returned 0 in
  `supervise`. The worker it spawns with `windowsHide` gets a hidden console
  of its own.
- `supervise` owns a named pipe. The pipe is the single-instance guard (it
  disappears with the process, so it never goes stale), and it is the control
  channel: `stop`, `quit`, `restart`. Windows has no SIGTERM (§3.4), so a
  graceful worker stop is "close the worker's stdin", with a forced
  `taskkill /T /F` after a timeout.
- **Stop marker.** `connect stop` records the boot time and the logon SID of
  the session `supervise` runs in (asked over the pipe, so a stop over SSH
  still names the right session), then sends `quit`. A `supervise` launched
  in the same boot and logon session exits immediately. Boot time alone is
  not enough: with Fast Startup (the Windows default) a shutdown hibernates
  the kernel and uptime survives it, which kept a stopped worker stopped
  indefinitely in testing. A shutdown does log every user off, so the session
  check covers it. As with a macOS LaunchAgent, the stop therefore lasts until
  the next login or boot: a logoff and logon start the worker again.
  `connect start` deletes the marker and runs the task.
- **Do not use `schtasks /End` as stop.** It terminates only the task's own
  process (conhost). `supervise` and the worker keep running, outside the
  task's tracking, and no new `supervise` started in the next 100 s. This is
  presumably the pipe guard turning away the repetition's launches, which was
  not checked.

**Prototype results** (fake worker; times are until the worker ran again):

| Scenario | Result |
|---|---|
| Register without admin rights; launch | OK, 2.9 s; no visible console |
| Worker exits 0 / exits 1 / `taskkill /F` | Restarted in 1.4 s / 2.2 s / 1.3 s |
| Worker fails at startup repeatedly | Backoff 1→2→4→8→16 s, never gave up; back 1.7 s after the cause was removed |
| `supervise` exits 0 / exits 1 / `taskkill /F` | Relaunched by the repetition in 46 s / 59 s / 59 s |
| `stop`, then 150 s of repetitions and a plain `/Run` | Stayed stopped (3 launches, all skipped on the marker); `start` 1.0 s |
| `disable` for 150 s, then `enable` | No launches; back 1.2 s after enable |
| Controlled `restart` | 0.1 s |

**Findings that shape phase 2.**

- When `supervise` dies, the worker dies with it at once, with no graceful
  exit. Probable cause: libuv puts non-detached children in a kill-on-close
  Job Object (inferred, not verified in the source). This needs no extra
  code, but the job covers direct children only. Deeper descendants (for
  example an agent's tool processes) can still outlive the worker. Containing
  them needs our own Job Object.
- A worker crash costs about 2 s. A `supervise` crash costs up to about
  1 minute, the minimum repetition interval. `supervise` must stay small.

**Phase 2 results (2026-10-21, `0.3.54-win.2`/`-win.3` from npm on Windows 10
22H2, separate data-dir, unreachable hub):**

| Scenario | Result |
|---|---|
| `npx vibedeckx@… connect install` (no admin) | OK, about 110 s including the npx download and runtime copy |
| Visible windows | None for the whole tree (conhost → cmd → supervise → worker) |
| Worker / `supervise` killed with `taskkill /F` | Back in about 5 s / within a minute; the worker dies with `supervise` |
| `stop`, `start`, `restart`, `disable`, `enable`, re-install, `uninstall` | As specified; re-install leaves a running worker alone |
| Graceful stop (stdin EOF) | The worker ran its shutdown on every stop, restart, disable and uninstall |
| Upgrade `-win.2` → `-win.3` by re-running install | New runtime, `supervise` and worker running again within 2 s |
| Logoff and logon | Starts again after logon |
| Reboot after `stop` | Starts again after logon |
| Fast Startup shutdown after `stop` | `-win.2` (boot time only): stayed stopped, a bug. `-win.3` (logon session): starts again after logon |
| Sleep and wake | Same `supervise` and worker before and after |

Startup right after a boot is slow: about 50 s from node starting to
`supervise` listening. The machine is busy then; this is not a failure.

**Still open**, with the real implementation:

- the worker's single-instance lock (§3.5): a second worker on the same
  data-dir, and that a child does not inherit the lock. The `supervise`
  pipe guard was exercised;
- a hard reset during a runtime install or `current` switch (§6.3);
- a real hub connection and agent sessions on Windows (the test used an
  unreachable hub);
- the token file ACL on a machine where files inherit their ACL. On the test
  machine new files carried explicit SYSTEM/Administrators/user entries,
  which `/inheritance:r` keeps;
- the remaining §8 rows.

## 5. Docker worker image

This is a different job from the server image in `deploy/Dockerfile`. The
worker container runs agents and builds user projects, so:

- **Image contents.** We publish a `vibedeckx-worker` base image with Node,
  vibedeckx, git, ssh, and the `claude`/`codex` CLIs. Users add their own
  toolchains with `FROM vibedeckx-worker`.
- **Non-root user.** Claude Code refuses `--dangerously-skip-permissions` when
  run as root, so the image creates a normal user.
- **Persistent volumes.** Files written to the container's writable layer
  survive `docker restart`, but are lost when the container is **removed and
  recreated** (image upgrade, `compose up` after a config change). These must
  therefore be volumes:
  - the data-dir (SQLite and the token)
  - the worktree root (today `/var/tmp/vibedeckx/worktrees`)
  - project directories
  - agent credentials (`~/.claude`, `~/.codex`)
- **Compose template.** `restart: unless-stopped`, `init: true`, a local
  liveness `HEALTHCHECK` (§3.6), and the token passed as a secret through
  `VIBEDECKX_CONNECT_TOKEN_FILE`.
- **Upgrades** mean changing the image tag, not running npm.
  `MIN_WORKER_VERSION` and the tunnel contract
  ([compat design](server-worker-compat-design.md)) apply unchanged.

## 6. Runtime layout and stable launcher (reserved for automatic upgrades)

Automatic upgrades get their own design document. This section fixes only what
the service definitions and install layout depend on, so that auto-upgrade can
be added later without rewriting any platform's service definition.

### 6.1 One fixed launcher

Every service definition points at **one fixed launcher**
(`<data-dir>/runtime/launcher`, `launcher.cmd` on Windows). We do not choose
between a symlink and a launcher; it is always the launcher.

The launcher:

1. reads `runtime/current`, a small file naming a version;
2. resolves it **once** to the absolute path of `runtime/<version>/`;
3. `exec`s that version's Node with that version's `bin.js`, passing the
   resolved version directory explicitly.

After that, the running process only uses the resolved absolute path. It
never looks anything up through `current` again, so switching `current` while
a worker is running cannot mix files from two versions in one process. The
launcher is tiny and almost never changes. Updating it is an
`connect install` re-run, not part of a normal upgrade.

### 6.2 A version directory is a complete runtime

`runtime/<version>/` contains everything needed to run:

- a **Node binary** matching the ABI the native modules were built against;
- the platform package's `dist/` (including `bin.js`);
- the native modules (`better-sqlite3`, `node-pty`) and any other runtime
  assets.

It never depends on the user's Node: with fnm/nvm, a Node upgrade would
otherwise break the native-module ABI. It never points into the npx cache
(`~/.npm/_npx/<hash>/...`), which is unstable and gets cleaned up.

### 6.3 Installing a version: integrity, atomic switch, safe interruption

- Each version directory is first written to a temporary location, then
  **checked for integrity** against a manifest of file hashes shipped with the
  package, and only then renamed into `runtime/<version>/`.
- `current` is switched **atomically**: write a temporary file, then rename it
  over `current`.
- If install or switch is interrupted at any point, `current` points at
  **either the previous version or the complete new version**. It never points
  at a partial one:
  - Before the rename of `current`, it is still the old version.
  - After the rename, it is the new, already verified version.
- A version directory is never deleted while it is current or is the most
  recent fallback.
- **Durability across a hard reset.** Renames are only atomic with respect to
  crashes if what they point at is already on disk. So:
  1. fsync the staged version's files and its directory before renaming it
     into `runtime/`;
  2. fsync `runtime/` after that rename;
  3. fsync the temporary `current` file before renaming it over `current`;
  4. fsync `runtime/` again after that rename.

  (On Windows, use `FlushFileBuffers` and a rename with `MOVEFILE_WRITE_THROUGH`.)

### 6.4 The worker knows its install mode

- `native-service`: written by `connect install`. The only mode allowed to
  upgrade itself in the future.
- `docker`: the image sets `VIBEDECKX_INSTALL_MODE=docker`. Upgrading inside
  the container is an anti-pattern because recreating the container reverts
  it. The worker only reports that an update is available; the user changes
  the image tag or uses something like watchtower.
- `manual` (`--daemon` / foreground): only reports that an update is
  available.

The install mode is reported to the hub in the handshake frames next to
`version`/`capabilities`. This is an additive field and does not break the
tunnel contract. The UI can then show "auto-upgrading" or "update your image".

### 6.5 Deferred to the auto-upgrade design

The following are tracked as a separate task:

- who triggers an upgrade;
- where the package is downloaded from, and its signature/provenance;
- draining sessions before a restart;
- automatic rollback after crash loops;
- DB migration compatibility on rollback.

## 7. Implementation order

All of this is worker-side and additive. The only tunnel change is the
optional install-mode handshake field (§6.4), which is additive.

1. Configuration: `connect setup` (hidden prompt / `--token-stdin` /
   `--token-file`), saved config, environment variables and `*_FILE`,
   precedence rules and conflict errors (§3.2).
2. Failure classes and states, including turning the pin-mismatch exit into a
   `blocked` state (§3.3).
3. Single-instance lock implementation plus the inheritance test (§3.5).
4. Local liveness/readiness and a network-free `status` (§3.6), plus the
   lifecycle commands (§3.7).
5. Runtime layout, launcher and atomic install (§6.1–6.3).
6. `connect install` / `connect uninstall` for Linux and macOS (§4.1).
7. `vibedeckx-worker` image and compose template (§5).
8. Windows backend (§4.3): chosen by a prototype on 2026-10-21 (scheduled
   task + `connect supervise`); implementation and full §8 verification pending.

User-facing docs go into the worker setup page under `apps/docs/content/docs/`
as each step ships.

## 8. Acceptance scenarios

Each adapter is tested against the rows marked as applying to it. "Native"
means systemd, launchd, and later Windows. Docker is tested through the
host-side Docker CLI and its native semantics (§3.5), not through in-container
`connect` lifecycle commands.

| Scenario | Applies to | Expected |
|---|---|---|
| Host reboot / hard reset | All | Worker is back and connected without manual action (macOS LaunchAgent: after login) |
| Clean exit (code 0, e.g. SIGTERM cleanup) not caused by an explicit stop | All | Recovered |
| SIGKILL / OOM kill | All | Recovered; lock released; no stale state blocks restart |
| `connect stop` | Native | Stays stopped until `connect start` or the next boot; starts again on boot |
| `connect disable` | Native | Stays stopped across reboots until `connect enable` |
| `docker stop` | Docker | Stays stopped, including across reboot / dockerd restart, until `docker start` (native `unless-stopped` semantics) |
| `docker update --restart=no` + `docker stop` | Docker | Stays stopped until the restart policy is restored and the container started |
| In-container `connect stop` / `disable` | Docker | Refused with a pointer to the host-side Docker commands; the worker is unaffected |
| Worker fails at startup repeatedly (e.g. bad runtime, data-dir temporarily unavailable) for longer than the platform's default rate-limit window | All | Keeps retrying with backoff, never stuck in `failed`; recovers by itself once the cause is fixed |
| Main event loop wedged | All | Liveness turns stale and `status` / Docker health report it (automatic recovery is out of scope for v1, §3.6) |
| Token file replaced atomically (rename) | All | Picked up; pin re-verified before reconnecting |
| Token rotated / revoked | All | `auth-failed` shown in `status`; recovers after the new token is written, with no crash loop |
| Pin mismatch | All | `blocked` shown with the fix; no retries against the hub |
| Hub offline for an extended period | All | Reconnects with jitter after the hub returns; no crash loop |
| Duplicate start (second process / second container on the same volume) | All | Second one exits with "data-dir in use" **before** opening the database, running preflight or writing run state; first one is unaffected |
| Child process outlives a killed worker | All | Lock is not held by the child; the worker restarts normally |
| Hard reset during a runtime install or `current` switch | Native | After reboot, `current` is the old or the complete new version and the worker starts |
| `connect install` interrupted part-way | Native | Data-dir and previously installed runtimes intact; re-running `connect install` brings the service up; `connect uninstall` cleans up |
| Re-running `connect install` | Native | Idempotent; one service |
| Migration from a running `--daemon` | Native | Daemon stopped only as the last step, service takes over, no lock fight; if the service fails to start, the daemon is restarted as a best effort |
| Container recreated (image change) | Docker | All persistent state survives |

## 9. Implementation notes (2026-10-19, steps 1–7)

Where the implementation made a choice the design left open, or deviated:

- **Single-instance lock (§3.5)**: an open `BEGIN EXCLUSIVE` transaction on
  `<data-dir>/run/instance.lock` through `better-sqlite3`
  (`connect-instance-lock.ts`). Verified across PID namespaces (host process
  vs. Docker container on the same bind mount, in both directions), release on
  SIGKILL, and that a surviving grandchild never holds it. The held connection
  is kept strongly referenced: better-sqlite3 closes a garbage-collected
  connection, which silently drops the lock. The old directory lock
  (`run/connect.lock`) still serializes `connect.json` edits.
- **Lock-first ordering**: `runConnectWorker` (`connect-worker.ts`) takes the
  lock before claiming `connect.json`, logging, the database, the preflight and
  the hub. A `connect.json` naming a live process without the lock (a worker
  from before this change) is refused with "in use by an older worker".
- **Missing hub URL is fatal everywhere**: with no hub URL from flags, env or
  saved config the worker exits with a clear error even under a supervisor.
  The restart loop never contacts the hub, and `connect install` / the
  compose template always provide one. A missing *token* still waits, using
  the same token-file watch as `auth-failed`.
- **Fail-fast in manual mode**: without `VIBEDECKX_SUPERVISOR` (foreground,
  `--daemon`) the *first* auth/pin/token error still exits with a clear error,
  as before. Nobody restarts such a process, so failing loudly is better. Under
  a supervisor the worker stays alive in `auth-failed` / `blocked`.
- **Liveness/readiness (§3.6)**: the worker rewrites `run/status.json` every 5s.
  `connect status` reads it together with `connect.json`. Liveness is stale
  after 30s (exit 1); `--ready` requires `connected`; `--check-update` is the
  only network access.
- **Preflight when the hub is unreachable**: a network error or 5xx on
  `/api/config` is a retryable error, not "old hub". Previously it skipped the
  identity check, which would have let a token swapped in during an outage
  connect unchecked once the hub returned. Only a 4xx or a missing capability
  flag counts as a hub that predates identity checks.
- **Token re-reads (§3.3)**: each slow auth retry re-reads the token, and the
  directory watch only speeds things up. A changed token always goes through
  the pin preflight before reconnecting. `setup --force` writes a re-pin marker
  that is consumed by the next successful preflight, so a running worker
  re-pins as soon as it sees the new token, without a restart.
- **Service PATH**: the invoking shell's PATH is filtered before it is baked
  in. Entries that die with the shell are dropped (npx `_npx` bins,
  `node_modules/.bin`, node-gyp shims, fnm's per-shell `fnm_multishells`), as
  are missing directories. Found on a real install, where npx and fnm
  contributed all of these. The snapshot is not part of the unit/plist: it
  goes to `runtime/service.env`, which the launcher loads only when called
  as `launcher --service-env …` (the form the definitions use). A different
  PATH on a re-install therefore means a restart (`kickstart -k`, no
  `daemon-reload`), never a launchd unload/reload. The marker is an argument
  because the worker's environment, `VIBEDECKX_SUPERVISOR` included, is
  inherited by every terminal and agent it spawns; the `~/.local/bin` shim
  runs the launcher without it, so a re-install from any shell snapshots that
  shell's PATH. Verified on the Mac: five PATH changes in a row restarted the
  job (`runs` 1→6) without rewriting the plist.
- **Runtime (§6)**: the source must be a self-contained release (the npm
  platform package or a tarball install); a pnpm source checkout is refused.
  Each build gets its own directory, `runtime/<version>+<content hash>/`,
  which is never rewritten or deleted while it can be current: a rebuild with
  the same version number, or a repair of a damaged build, installs beside it
  and then switches `current`. Node is copied into every build (no
  hard-link sharing; pruning to current + previous bounds the cost to two
  copies).
- **Docker (§5)**: `deploy/worker/` (`Dockerfile`, `build.sh`,
  `docker-compose.yml`). The token is mounted as a *directory*, not a single
  file: a single-file bind mount is pinned to the inode, so replacing the file
  on the host by rename never reaches the container. Verified with Compose
  `secrets:`, which is a single-file mount. The image has not been published
  yet, so the public docs do not mention it.
- **Copy-paste install**: the connect-token endpoints return `installCommand`
  (`npx vibedeckx@latest connect install --connect-to … --token …`) next to the
  existing `connectCommand`. The Remote Servers dialog shows both, install
  first; the run-in-terminal command stays for systems without `install`.
  This is hub ↔ browser only, not a tunnel change. The hub must ship after a
  worker release that has `connect install`, because `@latest` resolves on the
  user's machine.
- **Management command**: on success `connect install` writes
  `~/.local/bin/vibedeckx`, a two-line shim that execs the runtime launcher.
  Day-to-day `connect status/stop/...` therefore needs no npx, no network,
  and always matches the running worker's version. It is only created for the
  default data-dir, never over a `vibedeckx` it did not write (marker line),
  and it is removed by `connect uninstall`. The installer prints what to add
  when `~/.local/bin` is not on PATH, or when another `vibedeckx` comes first.
- **launchd on a real Mac (2026-10-19)**: macOS 26.5 arm64, 0.3.52 from npm,
  throwaway data-dirs against a local hub. Passed: install, re-install
  (unchanged → no restart), SIGKILL and SIGTERM recovery, stop/start/restart,
  disable (the override survives; launchd refuses to load the job), duplicate
  start, revoke → `auth-failed` → recovery on token rename, pin mismatch →
  `blocked`, hub outage, repeated startup failure (bad `current`: retried every
  10s, recovered by itself), wedged loop (SIGSTOP → stale heartbeat, `status`
  exit 1), interrupted install, uninstall. launchd also kills the job's
  leftover children when the worker dies, and only the worker held
  `instance.lock`. Two fixes came out of it:
  - `bootout` is asynchronous: it returns while the job is still listed, so a
    re-install with a changed plist hit `kickstart` "Could not find service"
    (113) in 2 of 3 runs and **left the worker unloaded** until the next login.
    `LaunchdAgentAdapter.bootout()` now waits until `launchctl print` no longer
    finds the job (0/6 failures after the fix). PATH has since moved out of
    the plist (see Service PATH), so a re-install no longer unloads at all;
    the wait remains for stop/disable/uninstall and plist template changes.
  - launchd refuses to bootstrap a disabled job with a bare "Input/output
    error" (5); `start`/`restart` now say to run `connect enable`, and `status`
    shows the auto-start state as on systemd.
- **Not done**: the install-mode handshake field (§6.4) and the Windows
  backend (§4.3). Reboot was not exercised on either platform (Linux boot start
  relies on `enable` plus linger, both checked). A macOS logout/login was:
  after `stop` the agent came back at login, after `disable` it stayed off
  until `enable`. x64 Macs and `--daemon` migration on macOS (`--daemon` is
  Linux-only) are untested.
