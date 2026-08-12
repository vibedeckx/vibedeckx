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
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() { this.readyState = FakeWebSocket.CLOSED; }
  send() {}
}
vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;
let root: Root | null = null;

function Probe({ sessionId, branch = "main" }: { sessionId?: string; branch?: string }) {
  const hook = useAgentSession("cache-project", branch, undefined, undefined, { sessionId });
  useEffect(() => { latest = hook; });
  return null;
}

async function render(sessionId?: string, branch = "main") {
  if (!root) root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(<Probe sessionId={sessionId} branch={branch} />); });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) => {
    const id = String(url).match(/agent-sessions\/(cache-session-[ab])/)?.[1] ?? "unknown";
    return {
      ok: true,
      json: async () => ({
        session: { id, projectId: "cache-project", branch: "main", status: "stopped" },
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

describe("agent session window cache", () => {
  it("revalidates a previously visited session and renders the current bounded window", async () => {
    await render("cache-session-a");
    expect(latest!.messages).toMatchObject([{ content: "history-cache-session-a" }]);

    await render("cache-session-b");
    expect(latest!.messages).toMatchObject([{ content: "history-cache-session-b" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await render("cache-session-a");
    expect(latest!.isInitialized).toBe(true);
    expect(latest!.messages).toMatchObject([{ content: "history-cache-session-a" }]);
    // Correctness does not depend on having observed a completion event while
    // this session was away: switching always revalidates its bounded head.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses the warm cache on ordinary workspace navigation after a head check", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/history-head")) {
        return {
          ok: true,
          json: async () => ({
            historyEpoch: 1,
            latestEntryIndex: 0,
            lastTurnEndEntryIndex: null,
            status: "stopped",
          }),
        } as Response;
      }
      const branch = JSON.parse(String(init?.body)).branch as string;
      const id = `cache-session-${branch}`;
      const message = { type: "assistant", content: `history-${id}`, timestamp: 1 };
      return {
        ok: true,
        json: async () => ({
          session: { id, projectId: "cache-project", branch, status: "stopped" },
          messages: [message],
          historyWindow: {
            historyEpoch: 1,
            latestEntryIndex: 0,
            lastTurnEndEntryIndex: null,
            entries: [{ entryIndex: 0, message }],
            previousCursor: null,
            hasMore: false,
          },
        }),
      } as Response;
    });

    await render(undefined, "a");
    await render(undefined, "b");
    await render(undefined, "a");

    expect(latest!.messages).toMatchObject([{ content: "history-cache-session-a" }]);
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.filter((url) => url.includes("/api/projects/")).length).toBe(2);
    expect(calls.at(-1)).toContain("cache-session-a/history-head");
  });
});
