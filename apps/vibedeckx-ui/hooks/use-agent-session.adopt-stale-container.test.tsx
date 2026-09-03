// @vitest-environment jsdom
//
// Repro for the "new session shows the previous session's transcript" report:
// adopting a freshly created session must not inherit the entry buffer of the
// session that was on screen when the create went out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    startAgentSession: vi.fn(),
    authFetch: vi.fn(),
    getFreshToken: vi.fn(),
    getWebSocketUrl: vi.fn((path: string) => `ws://test${path}`),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { authFetch, getFreshToken, startAgentSession, type LifecycleResponse } from "@/lib/api";
import { useAgentSession } from "./use-agent-session";

const fetchMock = vi.mocked(authFetch);
const start = vi.mocked(startAgentSession);
const token = vi.mocked(getFreshToken);

/**
 * Every connect first awaits a token, and only then swaps the socket. Holding
 * that hop open is the only way to observe the window in which the PREVIOUS
 * session's socket is still the current one.
 */
function heldToken() {
  const gates: Array<() => void> = [];
  token.mockImplementation(() => new Promise<string>((resolve) => {
    gates.push(() => resolve("test-token"));
  }));
  return {
    /** Release token hops in the order they were requested. */
    async releaseAll() {
      while (gates.length > 0) await act(async () => { gates.shift()!(); });
    },
    /** Release them newest-first: two hops settling out of order. */
    async releaseReversed() {
      while (gates.length > 0) await act(async () => { gates.pop()!(); });
    },
    pending: () => gates.length,
  };
}
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
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
}
vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;
let root: Root | null = null;

function Probe({ sessionId }: { sessionId?: string }) {
  const hook = useAgentSession("p1", "main", undefined, undefined, { sessionId });
  useEffect(() => { latest = hook; });
  return null;
}

async function render(sessionId?: string) {
  if (!root) root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(<Probe sessionId={sessionId} />); });
}

const text = (content: string) => ({ type: "assistant" as const, content, timestamp: 1 });
const turnEnd = { type: "turn_end" as const, timestamp: 1, durationMs: 1000 };
const entryPatch = (entryIndex: number, message: unknown) => ({
  JsonPatch: [{ op: "add", path: `/entries/${entryIndex}`, value: { type: "ENTRY", content: message } }],
});

/** The session the user was reading: a long, sealed transcript. */
const oldWindow = {
  historyEpoch: 0,
  latestEntryIndex: 286,
  lastTurnEndEntryIndex: 286,
  entries: [
    { entryIndex: 285, message: text("old-session-answer") },
    { entryIndex: 286, message: turnEnd },
  ],
  previousCursor: 285,
  hasMore: true,
  status: "stopped",
  session: { id: "s-old", projectId: "p1", branch: "main", status: "stopped" },
};

const activated = (sessionId: string): LifecycleResponse => ({
  status: 201,
  kind: "activated",
  lifecycle: {
    sessionId, projectId: "p1", branch: "main", state: "active", purpose: "interactive",
    leaseHeld: false, activationKey: "k", activationAttempt: 1, activatedAt: 1,
    activationErrorCode: null, userEntryIndex: 0, expiredReason: null, expiredAt: null,
    pendingExpiresAt: null,
  },
  session: {
    id: sessionId, projectId: "p1", branch: "main", status: "running",
    permissionMode: "edit", agentType: "claude-code", model: null, processAlive: true,
  },
});

const contents = () => (latest!.messages as Array<{ content?: unknown; type: string }>)
  .map((message) => message.type === "assistant" ? String(message.content) : message.type);

beforeEach(() => {
  window.sessionStorage.clear();
  FakeWebSocket.instances = [];
  latest = null;
  fetchMock.mockReset();
  start.mockReset();
  token.mockReset();
  token.mockResolvedValue("test-token");
  fetchMock.mockImplementation(async (url) => {
    if (String(url).includes("/history-head")) {
      return { ok: true, json: async () => ({ historyEpoch: 0, latestEntryIndex: 286, lastTurnEndEntryIndex: 286, status: "stopped" }) } as Response;
    }
    return { ok: true, json: async () => oldWindow } as Response;
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  latest = null;
});

describe("adopting a newly created session", () => {
  it("drops the previous session's entries instead of rendering them under the new id", async () => {
    await render("s-old");
    await act(async () => { FakeWebSocket.instances.at(-1)!.open(); });
    expect(latest!.session?.id).toBe("s-old");
    expect(contents()).toEqual(["old-session-answer", "turn_end"]);

    // "New Conversation", then send "hi": the create goes out while the view
    // holds no session...
    await act(async () => { await latest!.startNewConversation(); });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    start.mockImplementationOnce(async () => { await createGate; return activated("s-new"); });
    let sending!: Promise<unknown>;
    await act(async () => { sending = latest!.startConversation("hi", "edit", null); });

    // ...but the URL still names s-old, so the workspace re-resolves it and
    // repaints its transcript while the create is in flight (this is the
    // `?after=286` reconnect seen in production).
    await act(async () => { await latest!.startSession(); });
    expect(contents()).toEqual(["old-session-answer", "turn_end"]);

    await act(async () => { releaseCreate(); await sending; });

    expect(latest!.session?.id).toBe("s-new");
    // The old transcript belongs to s-old. It must not appear under s-new.
    expect(contents()).toEqual([]);
    expect(latest!.messageEntryIndices).toEqual([]);

    // ...and the reconnect cursor must not be the old session's turn_end.
    const socket = FakeWebSocket.instances.at(-1)!;
    expect(socket.url).toContain("/s-new/stream");
    expect(socket.url).not.toContain("after=286");

    await act(async () => {
      socket.open();
      socket.receive(entryPatch(0, text("new-session-answer")));
      socket.receive({ Ready: true, historyEpoch: 0 });
    });
    expect(contents()).toEqual(["new-session-answer"]);
  });

  it("drops frames from the previous session's socket while the replacement connects", async () => {
    await render("s-old");
    await act(async () => { FakeWebSocket.instances.at(-1)!.open(); });
    expect(contents()).toEqual(["old-session-answer", "turn_end"]);

    await act(async () => { await latest!.startNewConversation(); });
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    start.mockImplementationOnce(async () => { await createGate; return activated("s-new"); });
    let sending!: Promise<unknown>;
    await act(async () => { sending = latest!.startConversation("hi", "edit", null); });

    // The re-resolve of ?session=s-old reconnects, so a LIVE s-old socket owns
    // `wsRef` when the create comes back.
    await act(async () => { await latest!.startSession(); });
    const oldSocket = FakeWebSocket.instances.at(-1)!;
    expect(oldSocket.url).toContain("/s-old/stream");
    await act(async () => { oldSocket.open(); });

    // Hold the replacement's token hop so the adopt lands while s-old's socket
    // is still the current one.
    const gates = heldToken();
    await act(async () => { releaseCreate(); await sending; });
    expect(gates.pending()).toBeGreaterThan(0);

    // Creating a session on this branch stops the previous one, so its socket
    // emits a closing entry and a status patch right here. Both belong to
    // s-old, and s-old's socket is still `wsRef.current` — only the buffer's
    // own id can tell them apart from frames this view is waiting for.
    await act(async () => {
      oldSocket.receive(entryPatch(287, text("old-session-farewell")));
      oldSocket.receive({ JsonPatch: [{ op: "replace", path: "/status", value: { type: "STATUS", content: "stopped" } }] });
    });
    expect(contents()).toEqual([]);

    await gates.releaseAll();
    const socket = FakeWebSocket.instances.at(-1)!;
    expect(socket.url).toContain("/s-new/stream");
    await act(async () => {
      socket.open();
      socket.receive(entryPatch(0, text("new-session-answer")));
      socket.receive({ Ready: true, historyEpoch: 0 });
    });
    expect(contents()).toEqual(["new-session-answer"]);
  });

  it("revokes a connect that is still fetching its token when the view tears down", async () => {
    // The first connect of a session owns no socket until its token lands.
    // Every teardown path used to key its cleanup off `wsRef.current`, so it
    // saw nothing to clean up and left the claim standing.
    const gates = heldToken();
    await render("s-old");
    expect(gates.pending()).toBeGreaterThan(0);
    expect(FakeWebSocket.instances).toEqual([]);

    await act(async () => { await latest!.startNewConversation(); });
    await gates.releaseAll();

    expect(FakeWebSocket.instances).toEqual([]);
    expect(latest!.session).toBeNull();
    expect(contents()).toEqual([]);
  });

  it("ignores a connect for the abandoned session whose token settles last", async () => {
    await render("s-old");
    await act(async () => { FakeWebSocket.instances.at(-1)!.open(); });

    await act(async () => { await latest!.startNewConversation(); });
    const gates = heldToken();
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    start.mockImplementationOnce(async () => { await createGate; return activated("s-new"); });
    let sending!: Promise<unknown>;
    await act(async () => { sending = latest!.startConversation("hi", "edit", null); });

    // A re-resolve of the URL's ?session=s-old opens a connect that stalls...
    await act(async () => { await latest!.startSession(); });
    // ...and the create lands while it is still stalled.
    await act(async () => { releaseCreate(); await sending; });
    expect(gates.pending()).toBeGreaterThanOrEqual(2);
    const openedBeforeRelease = FakeWebSocket.instances.length;

    // The stalled hops settle, s-new's before s-old's. The straggler names a
    // session the view has left: it must not open a socket at all, because
    // `openSocket` would close the live one to make room for it.
    await gates.releaseReversed();
    expect(FakeWebSocket.instances.slice(openedBeforeRelease).map((ws) => ws.url))
      .toEqual([expect.stringContaining("/s-new/stream")]);
    const live = FakeWebSocket.instances.filter((ws) => ws.readyState !== FakeWebSocket.CLOSED);
    expect(live.map((ws) => ws.url)).toEqual([expect.stringContaining("/s-new/stream")]);
  });
});

describe("connecting a socket over a buffer that belongs elsewhere", () => {
  it("replaces the loaded transcript when the resolved session has no history of its own", async () => {
    await render("s-old");
    await act(async () => { FakeWebSocket.instances.at(-1)!.open(); });
    expect(contents()).toEqual(["old-session-answer", "turn_end"]);

    // The id resolves to a different session, and that one is empty. The
    // window carries nothing to commit, so the buffer is never overwritten —
    // it is still holding s-old's entries when the socket for s-other opens.
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/history-head")) {
        return { ok: true, json: async () => ({ historyEpoch: 0, latestEntryIndex: null, lastTurnEndEntryIndex: null, status: "stopped" }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          historyEpoch: 0, latestEntryIndex: null, lastTurnEndEntryIndex: null,
          entries: [], previousCursor: null, hasMore: false, status: "stopped",
          session: { id: "s-other", projectId: "p1", branch: "main", status: "stopped" },
        }),
      } as Response;
    });
    await act(async () => { await latest!.startSession(); });
    expect(latest!.session?.id).toBe("s-other");

    const socket = FakeWebSocket.instances.at(-1)!;
    expect(socket.url).toContain("/s-other/stream");
    await act(async () => {
      socket.open();
      socket.receive({ Ready: true, historyEpoch: 0 });
    });
    expect(contents()).toEqual([]);
  });
});

describe("switching sessions while a socket is still live", () => {
  it("does not let the outgoing socket's watchdog reclaim the stream mid-switch", async () => {
    vi.useFakeTimers();
    try {
      await render("s-old");
      await act(async () => { FakeWebSocket.instances.at(-1)!.open(); });

      await act(async () => { await latest!.startNewConversation(); });
      let releaseCreate!: () => void;
      const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
      start.mockImplementationOnce(async () => { await createGate; return activated("s-new"); });
      let sending!: Promise<unknown>;
      await act(async () => { sending = latest!.startConversation("hi", "edit", null); });

      // The re-resolve of ?session=s-old leaves a LIVE socket on the outgoing
      // session, which is what arms the watchdog below.
      await act(async () => { await latest!.startSession(); });
      const oldSocket = FakeWebSocket.instances.at(-1)!;
      expect(oldSocket.url).toContain("/s-old/stream");
      await act(async () => { oldSocket.open(); });

      // Walk s-old's 95s silence watchdog to just short of firing. It has to
      // land INSIDE the switch's 5s token wait: any later and that wait's own
      // timeout arm opens s-new first, and `openSocket` retires s-old on its
      // way in — which is not the ordering under test.
      await act(async () => { await vi.advanceTimersByTimeAsync(93_000); });

      // Adopt s-new; its socket is stuck on the token hop.
      const gates = heldToken();
      await act(async () => { releaseCreate(); await sending; });
      expect(gates.pending()).toBeGreaterThan(0);
      const openedBeforeSilence = FakeWebSocket.instances.length;

      // s-old now goes quiet. Its watchdog reads wsRef/wsSessionIdRef to decide
      // where to reconnect — state that still names s-old unless the claim
      // retired it. Firing here would reclaim the stream for the conversation
      // the view just left and discard the s-new continuation.
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      await gates.releaseAll();

      expect(FakeWebSocket.instances.slice(openedBeforeSilence).map((ws) => ws.url))
        .toEqual([expect.stringContaining("/s-new/stream")]);
      expect(latest!.session?.id).toBe("s-new");
    } finally {
      vi.useRealTimers();
    }
  });
});
