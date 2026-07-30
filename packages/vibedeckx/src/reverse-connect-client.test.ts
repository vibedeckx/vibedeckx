import { afterEach, describe, expect, it, vi } from "vitest";

interface MockSocket {
  url: string;
  emit(event: string, ...args: unknown[]): void;
}

const socketState = vi.hoisted(() => ({
  instances: [] as MockSocket[],
}));

vi.mock("ws", () => {
  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    readyState = MockWebSocket.CONNECTING;

    constructor(readonly url: string) {
      socketState.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    close(): void {
      this.readyState = 3;
    }

    send(): void {}
  }

  return { default: MockWebSocket };
});

import { ReverseConnectClient } from "./reverse-connect-client.js";

afterEach(() => {
  socketState.instances.length = 0;
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

describe("local VIBEDECKX_API_KEY passthrough for tunnel-injected requests", () => {
  const startClient = (localServer: unknown) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = new ReverseConnectClient(localServer as never, "https://hub.example.com", "tok", 4567);
    client.connect();
    return { client, control: socketState.instances[0] };
  };

  it("adds the worker's own api-key header to injected HTTP requests when the env var is set", async () => {
    vi.stubEnv("VIBEDECKX_API_KEY", "local-secret");
    const inject = vi.fn().mockResolvedValue({ statusCode: 200, headers: { "content-type": "application/json" }, payload: "{}", rawPayload: Buffer.from("{}") });
    const { client, control } = startClient({ inject, storage: {} });

    control.emit("message", Buffer.from(JSON.stringify({
      type: "http_request", requestId: "r1", method: "GET", path: "/api/path/worktrees", headers: {},
    })));
    await vi.waitFor(() => expect(inject).toHaveBeenCalled());

    expect(inject.mock.calls[0][0].headers["x-vibedeckx-api-key"]).toBe("local-secret");
    client.shutdown();
    vi.unstubAllEnvs();
  });

  it("does not add the header when the env var is unset", async () => {
    vi.stubEnv("VIBEDECKX_API_KEY", "");
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

  it("appends apiKey to virtual-channel local WS URLs when the env var is set", async () => {
    vi.stubEnv("VIBEDECKX_API_KEY", "local-secret");
    const { client, control } = startClient({ inject: vi.fn(), storage: {} });

    control.emit("message", Buffer.from(JSON.stringify({
      type: "ws_open", channelId: "ch1", path: "/api/agent-sessions/s1/stream", query: "foo=1",
    })));
    await vi.waitFor(() => expect(socketState.instances.length).toBeGreaterThan(1));

    const localWs = socketState.instances[1];
    expect(localWs.url).toBe(`ws://127.0.0.1:4567/api/agent-sessions/s1/stream?foo=1&apiKey=${encodeURIComponent("local-secret")}`);
    client.shutdown();
    vi.unstubAllEnvs();
  });
});
