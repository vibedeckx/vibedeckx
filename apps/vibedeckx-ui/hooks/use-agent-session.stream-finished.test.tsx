// @vitest-environment jsdom
//
// `streamFinished` answers "has the session stream delivered a finished state
// for this session, and when" — the input notification auto-read uses to tell
// "the user was shown this result" from "the user looked at a page that
// predates it". A plain `status !== "running"` can't: a warm-cache preview, or
// a revalidation that failed offline, restores a `stopped` that may be older
// than a turn finished elsewhere.
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

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
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  send() {}
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
}
vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;
let root: Root | null = null;

function Probe({ sessionId }: { sessionId: string }) {
  const hook = useAgentSession("sf-project", "main", undefined, undefined, { sessionId });
  useEffect(() => { latest = hook; });
  return null;
}

async function open(sessionId: string) {
  if (!root) root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(<Probe sessionId={sessionId} />); });
  await act(async () => { await Promise.resolve(); });
}

/** Bring the newest socket up and let it finish its replay. */
async function ready() {
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.readyState = FakeWebSocket.OPEN;
  await act(async () => { ws.onopen?.(); });
  await act(async () => { ws.receive({ Ready: true }); });
  return ws;
}

const statusPatch = (status: string) => ({
  JsonPatch: [{ op: "replace", path: "/status", value: { type: "STATUS", content: status } }],
});

const entryPatch = (index: number, content: unknown) => ({
  JsonPatch: [{ op: "add", path: `/entries/${index}`, value: { type: "ENTRY", content } }],
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) => {
    const id = String(url).match(/agent-sessions\/(sf-[ab])/)?.[1] ?? "unknown";
    return {
      ok: true,
      json: async () => ({
        session: { id, projectId: "sf-project", branch: "main", status: "stopped" },
        messages: [{ type: "assistant", content: `history-${id}`, timestamp: 1 }],
      }),
    } as Response;
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  latest = null;
});

describe("streamFinished", () => {
  it("is set only once the stream's replay lands, not by the REST load alone", async () => {
    await open("sf-a");
    expect(latest!.status).toBe("stopped");
    expect(latest!.streamFinished).toBeNull();

    await ready();
    expect(latest!.streamFinished?.sessionId).toBe("sf-a");
  });

  it("clears while a live turn runs and is re-stamped when it finishes", async () => {
    await open("sf-a");
    const ws = await ready();
    const first = latest!.streamFinished!.at;

    await act(async () => { ws.receive(statusPatch("running")); });
    expect(latest!.streamFinished).toBeNull();

    await act(async () => { ws.receive(statusPatch("stopped")); });
    expect(latest!.streamFinished?.sessionId).toBe("sf-a");
    expect(latest!.streamFinished!.at).toBeGreaterThanOrEqual(first);
  });

  it("carries the newest turn_end's server timestamp, not just the browser clock", async () => {
    await open("sf-a");
    const ws = await ready();
    expect(latest!.streamFinished?.turnEndAt).toBeNull();

    await act(async () => { ws.receive(statusPatch("running")); });
    // The worker's clock: deliberately far from the browser's Date.now().
    await act(async () => { ws.receive(entryPatch(1, { type: "turn_end", timestamp: 1234 })); });
    await act(async () => { ws.receive(statusPatch("stopped")); });
    expect(latest!.streamFinished?.turnEndAt).toBe(1234);

    // A replay picks it up the same way.
    await open("sf-b");
    const wsB = FakeWebSocket.instances.at(-1)!;
    wsB.readyState = FakeWebSocket.OPEN;
    await act(async () => { wsB.onopen?.(); });
    await act(async () => { wsB.receive(entryPatch(1, { type: "turn_end", timestamp: 5678 })); });
    await act(async () => { wsB.receive({ Ready: true }); });
    expect(latest!.streamFinished).toMatchObject({ sessionId: "sf-b", turnEndAt: 5678 });
  });

  it("is not claimed by a cached stopped state restored while the server is unreachable", async () => {
    // Visit A and B online, so A's stopped transcript sits in the warm cache.
    await open("sf-a");
    await ready();
    await open("sf-b");
    await ready();
    expect(latest!.streamFinished?.sessionId).toBe("sf-b");

    // Offline: reopening A can only show the cached copy — which may predate a
    // turn finished on another client — and revalidation fails.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await open("sf-a");

    expect(latest!.session?.id).toBe("sf-a");
    expect(latest!.status).toBe("stopped");
    // A socket may be attempted, but offline it never opens or replays.
    expect(latest!.streamFinished?.sessionId).not.toBe("sf-a");
  });
});
