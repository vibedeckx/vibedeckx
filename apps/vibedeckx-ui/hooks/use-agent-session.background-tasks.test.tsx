// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createNewAgentSession: vi.fn(),
    authFetch: vi.fn(),
    getFreshToken: vi.fn().mockResolvedValue("test-token"),
    getWebSocketUrl: vi.fn().mockReturnValue("ws://test"),
  };
});

import { authFetch } from "@/lib/api";
import { useAgentSession } from "./use-agent-session";

const fetchMock = vi.mocked(authFetch);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sockets: FakeWebSocket[] = [];

/**
 * The readyState constants are load-bearing: the hook guards against duplicate
 * connections with `wsRef.current?.readyState === WebSocket.OPEN`, and a fake
 * without them makes that `undefined === undefined` — so no socket is ever
 * opened and the test silently exercises nothing.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState: number = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() { sockets.push(this); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  send() {}
}
vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;

function Probe({ branch = "main" }: { branch?: string }) {
  const hook = useAgentSession("p1", branch);
  useEffect(() => { latest = hook; });
  return null;
}

let root: Root | null = null;

async function render(branch?: string) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  const r = root;
  await act(async () => { r.render(<Probe branch={branch} />); });
  // The socket opens behind an awaited token fetch, so it does not exist yet
  // when render() resolves.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/**
 * Push a frame into every socket the hook has opened. The bar's state arrives
 * only this way, which is exactly why the identity-change paths have to clear
 * it themselves — a workspace with no live session opens no socket at all.
 */
async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function deliverTasks(tasks: Array<{ taskId: string; startedAt: number }>, turnParked: boolean) {
  await flush();
  await act(async () => {
    for (const socket of sockets) {
      socket.onmessage?.({ data: JSON.stringify({ backgroundTasks: { tasks, turnParked } }) });
    }
  });
}

beforeEach(() => {
  sockets.length = 0;
  // A live session is what makes the hook open a socket, which is the only
  // channel the task snapshot ever arrives on.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", permissionMode: "edit", agentType: "claude-code" },
      messages: [],
    }),
  } as unknown as Response);
});

afterEach(async () => {
  const r = root;
  if (r) await act(async () => { r.unmount(); });
  root = null;
  latest = null;
});

describe("useAgentSession background tasks", () => {
  it("starts empty and is not parked", async () => {
    await render();
    expect(latest!.backgroundTasks).toEqual({ tasks: [], turnParked: false, parkDeadlineAt: null, canStopTasks: false });
  });

  // A worker at v0.3.27 sends only `tasks` and `turnParked` — that release is
  // on main and in the field. Stored raw, the missing deadline reaches the bar
  // as undefined and renders "NaN:NaN 后自动收尾本轮" next to a "keep running"
  // button whose route that worker does not serve.
  it("normalizes the older two-field frame instead of storing it raw", async () => {
    await render();
    await deliverTasks([{ taskId: "b1", startedAt: 1 }], true);
    expect(latest!.backgroundTasks).toEqual({
      tasks: [{ taskId: "b1", startedAt: 1 }],
      turnParked: true,
      parkDeadlineAt: null,
      canStopTasks: false,
    });
  });

  it("startNewConversation clears the previous session's tasks", async () => {
    await render();
    await deliverTasks([{ taskId: "b1", startedAt: 1 }], true);
    expect(latest!.backgroundTasks.tasks).toHaveLength(1);

    await act(async () => { await latest!.startNewConversation(); });

    expect(latest!.backgroundTasks).toEqual({ tasks: [], turnParked: false, parkDeadlineAt: null, canStopTasks: false });
  });

  // Distinct branches from the test above: startNewConversation records a
  // module-level placeholder for its workspace, and a workspace in placeholder
  // mode never opens a socket to seed this test.
  it("switching workspace clears them without waiting for a frame", async () => {
    await render("dev1");
    await deliverTasks([{ taskId: "b1", startedAt: 1 }], true);
    expect(latest!.backgroundTasks.tasks).toHaveLength(1);

    await render("dev2");

    expect(latest!.backgroundTasks).toEqual({ tasks: [], turnParked: false, parkDeadlineAt: null, canStopTasks: false });
  });
});
