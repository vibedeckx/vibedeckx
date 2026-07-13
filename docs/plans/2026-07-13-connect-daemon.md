# Connect Daemon Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Linux-only `connect --daemon`, `connect status`, and `connect stop` commands that keep a reverse-connect node alive after SSH disconnect without exposing its token in the long-running command line.

**Architecture:** The bundled platform CLI re-executes its own `dist/bin.js` as a detached Node child and keeps a temporary IPC channel open until local initialization succeeds. A mode-0600 state file under the selected data directory records PID plus Linux process start ticks, allowing status and stop to reject stale or reused PIDs safely.

**Tech Stack:** TypeScript, Node.js `child_process`/`fs`/`process` APIs, Linux `/proc`, Stricli, Vitest, esbuild.

---

Design reference: `docs/plans/2026-07-13-connect-daemon-design.md`

Implementation must follow @superpowers:test-driven-development. Run each new
test first and observe the expected failure before adding production code.

### Task 1: Linux process identity and daemon state parsing

**Files:**
- Create: `packages/vibedeckx/src/connect-daemon.ts`
- Create: `packages/vibedeckx/src/connect-daemon.test.ts`

**Step 1: Write the failing `/proc` parser tests**

Create `connect-daemon.test.ts` with a focused first describe block:

```ts
import { describe, expect, it } from "vitest";
import {
  parseLinuxProcessStartTicks,
  readLinuxProcessStartTicks,
} from "./connect-daemon.js";

describe("Linux process identity", () => {
  it("reads field 22 from proc stat", () => {
    const stat = "123 (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20";
    expect(parseLinuxProcessStartTicks(stat)).toBe("987654");
  });

  it("handles process names containing spaces and closing parentheses", () => {
    const stat = "123 (name with ) paren) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242 20";
    expect(parseLinuxProcessStartTicks(stat)).toBe("424242");
  });

  it("rejects malformed proc stat", () => {
    expect(() => parseLinuxProcessStartTicks("not-a-stat-line")).toThrow(
      "Malformed Linux process stat",
    );
  });

  it("reads the current process start ticks", () => {
    expect(readLinuxProcessStartTicks(process.pid)).toMatch(/^\d+$/);
  });
});
```

The synthetic token after the closing `)` begins at field 3, so field 22 is
index 19 in that tail. Use the final `)` rather than a whitespace split over the
whole line.

**Step 2: Run the test and verify it fails**

Run:

```bash
pnpm --filter vibedeckx test -- src/connect-daemon.test.ts
```

Expected: FAIL because `connect-daemon.js` does not exist.

**Step 3: Add the minimal identity implementation**

Start `connect-daemon.ts` with:

```ts
import fs from "node:fs";

export function parseLinuxProcessStartTicks(stat: string): string {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) throw new Error("Malformed Linux process stat");

  const fieldsFromThree = stat.slice(closeParen + 1).trim().split(/\s+/);
  const startTicks = fieldsFromThree[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error("Malformed Linux process stat");
  }
  return startTicks;
}

export function readLinuxProcessStartTicks(pid: number): string | undefined {
  try {
    return parseLinuxProcessStartTicks(
      fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return undefined;
    }
    throw error;
  }
}
```

**Step 4: Add state schema and parsing tests**

Extend the test file using a temporary directory per test:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
  daemonStatePath,
  inspectDaemonState,
  type ConnectDaemonState,
} from "./connect-daemon.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-daemon-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeState(state: ConnectDaemonState | string): void {
  const file = daemonStatePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof state === "string" ? state : JSON.stringify(state));
}

describe("daemon state inspection", () => {
  it("reports missing state", () => {
    expect(inspectDaemonState(dataDir)).toEqual({ kind: "missing" });
  });

  it("reports a live process only when PID and start ticks match", () => {
    const processStartTicks = readLinuxProcessStartTicks(process.pid)!;
    const state: ConnectDaemonState = {
      schemaVersion: 1,
      pid: process.pid,
      processStartTicks,
      startedAt: new Date().toISOString(),
      connectTo: "https://example.com",
      version: "test",
    };
    writeState(state);
    expect(inspectDaemonState(dataDir)).toEqual({ kind: "running", state });
  });

  it("reports a reused PID as stale", () => {
    writeState({
      schemaVersion: 1,
      pid: process.pid,
      processStartTicks: "0",
      startedAt: new Date().toISOString(),
      connectTo: "https://example.com",
      version: "test",
    });
    expect(inspectDaemonState(dataDir).kind).toBe("stale");
  });

  it("reports malformed JSON without deleting it", () => {
    writeState("{");
    expect(inspectDaemonState(dataDir).kind).toBe("invalid");
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });

  it("reports an unknown schema without deleting it", () => {
    writeState(JSON.stringify({ schemaVersion: 99 }));
    expect(inspectDaemonState(dataDir).kind).toBe("invalid");
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });
});
```

**Step 5: Run the tests and verify the new cases fail**

Run the same focused Vitest command.

Expected: the four identity tests pass; state tests fail because the state APIs
are not implemented.

**Step 6: Implement the state schema and inspection result**

Add these public shapes and helpers:

```ts
import path from "node:path";

export interface ConnectDaemonState {
  schemaVersion: 1;
  pid: number;
  processStartTicks: string;
  startedAt: string;
  connectTo: string;
  version: string;
}

export type ConnectDaemonInspection =
  | { kind: "missing" }
  | { kind: "running"; state: ConnectDaemonState }
  | { kind: "stale"; state: ConnectDaemonState }
  | { kind: "invalid"; path: string; reason: string };

export function daemonStatePath(dataDir: string): string {
  return path.join(dataDir, "run", "connect.json");
}

function isConnectDaemonState(value: unknown): value is ConnectDaemonState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    state.schemaVersion === 1 &&
    Number.isSafeInteger(state.pid) &&
    (state.pid as number) > 0 &&
    typeof state.processStartTicks === "string" &&
    typeof state.startedAt === "string" &&
    typeof state.connectTo === "string" &&
    typeof state.version === "string"
  );
}

export function inspectDaemonState(dataDir: string): ConnectDaemonInspection {
  const statePath = daemonStatePath(dataDir);
  if (!fs.existsSync(statePath)) return { kind: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    return { kind: "invalid", path: statePath, reason: (error as Error).message };
  }
  if (!isConnectDaemonState(parsed)) {
    return { kind: "invalid", path: statePath, reason: "Unsupported or malformed daemon state" };
  }

  const actualTicks = readLinuxProcessStartTicks(parsed.pid);
  return actualTicks === parsed.processStartTicks
    ? { kind: "running", state: parsed }
    : { kind: "stale", state: parsed };
}
```

Do not use `process.kill(pid, 0)` as the identity check; `/proc` start ticks are
the protection against PID reuse.

**Step 7: Run the focused tests and typecheck**

Run:

```bash
pnpm --filter vibedeckx test -- src/connect-daemon.test.ts
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/vibedeckx/src/connect-daemon.ts packages/vibedeckx/src/connect-daemon.test.ts
git commit -m "feat: add connect daemon process identity"
```

### Task 2: Exclusive ownership and safe cleanup

**Files:**
- Modify: `packages/vibedeckx/src/connect-daemon.ts`
- Modify: `packages/vibedeckx/src/connect-daemon.test.ts`

**Step 1: Write failing ownership tests**

Add tests for the following API:

```ts
import {
  claimDaemonState,
  removeDaemonStateIfOwned,
  removeVerifiedStaleState,
} from "./connect-daemon.js";

describe("daemon state ownership", () => {
  it("claims state exclusively with private permissions", () => {
    const state = claimDaemonState(dataDir, "https://example.com", "test");
    expect(state.pid).toBe(process.pid);
    expect(fs.statSync(daemonStatePath(dataDir)).mode & 0o777).toBe(0o600);
    expect(() => claimDaemonState(dataDir, "https://example.com", "test")).toThrow(
      /already exists/i,
    );
  });

  it("removes state only when it is still owned by the caller", () => {
    const owned = claimDaemonState(dataDir, "https://example.com", "test");
    expect(removeDaemonStateIfOwned(dataDir, { ...owned, processStartTicks: "other" })).toBe(false);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
    expect(removeDaemonStateIfOwned(dataDir, owned)).toBe(true);
  });

  it("removes only verified stale state", () => {
    const stale: ConnectDaemonState = {
      schemaVersion: 1,
      pid: process.pid,
      processStartTicks: "0",
      startedAt: new Date().toISOString(),
      connectTo: "https://example.com",
      version: "test",
    };
    writeState(stale);
    expect(removeVerifiedStaleState(dataDir)).toBe(true);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(false);
  });

  it("never removes invalid state automatically", () => {
    writeState("{");
    expect(() => removeVerifiedStaleState(dataDir)).toThrow(/cannot safely remove/i);
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });
});
```

**Step 2: Run the focused test and verify it fails**

Expected: FAIL on missing ownership exports.

**Step 3: Implement exclusive claim and conditional removal**

Use `fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })`, then write the
complete state in one call:

```ts
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
```

`claimDaemonState()` must use `process.pid` and
`readLinuxProcessStartTicks(process.pid)`. Throw if the current start ticks
cannot be read.

`removeDaemonStateIfOwned()` must re-read and validate the current file, compare
both PID and `processStartTicks`, and unlink only on an exact match.

`removeVerifiedStaleState()` must branch on `inspectDaemonState()`:

- `missing`: return `false`;
- `stale`: call conditional removal with that exact state and return the result;
- `running`: throw an error naming the PID;
- `invalid`: throw an error naming the path and explaining that automatic
  removal is unsafe.

**Step 4: Run focused tests and typecheck**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/vibedeckx/src/connect-daemon.ts packages/vibedeckx/src/connect-daemon.test.ts
git commit -m "feat: manage connect daemon ownership"
```

### Task 3: Status and stop operations

**Files:**
- Modify: `packages/vibedeckx/src/connect-daemon.ts`
- Modify: `packages/vibedeckx/src/connect-daemon.test.ts`

**Step 1: Write failing status-format tests**

Add a pure formatter so output is deterministic:

```ts
import {
  describeConnectDaemon,
  stopConnectDaemon,
} from "./connect-daemon.js";

it("formats running status without credentials", () => {
  const state = claimDaemonState(dataDir, "https://example.com", "test");
  const result = describeConnectDaemon(dataDir);
  expect(result.exitCode).toBe(0);
  expect(result.message).toContain(`Running (PID ${state.pid}`);
  expect(result.message).toContain("Target: https://example.com");
  expect(result.message).toContain(path.join(dataDir, "logs", "vibedeckx.log"));
});

it("returns non-zero for a missing daemon", () => {
  expect(describeConnectDaemon(dataDir)).toMatchObject({ exitCode: 1 });
});
```

`describeConnectDaemon()` should return `{ exitCode: number; message: string }`
rather than printing directly. `command.ts` will own console output.

**Step 2: Run the test and verify it fails**

Expected: FAIL on missing formatter.

**Step 3: Implement status formatting**

For `running`, include PID, `startedAt`, target, and
`<data-dir>/logs/vibedeckx.log`. For `missing`, `stale`, and `invalid`, return a
clear non-zero result. Never include the token.

**Step 4: Write failing stop tests with injected process operations**

Do not signal real test processes. Give `stopConnectDaemon()` optional injected
dependencies:

```ts
export interface StopDaemonRuntime {
  readStartTicks: (pid: number) => string | undefined;
  sendSignal: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
}
```

The production defaults wrap `readLinuxProcessStartTicks`, `process.kill`, and
a Promise-based timer. Test these cases:

```ts
it("sends SIGTERM only to the validated process", async () => {
  const state = claimDaemonState(dataDir, "https://example.com", "test");
  let alive = true;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const result = await stopConnectDaemon(dataDir, {
    readStartTicks: () => (alive ? state.processStartTicks : undefined),
    sendSignal: (pid, signal) => {
      signals.push([pid, signal]);
      alive = false;
    },
    sleep: async () => {},
  });
  expect(signals).toEqual([[state.pid, "SIGTERM"]]);
  expect(result.exitCode).toBe(0);
});

it("does not signal a reused PID", async () => {
  const state = claimDaemonState(dataDir, "https://example.com", "test");
  const sendSignal = vi.fn();
  const result = await stopConnectDaemon(dataDir, {
    readStartTicks: () => "different",
    sendSignal,
    sleep: async () => {},
  });
  expect(sendSignal).not.toHaveBeenCalled();
  expect(result.exitCode).not.toBe(0);
});

it("is idempotent when no daemon is running", async () => {
  expect((await stopConnectDaemon(dataDir)).exitCode).toBe(0);
});
```

Import `vi` for spies.

**Step 5: Run the test and verify the stop cases fail**

Expected: status cases pass; stop cases fail on the missing function.

**Step 6: Implement graceful stop**

Algorithm:

1. Inspect state.
2. Return success for `missing`.
3. Return safely without signaling for `stale` or `invalid`.
4. Re-read start ticks immediately before signaling and require an exact match.
5. Send `SIGTERM` once.
6. Poll every 100ms for up to 7 seconds.
7. If the process remains the same after 7 seconds, send one more `SIGTERM` to
   activate the existing connect cleanup's forced-exit branch, then wait one
   final second.
8. Return non-zero if the validated process still remains.
9. Once it is gone, conditionally remove its stale state and return success.

Make polling constants overridable in tests or keep the injected `sleep`
instantaneous so the suite does not wait in real time.

**Step 7: Run tests and typecheck**

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/vibedeckx/src/connect-daemon.ts packages/vibedeckx/src/connect-daemon.test.ts
git commit -m "feat: add connect daemon status and stop"
```

### Task 4: Detached spawn, IPC readiness, and secret handling

**Files:**
- Modify: `packages/vibedeckx/src/connect-daemon.ts`
- Modify: `packages/vibedeckx/src/connect-daemon.test.ts`
- Create: `packages/vibedeckx/src/__fixtures__/connect-daemon-child.mjs`

**Step 1: Write failing argument-sanitization tests**

Define internal environment names in one place:

```ts
export const CONNECT_DAEMON_CHILD_ENV = "VIBEDECKX_INTERNAL_CONNECT_DAEMON";
export const CONNECT_DAEMON_TOKEN_ENV = "VIBEDECKX_INTERNAL_CONNECT_TOKEN";
```

Test both supported token syntaxes:

```ts
import {
  buildDaemonChildArgs,
  consumeDaemonChildEnvironment,
} from "./connect-daemon.js";

it.each([
  [
    ["connect", "--connect-to", "https://example.com", "--token", "secret", "--daemon"],
    ["connect", "--connect-to", "https://example.com"],
  ],
  [
    ["connect", "--token=secret", "--daemon", "--data-dir=/tmp/data"],
    ["connect", "--data-dir=/tmp/data"],
  ],
])("removes daemon and token arguments", (input, expected) => {
  expect(buildDaemonChildArgs(input)).toEqual(expected);
});

it("consumes and deletes the internal token environment", () => {
  const env: NodeJS.ProcessEnv = {
    VIBEDECKX_INTERNAL_CONNECT_DAEMON: "1",
    VIBEDECKX_INTERNAL_CONNECT_TOKEN: "secret",
  };
  expect(consumeDaemonChildEnvironment(env)).toEqual({
    isDaemonChild: true,
    token: "secret",
  });
  expect(env.VIBEDECKX_INTERNAL_CONNECT_TOKEN).toBeUndefined();
  expect(env.VIBEDECKX_INTERNAL_CONNECT_DAEMON).toBeUndefined();
});
```

**Step 2: Run the test and verify it fails**

Expected: FAIL on missing exports.

**Step 3: Implement sanitization and environment consumption**

`buildDaemonChildArgs()` must remove:

- `--daemon` and `--daemon=<value>`;
- `--token <value>` including the following value;
- `--token=<value>`.

It must preserve every other argument byte-for-byte. Throw if a standalone
`--token` has no value.

`consumeDaemonChildEnvironment()` reads both internal values, deletes both
properties immediately, and returns `{ isDaemonChild, token }`.

**Step 4: Add an IPC fixture**

Create `src/__fixtures__/connect-daemon-child.mjs`:

```js
import fs from "node:fs";

const mode = process.env.VIBEDECKX_TEST_DAEMON_MODE ?? "ready";
const record = process.env.VIBEDECKX_TEST_DAEMON_RECORD;

if (record) {
  fs.writeFileSync(record, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
}

if (mode === "ready") {
  process.send?.({ type: "ready", pid: process.pid });
  process.disconnect?.();
  setInterval(() => {}, 1_000);
} else if (mode === "error") {
  process.send?.({ type: "error", message: "fixture failed" });
  process.disconnect?.();
  process.exit(1);
} else if (mode === "exit") {
  process.exit(2);
}
```

The test suite must always terminate a ready fixture in `finally`/`afterEach`.

**Step 5: Write failing detached-spawn tests**

Expose:

```ts
export interface StartConnectDaemonOptions {
  dataDir: string;
  connectTo: string;
  token: string;
  argv: string[];
  entrypoint?: string;
  timeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
}

export interface StartedConnectDaemon {
  pid: number;
  target: string;
  logPath: string;
}

export async function startConnectDaemon(
  options: StartConnectDaemonOptions,
): Promise<StartedConnectDaemon>;
```

Tests should pass the fixture path as `entrypoint` and assert:

- `ready` resolves with a PID and leaves the child alive;
- `error` rejects with `fixture failed`;
- early exit rejects and includes exit code 2;
- a short timeout rejects and terminates the fixture;
- a pre-existing running state rejects before spawning;
- a verified stale state is removed before spawning;
- the recorded child argv excludes `secret` and `--daemon`;
- the child receives the token only in `CONNECT_DAEMON_TOKEN_ENV`.

For fixture tests, pass `argv` beginning with fixture-specific harmless
arguments; do not require Stricli.

**Step 6: Run the focused tests and verify they fail**

Expected: sanitizer tests pass; spawn tests fail on missing start logic.

**Step 7: Implement detached spawning and handshake**

Use:

```ts
const child = spawn(process.execPath, [entrypoint, ...buildDaemonChildArgs(argv)], {
  detached: true,
  stdio: ["ignore", "ignore", "ignore", "ipc"],
  env: {
    ...process.env,
    ...extraEnv,
    [CONNECT_DAEMON_CHILD_ENV]: "1",
    [CONNECT_DAEMON_TOKEN_ENV]: token,
  },
});
```

Before spawning, require `process.platform === "linux"`, inspect state, reject
`running`/`invalid`, and conditionally remove `stale`.

Resolve only for a validated `{ type: "ready", pid: child.pid }` message. Reject
for an error message, `error` event, premature `exit`, or timeout. Remove all
listeners and clear the timer on every terminal path. On success, disconnect IPC
if still connected and call `child.unref()`. On failure, terminate any surviving
child and remove only state that can be verified as belonging to that dead
child.

Do not interpolate arguments into a shell command and do not set `shell: true`.

**Step 8: Add daemon-child state and notification helpers**

Add:

```ts
export function notifyDaemonParentReady(): void {
  if (process.send) process.send({ type: "ready", pid: process.pid });
  if (process.connected) process.disconnect();
}

export function notifyDaemonParentError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (process.send) process.send({ type: "error", message });
  if (process.connected) process.disconnect();
}
```

Keep IPC messages credential-free.

**Step 9: Run tests, typecheck, and build**

```bash
pnpm --filter vibedeckx test -- src/connect-daemon.test.ts
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
pnpm --filter vibedeckx build
```

Expected: PASS and `packages/vibedeckx/dist/bin.js` builds.

**Step 10: Commit**

```bash
git add packages/vibedeckx/src/connect-daemon.ts packages/vibedeckx/src/connect-daemon.test.ts packages/vibedeckx/src/__fixtures__/connect-daemon-child.mjs
git commit -m "feat: spawn detached connect daemon"
```

### Task 5: Wire daemon lifecycle into the CLI

**Files:**
- Modify: `packages/vibedeckx/src/command.ts:230-355`
- Modify: `packages/vibedeckx/src/connect-daemon.test.ts`

**Step 1: Add a command-level token resolution test**

Keep the policy in a small exported helper in `connect-daemon.ts` so it is easy
to test without starting Fastify:

```ts
export function resolveConnectToken(
  flagToken: string | undefined,
  child: { isDaemonChild: boolean; token: string | undefined },
): string {
  const token = flagToken ?? (child.isDaemonChild ? child.token : undefined);
  if (!token) throw new Error("Missing required --token for vibedeckx connect");
  return token;
}
```

Test flag precedence, internal child fallback, and rejection when both are
absent. Also assert that a non-child process cannot consume an accidentally set
internal token.

**Step 2: Run the focused test and verify it fails**

Expected: FAIL on missing `resolveConnectToken`.

**Step 3: Implement token resolution**

Add the minimal helper above and rerun the focused test.

Expected: PASS.

**Step 4: Add the daemon flag to the default connect command**

In `connectCommand.parameters.flags`, add:

```ts
daemon: {
  kind: "boolean",
  brief: "Run in the background after initialization (Linux only)",
  optional: true,
},
```

Make `token` optional at Stricli parsing level, because an internal daemon child
does not retain it in argv. Preserve the runtime requirement through
`resolveConnectToken()`.

Extend the connect handler flag type with:

```ts
token: string | undefined;
daemon: boolean | undefined;
```

**Step 5: Branch parent and child startup before normal initialization**

At the beginning of the handler:

```ts
const dataDir = flags["data-dir"] ?? VIBEDECKX_HOME;
const childContext = consumeDaemonChildEnvironment(process.env);
const token = resolveConnectToken(flags.token, childContext);

if (flags.daemon) {
  const started = await startConnectDaemon({
    dataDir,
    connectTo: flags["connect-to"],
    token,
    argv: process.argv.slice(2),
  });
  console.log(`Vibedeckx connect started in background (PID ${started.pid}).`);
  console.log(`Target: ${started.target}`);
  console.log(`Logs: ${started.logPath}`);
  return;
}
```

If `childContext.isDaemonChild`, claim state before opening SQLite. Obtain the
package version by reading `new URL("../package.json", import.meta.url)`; this
path is correct from both `src/` during tests and bundled `dist/bin.js` in the
platform package. If the read fails, use `"unknown"` rather than failing daemon
startup.

Wrap normal connect initialization in `try/catch`. On successful local server
startup and immediately after `client.connect()`, call
`notifyDaemonParentReady()`. On an error before readiness, call
`notifyDaemonParentError(error)`, conditionally remove owned state, close any
partially created resources, and rethrow.

Extend the existing `cleanup()` with a `finally` that conditionally removes the
owned daemon state before `process.exit()`.

Foreground connect must not create daemon state or send IPC messages.

**Step 6: Add `status` and `stop` Stricli commands**

Both commands take only optional `--data-dir`:

```ts
const connectStatusCommand = buildCommand({
  parameters: {
    flags: {
      "data-dir": {
        kind: "parsed",
        parse: String,
        brief: "Daemon data directory (default: ~/.vibedeckx)",
        optional: true,
      },
    },
  },
  func: async (flags: { "data-dir": string | undefined }) => {
    const result = describeConnectDaemon(flags["data-dir"] ?? VIBEDECKX_HOME);
    console.log(result.message);
    process.exitCode = result.exitCode;
  },
  docs: { brief: "Show the connect daemon status" },
});
```

Implement `connectStopCommand` identically but await `stopConnectDaemon()`.

**Step 7: Convert `connect` into a nested route map**

```ts
const connectRoutes = buildRouteMap({
  routes: {
    run: connectCommand,
    status: connectStatusCommand,
    stop: connectStopCommand,
  },
  defaultCommand: "run",
  docs: { brief: "Connect to a Vibedeckx server as an inbound node" },
});
```

Use `connect: connectRoutes` in the root route map. Stricli's default-command
behavior treats unrecognized tokens such as `--connect-to` as arguments to
`run`, preserving the existing `vibedeckx connect --connect-to ...` syntax.

**Step 8: Add CLI help/compatibility assertions**

Prefer testing the built CLI in Task 6. At this task, at minimum use the Stricli
application help generator or a controlled `run()` context to assert:

- `connect --help` still documents the foreground flags and `--daemon`;
- `connect status --help` does not require `--connect-to` or `--token`;
- `connect stop --help` does not require them.

If importing `command.ts` makes the unit test unnecessarily coupled to server
modules, defer these exact assertions to the subprocess integration test rather
than mocking the entire backend.

**Step 9: Run unit tests, full backend tests, typecheck, and build**

```bash
pnpm --filter vibedeckx test -- src/connect-daemon.test.ts
pnpm --filter vibedeckx test
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
pnpm --filter vibedeckx build
```

Expected: PASS.

**Step 10: Commit**

```bash
git add packages/vibedeckx/src/command.ts packages/vibedeckx/src/connect-daemon.ts packages/vibedeckx/src/connect-daemon.test.ts
git commit -m "feat: expose connect daemon commands"
```

### Task 6: Built-CLI integration coverage

**Files:**
- Create: `packages/vibedeckx/src/connect-daemon.integration.test.ts`
- Modify: `packages/vibedeckx/package.json:12-20`
- Modify: `.github/workflows/test.yml`

**Step 1: Add the integration test script**

Add to `packages/vibedeckx/package.json`:

```json
"test:daemon": "npm run build && VIBEDECKX_DAEMON_INTEGRATION=1 vitest run src/connect-daemon.integration.test.ts"
```

Keep this separate from the ordinary Vitest command because it requires a fresh
bundle and spawns a real detached process.

**Step 2: Write the failing built-CLI integration test**

Create a Linux-only suite guarded with:

```ts
const runIntegration =
  process.platform === "linux" &&
  process.env.VIBEDECKX_DAEMON_INTEGRATION === "1";

describe.runIf(runIntegration)("built connect daemon CLI", () => {
  // tests
});
```

Use `execFile()`/`spawn()` with `process.execPath` and the absolute path to
`packages/vibedeckx/dist/bin.js`. Use a fresh temporary data directory and this
target, which intentionally refuses quickly while the reverse client keeps
retrying:

```text
http://127.0.0.1:9
```

Use a unique token such as `daemon-integration-secret-<randomUUID()>`.

The test sequence must assert:

1. Foreground help accepts the legacy direct route:
   `connect --help` includes `--connect-to`, `--token`, and `--daemon`.
2. `connect status --help` and `connect stop --help` succeed without credentials.
3. `connect ... --daemon` exits zero and prints a PID, target, and log path.
4. `connect.json` exists with mode `0600` and contains no token.
5. `/proc/<pid>/cmdline` contains neither the token nor `--daemon`.
6. The daemon remains alive after the start command exits.
7. A second start with the same data directory exits non-zero and names the PID.
8. `connect status --data-dir ...` exits zero and reports the same PID.
9. `connect stop --data-dir ...` exits zero and the process disappears.
10. A second stop exits zero.

Use `afterEach` to validate the recorded PID and send `SIGTERM`, followed by
`SIGKILL` only as test cleanup if the daemon survives. This cleanup is not part
of product behavior.

**Step 3: Run the integration script and verify it fails**

```bash
pnpm --filter vibedeckx test:daemon
```

Expected before the CLI wiring is correct: FAIL on at least one lifecycle or
help assertion. If it unexpectedly passes, deliberately break one assertion to
confirm the suite is executing, then restore it.

**Step 4: Fix only integration gaps**

Typical expected fixes are:

- resolving `process.argv[1]` to an absolute entrypoint;
- ensuring the IPC channel is disconnected on both ends;
- cleaning stale state after startup failure;
- preserving Stricli default-route compatibility;
- preventing token values from entering child argv or output.

Do not add crash restart, reboot startup, macOS support, or a general-purpose
process supervisor.

**Step 5: Add the daemon integration test to Linux CI**

After the ordinary unit-test step in `.github/workflows/test.yml`, add:

```yaml
- name: Connect daemon integration test
  run: pnpm --filter vibedeckx test:daemon
```

CI already uses Ubuntu and Node 22, matching the supported v1 platform.

**Step 6: Run integration and full verification**

```bash
pnpm --filter vibedeckx test:daemon
pnpm --filter vibedeckx test
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/vibedeckx/src/connect-daemon.integration.test.ts packages/vibedeckx/package.json .github/workflows/test.yml
git commit -m "test: cover connect daemon lifecycle"
```

### Task 7: User documentation

**Files:**
- Modify: `README.md:215-235`

**Step 1: Update the connect flag table**

Add:

```markdown
| `--daemon` | Run in the background after initialization (Linux only) |
```

Keep the existing foreground example.

**Step 2: Document the one-command SaaS path**

Add directly after the foreground example:

````markdown
To keep a remote node running after disconnecting SSH on Linux:

```bash
npx -y vibedeckx@latest connect --connect-to https://example.com --token abc123 --daemon
```

Manage the background process with the same CLI:

```bash
npx -y vibedeckx@latest connect status
npx -y vibedeckx@latest connect stop
```

Daemon status is scoped by `--data-dir`. The first version survives SSH
disconnection but does not restart after a crash or machine reboot. Logs remain
available at `~/.vibedeckx/logs/vibedeckx.log`.
````

**Step 3: Check documentation and CLI help agree**

Run:

```bash
pnpm --filter vibedeckx build
node packages/vibedeckx/dist/bin.js connect --help
node packages/vibedeckx/dist/bin.js connect status --help
node packages/vibedeckx/dist/bin.js connect stop --help
```

Expected: documented commands and flags match generated help.

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document connect daemon mode"
```

### Task 8: Final verification

**Files:**
- Verify only; modify files only if a check exposes a defect.

**Step 1: Run focused unit tests**

```bash
pnpm --filter vibedeckx test -- src/connect-daemon.test.ts
```

Expected: PASS.

**Step 2: Run the real detached-process integration test**

```bash
pnpm --filter vibedeckx test:daemon
```

Expected: PASS with no daemon process or temporary directory left behind.

**Step 3: Run the complete backend suite**

```bash
pnpm --filter vibedeckx test
```

Expected: PASS.

**Step 4: Typecheck and build the publishable platform CLI**

```bash
npx tsc --noEmit -p packages/vibedeckx/tsconfig.json
pnpm --filter vibedeckx build
```

Expected: both commands exit zero.

**Step 5: Inspect secrets and process cleanup manually**

Run one final smoke with a fresh data directory and a unique token, then inspect
`connect.json`, `/proc/<pid>/cmdline`, `connect status`, and `connect stop`.
Confirm the token appears in none of the persistent artifacts and no process is
left running.

**Step 6: Review the diff**

```bash
git status --short
git diff --check
git log --oneline --max-count=8
```

Expected: no uncommitted implementation changes, no whitespace errors, and one
small commit per completed task.
