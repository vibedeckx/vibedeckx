import { afterEach, describe, expect, it, vi } from "vitest";

interface MockSocket {
  url: string;
  options?: Record<string, unknown>;
  readyState: number;
  terminated: boolean;
  emit(event: string, ...args: unknown[]): void;
}

const socketState = vi.hoisted(() => ({
  instances: [] as MockSocket[],
  // 'error' events emitted with nobody listening. EventEmitter throws on those,
  // and thrown from a nextTick callback it takes the worker process down — so a
  // test that only watched for a missing reconnect would report this as a pass.
  unhandled: [] as unknown[],
}));

vi.mock("ws", () => {
  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    readyState = MockWebSocket.CONNECTING;
    terminated = false;

    constructor(readonly url: string, readonly options?: Record<string, unknown>) {
      socketState.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      // Real ws transitions before it announces.
      if (event === "open") this.readyState = MockWebSocket.OPEN;
      if (event === "close") this.readyState = MockWebSocket.CLOSED;
      const listeners = this.listeners.get(event) ?? [];
      // EventEmitter throws on an 'error' nobody listens for. Reproducing that
      // is the whole point of the terminate()-on-CONNECTING regression test.
      if (event === "error" && listeners.length === 0) {
        socketState.unhandled.push(args[0]);
        throw args[0] instanceof Error ? args[0] : new Error("Unhandled mock error");
      }
      for (const listener of listeners) listener(...args);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSING;
    }

    terminate(): void {
      this.terminated = true;
      if (this.readyState === MockWebSocket.CLOSED) return;
      if (this.readyState === MockWebSocket.CONNECTING) {
        // ws routes this through abortHandshake, which emits `error` and then
        // `close` from a process.nextTick callback (websocket.js:486 → :1039).
        this.readyState = MockWebSocket.CLOSING;
        process.nextTick(() => {
          this.emit("error", new Error("WebSocket was closed before the connection was established"));
          this.emit("close", 1006, Buffer.from(""));
        });
        return;
      }
      this.readyState = MockWebSocket.CLOSED;
    }

    removeAllListeners(): void {
      this.listeners.clear();
    }

    send(): void {}
  }

  return { default: MockWebSocket };
});

import { ReverseConnectClient } from "./reverse-connect-client.js";

afterEach(() => {
  socketState.instances.length = 0;
  socketState.unhandled.length = 0;
  vi.restoreAllMocks();
});

describe("ReverseConnectClient secret-safe diagnostics", () => {
  it("redacts raw and URL-encoded tokens from async error and close logs", () => {
    const token = "secret/with?reserved=value&percent%";
    const encodedToken = encodeURIComponent(token);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new ReverseConnectClient(
      {} as never,
      "https://connect.example.com",
      token,
      1234,
    );

    client.connect();
    const socket = socketState.instances[0];
    expect(socket).toBeDefined();
    socket.emit(
      "error",
      new Error(`failed raw=${token} encoded=${encodedToken}`),
    );
    socket.emit(
      "close",
      4000,
      Buffer.from(`raw=${token}; encoded=${encodedToken}`),
    );
    client.shutdown();

    const diagnostics = [...log.mock.calls, ...error.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(diagnostics).not.toContain(token);
    expect(diagnostics).not.toContain(encodedToken);
    expect(diagnostics).toContain("[redacted]");
  });
});

// A worker can inherit VIBEDECKX_API_KEY from ~/.vibedeckx/.env without ever
// meaning to lock itself. That used to 401 the whole tunnel, so the client
// injected the local key back. Now the key only gates /api/admin/*, which the
// tunnel never calls, and the injection is gone — these tests keep it gone,
// because re-adding it would put the operator secret on the wire for free.
describe("tunnel-injected requests carry no local VIBEDECKX_API_KEY", () => {
  const startClient = (localServer: unknown) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = new ReverseConnectClient(localServer as never, "https://hub.example.com", "tok", 4567);
    client.connect();
    return { client, control: socketState.instances[0] };
  };

  it("does not add an api-key header to injected HTTP requests even when the env var is set", async () => {
    vi.stubEnv("VIBEDECKX_API_KEY", "local-secret");
    const inject = vi.fn().mockResolvedValue({ statusCode: 200, headers: { "content-type": "application/json" }, payload: "{}", rawPayload: Buffer.from("{}") });
    const { client, control } = startClient({ inject, storage: {} });

    control.emit("message", Buffer.from(JSON.stringify({
      type: "http_request", requestId: "r1", method: "GET", path: "/api/path/worktrees", headers: {},
    })));
    await vi.waitFor(() => expect(inject).toHaveBeenCalled());

    expect(inject.mock.calls[0][0].headers["x-vibedeckx-api-key"]).toBeUndefined();
    client.shutdown();
    vi.unstubAllEnvs();
  });

  it("does not append apiKey to virtual-channel local WS URLs", async () => {
    vi.stubEnv("VIBEDECKX_API_KEY", "local-secret");
    const { client, control } = startClient({ inject: vi.fn(), storage: {} });

    control.emit("message", Buffer.from(JSON.stringify({
      type: "ws_open", channelId: "ch1", path: "/api/agent-sessions/s1/stream", query: "foo=1",
    })));
    await vi.waitFor(() => expect(socketState.instances.length).toBeGreaterThan(1));

    const localWs = socketState.instances[1];
    expect(localWs.url).toBe("ws://127.0.0.1:4567/api/agent-sessions/s1/stream?foo=1");
    client.shutdown();
    vi.unstubAllEnvs();
  });
});

describe("reconnect backoff", () => {
  // The hub accepts the upgrade and only then closes with 4001/4003, so `open`
  // fires on every rejected attempt. Clearing the backoff there pinned the retry
  // delay at its 1s floor — a worker with a stale token hammered the hub ~1Hz.
  const attemptsFrom = (log: ReturnType<typeof vi.spyOn>) =>
    log.mock.calls
      .flat()
      .map(String)
      .map((line) => /Reconnecting in \d+ms \(attempt (\d+)\)/.exec(line)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps backing off across repeated post-upgrade auth rejections", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new ReverseConnectClient({} as never, "https://hub.example.com", "stale", 4567);

    client.connect();
    for (let i = 0; i < 3; i++) {
      const socket = socketState.instances[i];
      socket.emit("open");
      socket.emit("close", 4001, Buffer.from("Invalid token"));
      vi.advanceTimersByTime(10_000);
    }
    client.shutdown();

    expect(attemptsFrom(log)).toEqual([1, 2, 3]);
  });

  it("clears the backoff once a connection actually holds", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new ReverseConnectClient({} as never, "https://hub.example.com", "stale", 4567);

    client.connect();
    for (let i = 0; i < 2; i++) {
      const socket = socketState.instances[i];
      socket.emit("open");
      socket.emit("close", 4001, Buffer.from("Invalid token"));
      vi.advanceTimersByTime(10_000);
    }
    // A working tunnel that runs for a while, then drops on transport error.
    const healthy = socketState.instances[2];
    healthy.emit("open");
    vi.advanceTimersByTime(30_000);
    healthy.emit("close", 1006, Buffer.from(""));
    client.shutdown();

    expect(attemptsFrom(log)).toEqual([1, 2, 1]);
  });

  it("does not clear the backoff for a socket torn down right after the upgrade", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = new ReverseConnectClient({} as never, "https://hub.example.com", "tok", 4567);

    client.connect();
    for (let i = 0; i < 2; i++) {
      const socket = socketState.instances[i];
      socket.emit("open");
      // Non-auth code, but the socket never lasted — e.g. an intermediary
      // dropping it. Treating this as healthy would recreate the 1Hz loop.
      socket.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(10_000);
    }
    client.shutdown();

    expect(attemptsFrom(log)).toEqual([1, 2]);
  });

  it("reports an auth rejection at error level with a recovery hint", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new ReverseConnectClient({} as never, "https://hub.example.com", "stale", 4567);

    client.connect();
    const socket = socketState.instances[0];
    socket.emit("open");
    socket.emit("close", 4001, Buffer.from("Invalid token"));
    client.shutdown();

    const message = error.mock.calls.flat().map(String).join("\n");
    expect(message).toContain("code=4001");
    expect(message).toMatch(/no longer valid/i);
    expect(message).toContain("vibedeckx connect");
  });
});

// The client used to hang every recovery path off events that a wedged socket
// never fires: `open`/`ping` armed the liveness check and `close` scheduled the
// reconnect, so a dial stuck in CONNECTING went silent forever. These pin the
// supervisor that judges the connection against the wall clock instead.
describe("connection supervisor", () => {
  const reconnectAttempts = (log: ReturnType<typeof vi.spyOn>) =>
    log.mock.calls
      .flat()
      .map(String)
      .map((line) => /Reconnecting in \d+ms \(attempt (\d+)\)/.exec(line)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);

  const startClient = () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new ReverseConnectClient({} as never, "https://hub.example.com", "tok", 4567);
    client.connect();
    return { client, log, warn, warned: () => warn.mock.calls.flat().map(String).join("\n") };
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives every dial a handshake timeout", () => {
    const { client } = startClient();
    expect(socketState.instances[0].options?.handshakeTimeout).toBe(20_000);
    client.shutdown();
  });

  it("re-dials a socket that sits in CONNECTING and never completes the handshake", () => {
    vi.useFakeTimers();
    const { client, log, warned } = startClient();
    expect(socketState.instances).toHaveLength(1);

    // No open, no error, no close — the shape that wedged a worker for six days.
    vi.advanceTimersByTime(30_000);

    expect(warned()).toMatch(/dial stuck/);
    expect(reconnectAttempts(log)).toEqual([1]);
    client.shutdown();
  });

  it("terminating a stuck dial neither crashes nor double-schedules the reconnect", async () => {
    vi.useFakeTimers();
    const { client, log } = startClient();
    const stuck = socketState.instances[0];

    vi.advanceTimersByTime(30_000);
    expect(stuck.terminated).toBe(true);

    // ws emits `error` and then `close` from a later tick. Dropping the
    // listeners before terminate() would make that error unhandled and take the
    // worker down; the late close must not queue a second reconnect either.
    await new Promise<void>((resolve) => process.nextTick(resolve));

    expect(socketState.unhandled).toEqual([]);
    expect(reconnectAttempts(log)).toEqual([1]);
    client.shutdown();
  });

  it("tears down an open socket that stops hearing from the hub", () => {
    vi.useFakeTimers();
    const { client, log, warned } = startClient();
    const socket = socketState.instances[0];
    socket.emit("open");

    vi.advanceTimersByTime(50_000);

    expect(warned()).toMatch(/no hub traffic/);
    expect(socket.terminated).toBe(true);
    expect(reconnectAttempts(log)).toEqual([1]);
    client.shutdown();
  });

  it("keeps an open socket that is still hearing from the hub", () => {
    vi.useFakeTimers();
    const { client, log } = startClient();
    const socket = socketState.instances[0];
    socket.emit("open");

    // The hub pings every 30s; each frame refreshes the liveness clock.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(30_000);
      socket.emit("message", Buffer.from(JSON.stringify({ type: "ping", ts: Date.now() })));
    }

    expect(socket.terminated).toBe(false);
    expect(reconnectAttempts(log)).toEqual([]);
    client.shutdown();
  });

  it("forces a reconnect when the close handshake stalls in CLOSING", () => {
    vi.useFakeTimers();
    const { client, log, warned } = startClient();
    const socket = socketState.instances[0];
    socket.emit("open");
    // The peer went away mid-teardown: ws waits for a close frame that never
    // comes. Its own destroy timer is 30s and only exists once close() was
    // called at all, so the supervisor has to own this deadline.
    socket.readyState = 2;

    vi.advanceTimersByTime(40_000);

    expect(warned()).toMatch(/close handshake stalled/);
    expect(reconnectAttempts(log)).toEqual([1]);
    client.shutdown();
  });

  it("declares the tunnel dead on the first tick after a long suspend", () => {
    vi.useFakeTimers();
    const { client, log } = startClient();
    const socket = socketState.instances[0];
    socket.emit("open");

    // The host slept for two hours. What matters is the wall clock, not how
    // many ticks the supervisor managed to run while it was out.
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    vi.advanceTimersByTime(10_000);

    expect(socket.terminated).toBe(true);
    expect(reconnectAttempts(log)).toEqual([1]);
    client.shutdown();
  });

  it("self-heals when it holds neither a socket nor a pending reconnect", () => {
    vi.useFakeTimers();
    const { client, log, warned } = startClient();
    // The state a worker is left in when the close event that was supposed to
    // schedule the reconnect never arrives.
    (client as unknown as { ws: unknown }).ws = null;

    vi.advanceTimersByTime(10_000);

    expect(warned()).toMatch(/no socket and no pending reconnect/);
    expect(reconnectAttempts(log)).toEqual([1]);
    client.shutdown();
  });

  it("stops the supervisor and schedules nothing after shutdown", () => {
    vi.useFakeTimers();
    const { client, log } = startClient();
    client.shutdown();
    const dials = socketState.instances.length;

    vi.advanceTimersByTime(120_000);

    expect(socketState.instances).toHaveLength(dials);
    expect(reconnectAttempts(log)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
