// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    authFetch: vi.fn(),
    getFreshToken: vi.fn().mockResolvedValue("test-token"),
    getWebSocketUrl: vi.fn().mockReturnValue("ws://test"),
  };
});

import { authFetch } from "@/lib/api";
import { useAgentSession } from "./use-agent-session";

const fetchMock = vi.mocked(authFetch);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    // Model the failure that prompted the fix: close() starts the handshake,
    // but the half-open network path never lets it finish or fire onclose.
    this.readyState = FakeWebSocket.CLOSING;
  }

  send() {}
}

vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;
let root: Root | null = null;

function Probe() {
  const hook = useAgentSession("watchdog-project", "main");
  useEffect(() => { latest = hook; });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      session: {
        id: "watchdog-session",
        projectId: "watchdog-project",
        branch: "main",
        status: "running",
      },
      messages: [],
    }),
  } as unknown as Response);
});

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
  }
  root = null;
  latest = null;
  vi.useRealTimers();
});

describe("agent WebSocket silence watchdog", () => {
  it("opens a replacement without waiting for the silent socket's onclose", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root!.render(<Probe />);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    const silentSocket = FakeWebSocket.instances[0];
    silentSocket.readyState = FakeWebSocket.OPEN;
    const lateClose = silentSocket.onclose;

    await act(async () => {
      silentSocket.onopen?.();
      await vi.advanceTimersByTimeAsync(95_000);
    });

    expect(silentSocket.closeCalls).toContainEqual({
      code: 4000,
      reason: "silence watchdog",
    });
    expect(silentSocket.readyState).toBe(FakeWebSocket.CLOSING);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const replacement = FakeWebSocket.instances[1];
    replacement.readyState = FakeWebSocket.OPEN;
    await act(async () => { replacement.onopen?.(); });
    expect(latest!.isConnected).toBe(true);

    // Even if the retired connection eventually reports its close, that stale
    // event must not mark the replacement disconnected or schedule another WS.
    await act(async () => {
      lateClose?.({ code: 4000, reason: "silence watchdog" } as CloseEvent);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(latest!.isConnected).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("ignores a retired socket's late frames and keeps watching the replacement", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root!.render(<Probe />);
      await vi.advanceTimersByTimeAsync(0);
    });

    const silentSocket = FakeWebSocket.instances[0];
    silentSocket.readyState = FakeWebSocket.OPEN;
    const lateMessage = silentSocket.onmessage;

    await act(async () => {
      silentSocket.onopen?.();
      await vi.advanceTimersByTimeAsync(95_000);
    });

    const replacement = FakeWebSocket.instances[1];
    replacement.readyState = FakeWebSocket.OPEN;
    await act(async () => { replacement.onopen?.(); });
    expect(latest!.isConnected).toBe(true);

    // The retired socket belongs to the same session as its replacement, so
    // nothing about the conversation's identity separates them — only socket
    // currency does. A straggler frame that gets through re-arms the single
    // shared silence timer against a socket that is already closing; that
    // timer then expires into a no-op and the live connection is never
    // watched again.
    await act(async () => {
      lateMessage?.({ data: JSON.stringify({ Ready: true }) } as MessageEvent);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Still watched: silence on the replacement retires it in turn.
    await act(async () => { await vi.advanceTimersByTimeAsync(95_000); });
    expect(replacement.closeCalls).toContainEqual({ code: 4000, reason: "silence watchdog" });
    expect(FakeWebSocket.instances).toHaveLength(3);
  });
});
