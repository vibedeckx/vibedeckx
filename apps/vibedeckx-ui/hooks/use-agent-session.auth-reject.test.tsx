// @vitest-environment jsdom
//
// On a flaky network the Clerk token mint (POST /v1/client/sessions/:id/tokens)
// fails, the cached 60s JWT expires, and a reconnect carrying it is answered
// {error: "Invalid authentication token"}. That used to land verbatim in the
// agent pane's error banner, and three such short-lived sockets even got the
// session recreated. A rejection is transient: retry quietly with a fresh mint.
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
    hasUsableStreamToken: vi.fn().mockReturnValue(true),
  };
});

import { authFetch, getFreshToken, hasUsableStreamToken, STREAM_AUTH_FAILED_MESSAGE } from "@/lib/api";
import { useAgentSession } from "./use-agent-session";

const fetchMock = vi.mocked(authFetch);
const tokenMock = vi.mocked(getFreshToken);
const usableMock = vi.mocked(hasUsableStreamToken);
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

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {}
  send() {}

  /** What the server does to a rejected token: open, error frame, close. */
  reject() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ error: "Invalid authentication token" }) } as MessageEvent);
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1005, reason: "" } as CloseEvent);
  }
}

vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;
let root: Root | null = null;

function Probe() {
  const hook = useAgentSession("auth-project", "main");
  useEffect(() => { latest = hook; });
  return null;
}

async function mount() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root!.render(<Probe />);
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  tokenMock.mockClear();
  usableMock.mockReset();
  usableMock.mockReturnValue(true);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      session: { id: "auth-session", projectId: "auth-project", branch: "main", status: "running" },
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

describe("agent WebSocket auth rejection", () => {
  it("retries with a fresh token without showing the server's auth error", async () => {
    await mount();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => { FakeWebSocket.instances[0].reject(); });
    expect(latest!.error).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(tokenMock).toHaveBeenLastCalledWith({ skipCache: true });
  });

  it("keeps the session even after repeated rejections (not a short-lived-session signal)", async () => {
    await mount();
    for (let i = 0; i < 2; i++) {
      await act(async () => { FakeWebSocket.instances.at(-1)!.reject(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    }
    expect(latest!.session?.id).toBe("auth-session");
    expect(latest!.error).toBeNull();
  });

  it("surfaces an actionable message once fresh tokens keep being rejected", async () => {
    await mount();
    for (let i = 0; i < 3; i++) {
      await act(async () => { FakeWebSocket.instances.at(-1)!.reject(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    }
    expect(latest!.error).toBe(STREAM_AUTH_FAILED_MESSAGE);
    expect(latest!.session?.id).toBe("auth-session");
  });

  it("does not open a socket while only a dead token is available, and connects once one is", async () => {
    usableMock.mockReturnValue(false);
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(FakeWebSocket.instances).toHaveLength(0);

    usableMock.mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(latest!.error).toBeNull();
  });

  it("reconnects immediately when the browser comes back online", async () => {
    usableMock.mockReturnValue(false);
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(FakeWebSocket.instances).toHaveLength(0);

    usableMock.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
