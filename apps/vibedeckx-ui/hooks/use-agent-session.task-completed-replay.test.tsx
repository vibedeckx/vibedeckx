// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { authFetch } from "@/lib/api";
import { toast } from "sonner";
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
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  send() {}
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
}
vi.stubGlobal("WebSocket", FakeWebSocket);

const onTaskCompleted = vi.fn();
let root: Root | null = null;

function Probe() {
  useAgentSession("p1", "main", undefined, undefined, { onTaskCompleted });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  onTaskCompleted.mockReset();
  vi.mocked(toast.success).mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      session: { id: "s1", projectId: "p1", branch: "main", status: "stopped" },
      messages: [],
    }),
  } as unknown as Response);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  vi.useRealTimers();
});

describe("taskCompleted frames during history replay", () => {
  it("ignores replayed taskCompleted frames (before Ready) and honours live ones (after Ready)", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => {
      root!.render(<Probe />);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    ws.readyState = FakeWebSocket.OPEN;
    await act(async () => { ws.onopen?.(); });

    // The front's remotePatchCache replays every cached frame on subscribe —
    // including taskCompleted frames from turns that finished long ago.
    await act(async () => {
      ws.receive({ taskCompleted: { duration_ms: 1000 } });
      ws.receive({ taskCompleted: { duration_ms: 2000 } });
    });
    expect(onTaskCompleted).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    await act(async () => { ws.receive({ Ready: true }); });

    // A genuinely new turn end after Ready still fires.
    await act(async () => { ws.receive({ taskCompleted: { duration_ms: 3000 } }); });
    expect(onTaskCompleted).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
