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
import { useChatSession } from "./use-chat-session";

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
    // The failure this watchdog exists for: close() starts a handshake the
    // half-open path never completes, so onclose may arrive late or never.
    this.readyState = FakeWebSocket.CLOSING;
  }

  send() {}
}

vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useChatSession>;
let latest: HookApi | null = null;
let root: Root | null = null;
let projectSeq = 0;

function Probe({ projectId }: { projectId: string }) {
  const hook = useChatSession(projectId, "main");
  useEffect(() => { latest = hook; });
  return null;
}

/** Render the hook against a fresh project id (the session cache is module-level). */
async function mount(): Promise<void> {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root!.render(<Probe projectId={`chat-watchdog-${++projectSeq}`} />);
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      session: {
        id: "chat-session",
        projectId: `chat-watchdog-${projectSeq + 1}`,
        branch: "main",
        status: "stopped",
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

describe("chat WebSocket silence watchdog", () => {
  it("opens a replacement without waiting for the silent socket's onclose", async () => {
    await mount();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const silentSocket = FakeWebSocket.instances[0];
    silentSocket.readyState = FakeWebSocket.OPEN;

    await act(async () => {
      silentSocket.onopen?.();
      await vi.advanceTimersByTimeAsync(95_000);
    });

    expect(silentSocket.closeCalls).toContainEqual({ code: 4000, reason: "silence watchdog" });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("ignores a retired socket's late close and frames", async () => {
    await mount();

    const silentSocket = FakeWebSocket.instances[0];
    silentSocket.readyState = FakeWebSocket.OPEN;
    const lateClose = silentSocket.onclose;
    const lateMessage = silentSocket.onmessage;

    await act(async () => {
      silentSocket.onopen?.();
      await vi.advanceTimersByTimeAsync(95_000);
    });

    const replacement = FakeWebSocket.instances[1];
    replacement.readyState = FakeWebSocket.OPEN;
    await act(async () => { replacement.onopen?.(); });
    expect(latest!.isConnected).toBe(true);

    // The retired socket eventually reports its close and even delivers a
    // straggler frame. Neither may disconnect the replacement, schedule
    // another socket, or clear the replacement's silence timer — the last of
    // which would leave the live connection unwatched for the rest of its life.
    await act(async () => {
      lateClose?.({ code: 4000, reason: "silence watchdog" } as CloseEvent);
      lateMessage?.({ data: JSON.stringify({ Ready: true }) } as MessageEvent);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(latest!.isConnected).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Still watched: silence on the replacement retires it in turn.
    await act(async () => { await vi.advanceTimersByTimeAsync(95_000); });
    expect(replacement.closeCalls).toContainEqual({ code: 4000, reason: "silence watchdog" });
    expect(FakeWebSocket.instances).toHaveLength(3);
  });
});
