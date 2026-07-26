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

import { createNewAgentSession, authFetch } from "@/lib/api";
import { useAgentSession } from "./use-agent-session";

const createSession = vi.mocked(createNewAgentSession);
const fetchMock = vi.mocked(authFetch);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
  send() {}
}
vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;

function Probe() {
  const hook = useAgentSession("p1", "main");
  useEffect(() => { latest = hook; });
  return null;
}

let root: Root | null = null;

async function render() {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  const r = root;
  await act(async () => { r.render(<Probe />); });
}

beforeEach(() => {
  createSession.mockReset();
  // Keeps the hook in the empty-placeholder state so ensureSession is the only
  // create path exercised.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ session: null, messages: [] }),
  } as unknown as Response);
});

afterEach(async () => {
  const r = root;
  if (r) await act(async () => { r.unmount(); });
  root = null;
  latest = null;
});

describe("useAgentSession model", () => {
  it("sends the chosen model in the create request", async () => {
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", model: "opus" },
      messages: [],
    });

    await act(async () => { await latest!.ensureSession("edit", "opus"); });

    expect(createSession).toHaveBeenCalledWith("p1", "main", "edit", undefined, undefined, "opus");
  });

  it("sends no model when none was chosen", async () => {
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running" },
      messages: [],
    });

    await act(async () => { await latest!.ensureSession("edit"); });

    expect(createSession).toHaveBeenCalledWith("p1", "main", "edit", undefined, undefined, undefined);
  });

  it("exposes the model returned by the server on the session object", async () => {
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", model: "sonnet" },
      messages: [],
    });

    let created: { model?: string | null } | null = null;
    await act(async () => { created = await latest!.ensureSession("edit", "sonnet"); });

    expect(created!.model).toBe("sonnet");
  });
});
