import { afterEach, describe, expect, it, vi } from "vitest";

interface MockSocket {
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

    constructor(_url: string) {
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
