// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    authFetch: vi.fn(),
    getFreshToken: vi.fn().mockResolvedValue("test-token"),
    getWebSocketUrl: vi.fn((path: string) => `ws://test${path}`),
  };
});

import { api, authFetch } from "@/lib/api";
import { useChatSession } from "./use-chat-session";
import { clearChatStreamCaches } from "./chat-stream";

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
    this.readyState = FakeWebSocket.CLOSED;
  }

  send() {}

  /** Server-side helpers. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  frame(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
  replay(contents: string[]) {
    this.frame({
      JsonPatch: contents.map((content, i) => ({
        op: "add",
        path: `/entries/${i}`,
        value: { type: "ENTRY", content: { type: "assistant", content, timestamp: i } },
      })),
    });
    this.frame({ JsonPatch: [{ op: "replace", path: "/status", value: { type: "STATUS", content: "stopped" } }] });
    this.frame({ Ready: true });
  }
}

vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useChatSession>;
/**
 * Every COMMITTED render's hook output, in order — lets a test assert on the
 * first paint. Recorded from a layout effect, not during render: a workspace
 * switch legitimately triggers a setState-during-render whose output React
 * discards before commit, and the user never sees it.
 */
let renders: HookApi[] = [];
let root: Root | null = null;

function Probe({ branch }: { branch: string }) {
  const hook = useChatSession("p1", branch);
  useLayoutEffect(() => { renders.push(hook); });
  return null;
}

async function render(branch: string): Promise<void> {
  await act(async () => {
    root!.render(<Probe branch={branch} />);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const latest = () => renders[renders.length - 1];

/** Server-side listening flag per session id — what create-or-get reports back. */
let serverListening: Record<string, boolean> = {};

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  renders = [];
  serverListening = {};
  clearChatStreamCaches();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    const branch = JSON.parse(String(init?.body ?? "{}")).branch as string;
    const id = `chat-${branch}`;
    return {
      ok: true,
      json: async () => ({
        session: { id, projectId: "p1", branch, status: "stopped", eventListeningEnabled: serverListening[id] ?? false },
        messages: [],
      }),
    } as unknown as Response;
  });
  vi.spyOn(api, "setChatEventListening").mockImplementation(async (sessionId, enabled) => {
    serverListening[sessionId] = enabled;
    return true;
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  vi.useRealTimers();
});

describe("Main Chat workspace switch", () => {
  it("opens exactly one socket per workspace and closes the old one on switch", async () => {
    await render("main");
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe("ws://test/api/chat-sessions/chat-main/stream");

    await render("dev");
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0].closeCalls).toEqual([{ code: 1000, reason: "branch-switch" }]);
    expect(FakeWebSocket.instances[1].url).toBe("ws://test/api/chat-sessions/chat-dev/stream");
    // One create-or-get per workspace, no retries or cascades.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never shows the previous workspace's transcript after a switch", async () => {
    await render("main");
    await act(async () => { FakeWebSocket.instances[0].open(); FakeWebSocket.instances[0].replay(["from main"]); });
    expect(latest().messages.map((m) => "content" in m && m.content)).toEqual(["from main"]);

    renders = [];
    await render("dev");
    // Every render since the switch belongs to `dev`: empty until its replay.
    for (const r of renders) expect(r.messages).toEqual([]);
    expect(latest().isInitialized).toBe(false);
  });

  it("paints a revisited workspace's last transcript on the first render", async () => {
    await render("main");
    await act(async () => { FakeWebSocket.instances[0].open(); FakeWebSocket.instances[0].replay(["from main"]); });
    await render("dev");

    renders = [];
    await render("main");
    // First paint already carries the cached transcript, before any frame.
    expect(renders[0].messages.map((m) => "content" in m && m.content)).toEqual(["from main"]);
    expect(renders[0].session?.id).toBe("chat-main");
    // …but the input stays gated until the live replay confirms.
    expect(renders[0].isInitialized).toBe(false);

    const sock = FakeWebSocket.instances[2];
    expect(sock.url).toBe("ws://test/api/chat-sessions/chat-main/stream");
    await act(async () => { sock.open(); sock.replay(["from main", "newer"]); });
    expect(latest().messages.map((m) => "content" in m && m.content)).toEqual(["from main", "newer"]);
    expect(latest().isInitialized).toBe(true);
    // Session id was cached: the socket URL above came from it, and the
    // revisit's create-or-get is only the non-blocking metadata refresh.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps an unsent draft per workspace across a switch and back", async () => {
    await render("main");
    await act(async () => { latest().setDraft("half-typed in main"); });
    expect(latest().draft).toBe("half-typed in main");

    await render("dev");
    expect(latest().draft).toBe("");
    await act(async () => { latest().setDraft("dev draft"); });

    renders = [];
    await render("main");
    // Restored on the very first committed render, before any network.
    expect(renders[0].draft).toBe("half-typed in main");

    await render("dev");
    expect(latest().draft).toBe("dev draft");
  });

  it("shows the listening flag the server holds after toggling, leaving and returning", async () => {
    await render("main");
    expect(latest().session?.eventListeningEnabled).toBe(false);

    await act(async () => { await latest().setEventListening(true); });
    expect(api.setChatEventListening).toHaveBeenCalledWith("chat-main", true);
    expect(latest().session?.eventListeningEnabled).toBe(true);

    await render("dev");
    expect(latest().session?.eventListeningEnabled).toBe(false);

    renders = [];
    await render("main");
    // The cached row was updated by the toggle: correct from the first paint…
    expect(renders[0].session?.eventListeningEnabled).toBe(true);
    // …and stays so once the background metadata refresh lands.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(latest().session?.eventListeningEnabled).toBe(true);
  });

  it("adopts a server-side flip of the listening flag on revisit", async () => {
    await render("main");
    await render("dev");
    // e.g. the runExecutor tool auto-enabled listening while we were away.
    serverListening["chat-main"] = true;

    await render("main");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(latest().session?.eventListeningEnabled).toBe(true);
    // The socket was opened from the cached id immediately, not after the refresh.
    expect(FakeWebSocket.instances[2].url).toBe("ws://test/api/chat-sessions/chat-main/stream");
  });

  it("does not let a slow metadata refresh overwrite a toggle made while it was in flight", async () => {
    await render("main");
    await render("dev");

    // The revisit's metadata refresh is served slowly, from a snapshot taken
    // BEFORE the user toggles (so it says false).
    let resolveRefresh: (r: Response) => void = () => {};
    const slow = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    fetchMock.mockImplementationOnce(() => slow);
    await render("main");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => { await latest().setEventListening(true); });
    expect(latest().session?.eventListeningEnabled).toBe(true);

    await act(async () => {
      resolveRefresh({
        ok: true,
        json: async () => ({
          session: { id: "chat-main", projectId: "p1", branch: "main", status: "stopped", eventListeningEnabled: false },
          messages: [],
        }),
      } as unknown as Response);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest().session?.eventListeningEnabled).toBe(true);

    // The caches were not poisoned either: the next visit starts from true.
    await render("dev");
    renders = [];
    await render("main");
    expect(renders[0].session?.eventListeningEnabled).toBe(true);
  });

  it("ignores frames from the socket of a workspace the user left", async () => {
    await render("main");
    const stale = FakeWebSocket.instances[0];
    await render("dev");
    await act(async () => { stale.open(); stale.replay(["ghost"]); });
    expect(latest().messages).toEqual([]);
    expect(latest().isConnected).toBe(false);
  });
});
