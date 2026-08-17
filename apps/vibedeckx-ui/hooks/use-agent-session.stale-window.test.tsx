// @vitest-environment jsdom
//
// A history window is a snapshot taken when its request left. These tests pin
// the three-way rule for committing one on top of a stream that kept moving:
// keep the live tail for the SAME conversation, and replace wholesale when the
// session or the entry-index namespace changed underneath it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
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
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  /** An unexpected drop (1006), which is what schedules a reconnect — a 1000
   *  close is by definition deliberate and deliberately does not. */
  drop() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code: 1006 } as CloseEvent); }
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

/** An entry patch in the shape the server broadcasts. */
const entryPatch = (entryIndex: number, message: unknown) => ({
  JsonPatch: [{ op: "add", path: `/entries/${entryIndex}`, value: { type: "ENTRY", content: message } }],
});

function windowResponse(opts: {
  sessionId: string;
  entries: Array<{ entryIndex: number; message: unknown }>;
  historyEpoch?: number;
  status?: string;
}) {
  const indices = opts.entries.map((entry) => entry.entryIndex);
  const lastTurnEnd = [...opts.entries].reverse()
    .find((entry) => (entry.message as { type: string }).type === "turn_end")?.entryIndex ?? null;
  return {
    historyEpoch: opts.historyEpoch ?? 0,
    latestEntryIndex: indices.length > 0 ? Math.max(...indices) : null,
    lastTurnEndEntryIndex: lastTurnEnd,
    entries: opts.entries,
    previousCursor: indices.length > 0 ? Math.min(...indices) : null,
    hasMore: true,
    status: opts.status ?? "stopped",
    session: { id: opts.sessionId, projectId: "p1", branch: "main", status: opts.status ?? "stopped" },
  };
}

/** Assistant messages by text, everything else by kind — tool frames carry
 *  their own `content` and would otherwise read as opaque payloads. */
const contents = () => (latest!.messages as Array<{ content?: unknown; type: string }>)
  .map((message) => message.type === "assistant" ? String(message.content) : message.type);

/** The window the server would have returned before entry 226 existed. */
const staleWindow = (sessionId: string, historyEpoch = 0) => windowResponse({
  sessionId,
  historyEpoch,
  entries: [
    { entryIndex: 223, message: text("assistant-223") },
    { entryIndex: 224, message: { type: "tool_use", name: "Bash", input: {}, id: "t1", timestamp: 1 } },
    { entryIndex: 225, message: { type: "tool_result", content: "out", tool_use_id: "t1", timestamp: 1 } },
  ],
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  latest = null;
  fetchMock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  latest = null;
});

describe("committing a history window over a live stream tail", () => {
  it("keeps entries the stream already applied when a stale window resolves late", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/history-head")) {
        return { ok: true, json: async () => ({ historyEpoch: 0, latestEntryIndex: 225, lastTurnEndEntryIndex: null, status: "running" }) } as Response;
      }
      return { ok: true, json: async () => staleWindow("s1") } as Response;
    });

    await render("s1");
    expect(contents()).toEqual(["assistant-223", "tool_use", "tool_result"]);

    // The turn finishes on the socket: closing message plus its turn_end.
    const socket = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.receive(entryPatch(226, text("final-explanation")));
      socket.receive(entryPatch(227, turnEnd));
      socket.receive({ Ready: true, historyEpoch: 0 });
    });
    expect(contents()).toContain("final-explanation");

    // A window request issued before 226 existed now resolves and is committed.
    await act(async () => { await latest!.startSession(); });

    expect(contents()).toEqual([
      "assistant-223", "tool_use", "tool_result", "final-explanation", "turn_end",
    ]);
    expect(latest!.messageEntryIndices).toEqual([223, 224, 225, 226, 227]);
  });

  it("advertises the merged tail as the reconnect cursor, not the stale window's", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/history-head")) {
        return { ok: true, json: async () => ({ historyEpoch: 0, latestEntryIndex: 225, lastTurnEndEntryIndex: null, status: "running" }) } as Response;
      }
      return { ok: true, json: async () => staleWindow("s1") } as Response;
    });

    await render("s1");
    const socket = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.receive(entryPatch(226, text("final-explanation")));
      socket.receive(entryPatch(227, turnEnd));
      socket.receive({ Ready: true, historyEpoch: 0 });
    });
    await act(async () => { await latest!.startSession(); });

    // Reconnecting must not ask for "everything after 221-and-earlier": the
    // cursor has to name the turn_end the browser actually holds, or the
    // server's bounded replay will never resend 222..227.
    const before = FakeWebSocket.instances.length;
    await act(async () => { FakeWebSocket.instances.at(-1)!.drop(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
    expect(FakeWebSocket.instances.at(-1)!.url).toContain("after=227");
    vi.useRealTimers();
  });

  it("replaces wholesale when the resolved session differs from the previewed one", async () => {
    let releaseLatest!: () => void;
    const latestGate = new Promise<void>((resolve) => { releaseLatest = resolve; });
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/history-head")) {
        return { ok: true, json: async () => ({ historyEpoch: 0, latestEntryIndex: 225, lastTurnEndEntryIndex: null, status: "stopped" }) } as Response;
      }
      if (init?.method === "POST" && String(url).endsWith("/agent-sessions")) {
        await latestGate;
        return {
          ok: true,
          json: async () => ({
            session: { id: "s2", projectId: "p1", branch: "main", status: "stopped" },
            messages: [text("session-two-history")],
            historyWindow: windowResponse({ sessionId: "s2", entries: [{ entryIndex: 0, message: text("session-two-history") }] }),
          }),
        } as Response;
      }
      return { ok: true, json: async () => staleWindow("s1") } as Response;
    });

    // Visit s1 and let its stream advance past the window, so the warm snapshot
    // carries a tail no window knows about.
    await render("s1");
    const socket = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.receive(entryPatch(226, text("s1-only-tail")));
      socket.receive({ Ready: true, historyEpoch: 0 });
    });
    expect(contents()).toContain("s1-only-tail");

    // Now arrive without a session id: the preview restores s1 (tail included)
    // while the branch's latest session resolves to s2.
    await render(undefined);
    expect(latest!.session?.id).toBe("s1");
    expect(contents()).toContain("s1-only-tail");

    await act(async () => { releaseLatest(); });

    expect(latest!.session?.id).toBe("s2");
    expect(contents()).toEqual(["session-two-history"]);
    expect(contents()).not.toContain("s1-only-tail");
  });

  it("replaces wholesale when the window names a new history epoch", async () => {
    let epoch = 0;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/history-head")) {
        return { ok: true, json: async () => ({ historyEpoch: epoch, latestEntryIndex: 225, lastTurnEndEntryIndex: null, status: "stopped" }) } as Response;
      }
      return { ok: true, json: async () => staleWindow("s1", epoch) } as Response;
    });

    await render("s1");
    const socket = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      socket.receive(entryPatch(226, text("old-epoch-tail")));
      socket.receive({ Ready: true, historyEpoch: 0 });
    });
    expect(contents()).toContain("old-epoch-tail");

    // The conversation was replaced server-side: index 226 in the new namespace
    // is a different message, so carrying the old one over would fabricate one.
    epoch = 1;
    await act(async () => { await latest!.startSession(); });

    expect(contents()).toEqual(["assistant-223", "tool_use", "tool_result"]);
    expect(contents()).not.toContain("old-epoch-tail");
  });
});
