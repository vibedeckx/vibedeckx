// @vitest-environment jsdom
//
// The token hop in front of the WebSocket is the one step with no failure path
// of its own: getFreshToken() swallows its own errors, so a *hung* Clerk
// getToken() used to leave the `.then` unreached — no socket, no error, no
// reconnect. For a remote session that also means the front server never opens
// its worker stream, so the whole turn completes with nobody listening.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createNewAgentSession: vi.fn(),
    authFetch: vi.fn(),
    getFreshToken: vi.fn(),
    getWebSocketUrl: vi.fn().mockReturnValue("ws://test"),
  };
});

import { createNewAgentSession, authFetch, getFreshToken } from "@/lib/api";
import { useAgentSession } from "./use-agent-session";

const createSession = vi.mocked(createNewAgentSession);
const fetchMock = vi.mocked(authFetch);
const tokenMock = vi.mocked(getFreshToken);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const opened: string[] = [];
class FakeWebSocket {
  // The real static constants matter here: `openSocket`'s duplicate-connection
  // guard compares `wsRef.current?.readyState` (undefined when unset) against
  // `WebSocket.OPEN`, so a fake without them makes every connect a no-op.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  constructor(url: string) {
    opened.push(url);
  }
  close() {}
  send() {}
}
vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;

function Probe() {
  const hook = useAgentSession("p1", "main");
  useEffect(() => {
    latest = hook;
  });
  return null;
}

let root: Root | null = null;

async function render() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const r = root;
  await act(async () => {
    r.render(<Probe />);
  });
}

beforeEach(() => {
  opened.length = 0;
  createSession.mockReset();
  tokenMock.mockReset();
  // No existing session on mount, so the create below is the only WS trigger.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ session: null, messages: [] }),
  } as unknown as Response);
  createSession.mockResolvedValue({
    session: { id: "s-new", projectId: "p1", branch: "main", status: "running" },
    messages: [],
  } as unknown as Awaited<ReturnType<typeof createNewAgentSession>>);
});

afterEach(async () => {
  const r = root;
  if (r) {
    await act(async () => {
      r.unmount();
    });
  }
  root = null;
  latest = null;
  vi.useRealTimers();
});

describe("WebSocket connect when the token fetch stalls", () => {
  it("opens the socket anyway once the token wait times out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Clerk's getToken() hanging: the promise never settles.
    tokenMock.mockReturnValue(new Promise<string | null>(() => {}));

    await render();
    await act(async () => {
      await latest!.ensureSession();
    });

    // Still nothing — we genuinely wait for the token first.
    expect(opened).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(opened.length).toBeGreaterThan(0);
  });

  it("opens immediately when the token resolves", async () => {
    tokenMock.mockResolvedValue("test-token");

    await render();
    await act(async () => {
      await latest!.ensureSession();
    });

    expect(opened.length).toBeGreaterThan(0);
  });
});
