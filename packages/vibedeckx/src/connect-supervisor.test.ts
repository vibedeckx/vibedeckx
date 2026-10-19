import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectionSupervisor,
  watchTokenFile,
  type ConnectionClientCallbacks,
  type ConnectionSupervisorDeps,
} from "./connect-supervisor.js";
import { PinMismatchError, PreflightAuthError, PreflightUnavailableError } from "./connect-preflight.js";
import { TokenUnavailableError, type TokenSource } from "./connect-config.js";
import type { ConnectionState } from "./connect-heartbeat.js";

interface Harness {
  supervisor: ConnectionSupervisor;
  states: Array<{ state: ConnectionState; detail?: string; fix?: string }>;
  clients: Array<{ token: string; callbacks: ConnectionClientCallbacks; shutdown: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }>;
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  preflight: ReturnType<typeof vi.fn>;
  token: { value: string | Error };
  fireTokenChange: () => void;
  runTimer: (index?: number) => Promise<void>;
  clearRepin: ReturnType<typeof vi.fn>;
}

const fileSource: TokenSource = { kind: "file", path: "/tokens/token", origin: "test" };

function harness(overrides: Partial<ConnectionSupervisorDeps> = {}): Harness {
  const states: Harness["states"] = [];
  const clients: Harness["clients"] = [];
  const timers: Harness["timers"] = [];
  const token = { value: "tok-1" as string | Error };
  let onTokenChange: () => void = () => {};
  const preflight = vi.fn(async () => ({ checked: true, identity: { serverId: "s1", name: "box" } }));
  const clearRepin = vi.fn();

  const supervisor = new ConnectionSupervisor({
    tokenSource: fileSource,
    readToken: () => {
      if (token.value instanceof Error) throw token.value;
      return token.value;
    },
    preflight,
    createClient: (value, callbacks) => {
      const client = { token: value, callbacks, shutdown: vi.fn(), connect: vi.fn() };
      clients.push(client);
      return client;
    },
    onState: (state, detail, fix) => states.push({ state, detail, fix }),
    watchToken: (_path, onChange) => {
      onTokenChange = onChange;
      return () => {};
    },
    clearRepinRequest: clearRepin,
    log: () => {},
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    random: () => 0.5,
    authRetryMs: 600_000,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
    ...overrides,
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    supervisor,
    states,
    clients,
    timers,
    preflight,
    token,
    clearRepin,
    fireTokenChange: () => onTokenChange(),
    runTimer: async (index) => {
      const pending = timers.filter((timer) => !timer.cleared);
      const timer = index === undefined ? pending[pending.length - 1] : pending[index];
      if (!timer) throw new Error("no pending timer");
      timer.cleared = true;
      timer.fn();
      await flush();
      await flush();
    },
  };
}

const pendingTimers = (h: Harness) => h.timers.filter((timer) => !timer.cleared);
const lastState = (h: Harness) => h.states[h.states.length - 1];

describe("ConnectionSupervisor", () => {
  it("verifies identity, dials, and reports connected", async () => {
    const h = harness();
    await h.supervisor.start();

    expect(h.preflight).toHaveBeenCalledWith("tok-1", false);
    expect(h.clients).toHaveLength(1);
    expect(h.clients[0].connect).toHaveBeenCalled();
    expect(lastState(h).state).toBe("connecting");

    h.clients[0].callbacks.onConnected();
    expect(lastState(h).state).toBe("connected");
    h.clients[0].callbacks.onDisconnected("code=1006");
    expect(lastState(h)).toMatchObject({ state: "connecting", detail: "Disconnected: code=1006" });
  });

  it("backs off with jitter on network errors and keeps retrying", async () => {
    const h = harness();
    h.preflight.mockRejectedValue(new Error("ECONNREFUSED"));
    await h.supervisor.start();

    expect(lastState(h).state).toBe("connecting");
    expect(pendingTimers(h).map((timer) => timer.ms)).toEqual([750]);
    await h.runTimer();
    expect(pendingTimers(h).map((timer) => timer.ms)).toEqual([1500]);
    await h.runTimer();
    expect(pendingTimers(h).map((timer) => timer.ms)).toEqual([3000]);
    expect(h.clients).toHaveLength(0);

    h.preflight.mockResolvedValue({ checked: true });
    await h.runTimer();
    expect(h.clients).toHaveLength(1);
    expect(pendingTimers(h)).toHaveLength(0);
  });

  it("goes auth-failed on a rejected token, retries slowly, and recovers on a new token", async () => {
    const h = harness();
    h.preflight.mockRejectedValue(new PreflightAuthError("Connect token was rejected", 401));
    await h.supervisor.start();

    expect(lastState(h)).toMatchObject({ state: "auth-failed", detail: "Connect token was rejected" });
    expect(lastState(h).fix).toMatch(/connect setup/);
    expect(pendingTimers(h).map((timer) => timer.ms)).toEqual([600_000]);

    // The same token again (a spurious watch event) does not re-dial.
    h.fireTokenChange();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.preflight).toHaveBeenCalledTimes(1);

    h.token.value = "tok-2";
    h.preflight.mockResolvedValue({ checked: true });
    h.fireTokenChange();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.preflight).toHaveBeenLastCalledWith("tok-2", false);
    expect(h.clients.map((client) => client.token)).toEqual(["tok-2"]);
    expect(pendingTimers(h)).toHaveLength(0);
  });

  it("re-reads the token on each slow retry, independent of the watcher", async () => {
    const h = harness();
    h.preflight.mockRejectedValueOnce(new PreflightAuthError("rejected", 401));
    await h.supervisor.start();

    h.token.value = "tok-rotated";
    h.preflight.mockResolvedValue({ checked: true });
    await h.runTimer();
    expect(h.preflight).toHaveBeenLastCalledWith("tok-rotated", false);
    expect(h.clients).toHaveLength(1);
  });

  it("hands a hub-side token rejection to the slow retry", async () => {
    const h = harness();
    await h.supervisor.start();
    h.clients[0].callbacks.onAuthRejected(4001, "invalid token");

    expect(lastState(h)).toMatchObject({ state: "auth-failed" });
    expect(lastState(h).detail).toMatch(/rejected the connect token/);
    expect(pendingTimers(h).map((timer) => timer.ms)).toEqual([600_000]);
  });

  it("blocks on a pin mismatch without any retry against the hub", async () => {
    const h = harness();
    h.preflight.mockRejectedValue(new PinMismatchError("previously served remote A"));
    await h.supervisor.start();

    expect(lastState(h)).toMatchObject({ state: "blocked", detail: "previously served remote A" });
    expect(lastState(h).fix).toMatch(/setup --force/);
    expect(pendingTimers(h)).toHaveLength(0);

    h.fireTokenChange();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.preflight).toHaveBeenCalledTimes(1);
  });

  it("re-verifies the pin before using a changed token while connected", async () => {
    const h = harness();
    await h.supervisor.start();
    h.clients[0].callbacks.onConnected();

    h.token.value = "tok-other-remote";
    h.preflight.mockRejectedValue(new PinMismatchError("belongs to remote B"));
    h.fireTokenChange();
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.preflight).toHaveBeenLastCalledWith("tok-other-remote", false);
    expect(h.clients[0].shutdown).toHaveBeenCalled();
    expect(h.clients).toHaveLength(1);
    expect(lastState(h).state).toBe("blocked");
  });

  it("never uses a token changed during a hub outage before it is verified", async () => {
    const h = harness();
    await h.supervisor.start();
    h.clients[0].callbacks.onConnected();
    h.clients[0].callbacks.onDisconnected("hub down");

    // Swapped to another remote's token while the hub cannot be asked.
    h.token.value = "tok-other-remote";
    h.preflight.mockRejectedValue(new PreflightUnavailableError("Hub unreachable"));
    h.fireTokenChange();
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.clients.map((client) => client.token)).toEqual(["tok-1"]);
    expect(h.clients[0].shutdown).not.toHaveBeenCalled();
    expect(pendingTimers(h)).toHaveLength(1);

    // Hub back: the check now runs and catches the mismatch.
    h.preflight.mockRejectedValue(new PinMismatchError("belongs to remote B"));
    await h.runTimer();
    expect(h.preflight).toHaveBeenLastCalledWith("tok-other-remote", false);
    expect(h.clients.map((client) => client.token)).toEqual(["tok-1"]);
    expect(h.clients[0].shutdown).toHaveBeenCalled();
    expect(lastState(h).state).toBe("blocked");
  });

  it("waits for a token that is not there yet", async () => {
    const h = harness();
    h.token.value = new TokenUnavailableError("Cannot read connect token file");
    await h.supervisor.start();

    expect(lastState(h)).toMatchObject({ state: "auth-failed" });
    expect(h.preflight).not.toHaveBeenCalled();

    h.token.value = "tok-new";
    h.fireTokenChange();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.clients.map((client) => client.token)).toEqual(["tok-new"]);
  });

  it("fails fast on auth and pin errors when nobody supervises the process", async () => {
    const auth = harness({ failFast: true });
    auth.preflight.mockRejectedValue(new PreflightAuthError("rejected", 401));
    await expect(auth.supervisor.start()).rejects.toThrow("rejected");

    const pin = harness({ failFast: true });
    pin.preflight.mockRejectedValue(new PinMismatchError("mismatch"));
    await expect(pin.supervisor.start()).rejects.toThrow("mismatch");

    const network = harness({ failFast: true });
    network.preflight.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(network.supervisor.start()).resolves.toBeUndefined();
  });

  it("consumes a pending re-pin request only after a successful preflight", async () => {
    let requested = true;
    const h = harness({ repinRequested: () => requested });
    h.clearRepin.mockImplementation(() => {
      requested = false;
    });
    h.preflight.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await h.supervisor.start();
    expect(h.preflight).toHaveBeenLastCalledWith("tok-1", true);
    expect(h.clearRepin).not.toHaveBeenCalled();

    await h.runTimer();
    expect(h.preflight).toHaveBeenLastCalledWith("tok-1", true);
    expect(h.clearRepin).toHaveBeenCalledOnce();
  });

  it("stops cleanly: no timers, client shut down, late events ignored", async () => {
    const h = harness();
    await h.supervisor.start();
    const client = h.clients[0];
    h.supervisor.stop();

    expect(client.shutdown).toHaveBeenCalled();
    client.callbacks.onAuthRejected(4001, "late");
    expect(pendingTimers(h)).toHaveLength(0);
  });
});

describe("watchTokenFile", () => {
  it("fires when the token is atomically replaced", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-watch-"));
    const file = path.join(directory, "token");
    fs.writeFileSync(file, "one");
    const onChange = vi.fn();
    const unwatch = watchTokenFile(file, onChange, { debounceMs: 20 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(onChange).not.toHaveBeenCalled();

      const temp = path.join(directory, ".token.tmp");
      fs.writeFileSync(temp, "two");
      fs.renameSync(temp, file);
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
    } finally {
      unwatch();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
