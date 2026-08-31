// @vitest-environment jsdom
//
// Behavior tests for ensureSession's resident-limit confirmation flow:
// - single-flight: concurrent first-sends share one create call / one prompt
// - a workspace switch cancels an open prompt and discards the stale flow
// - unmount resolves a suspended caller instead of stranding it
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

import { createNewAgentSession, authFetch, ResidentLimitError } from "@/lib/api";
import {
  createAgentWorkspaceIdentity,
  sameAgentWorkspace,
  useAgentSession,
} from "./use-agent-session";
import { addPlaceholder, hasPlaceholder, removePlaceholder, workspaceKey } from "@/lib/placeholder-workspaces";

const createSession = vi.mocked(createNewAgentSession);
const fetchMock = vi.mocked(authFetch);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The hook opens a real WebSocket after a successful create; jsdom has none.
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

function Probe({ projectId, branch }: { projectId: string; branch: string }) {
  const hook = useAgentSession(projectId, branch);
  useEffect(() => {
    latest = hook;
  });
  return null;
}

let root: Root | null = null;

async function render(branch: string) {
  if (!root) {
    root = createRoot(document.body.appendChild(document.createElement("div")));
  }
  const r = root;
  await act(async () => {
    r.render(<Probe projectId="p1" branch={branch} />);
  });
}

const sessionPayload = {
  session: {
    id: "s-new",
    projectId: "p1",
    branch: "main",
    status: "running",
  },
  messages: [],
};

beforeEach(() => {
  for (const branch of ["main", "a", "b"]) {
    removePlaceholder(workspaceKey("p1", branch, null));
  }
  createSession.mockReset();
  // Auto-start on mount POSTs /agent-sessions looking for an existing
  // session; "none" keeps the hook in the empty-placeholder state so
  // ensureSession is the only create path exercised here.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ session: null, messages: [] }),
  } as unknown as Response);
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
});

describe("ensureSession resident-limit flow", () => {
  it("shares one create call and one prompt across concurrent callers", async () => {
    await render("main");
    createSession.mockRejectedValueOnce(new ResidentLimitError(3, []));

    let p1: Promise<unknown> = Promise.resolve();
    let p2: Promise<unknown> = Promise.resolve();
    await act(async () => {
      p1 = latest!.ensureSession();
      p2 = latest!.ensureSession();
    });

    // Single-flight: the second concurrent call joined the first.
    expect(p1).toBe(p2);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(latest!.residentLimitPrompt).not.toBeNull();
    expect(latest!.residentLimitPrompt!.maxResidentAgentProcesses).toBe(3);

    // Confirm eviction → one force-create, both callers get the session.
    createSession.mockResolvedValueOnce(sessionPayload);
    await act(async () => {
      latest!.residentLimitPrompt!.resolve(true);
    });
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenLastCalledWith("p1", "main", undefined, undefined, true, undefined);
    expect(latest!.residentLimitPrompt).toBeNull();
    await expect(p1).resolves.toMatchObject({
      session: { id: "s-new" },
      origin: { projectId: "p1", branch: "main" },
      adopted: true,
    });
  });

  it("declining the prompt aborts the send without creating a session", async () => {
    await render("main");
    createSession.mockRejectedValueOnce(new ResidentLimitError(3, []));

    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = latest!.ensureSession();
    });
    await act(async () => {
      latest!.residentLimitPrompt!.resolve(false);
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(latest!.residentLimitPrompt).toBeNull();
    await expect(pending).resolves.toBeNull();
    expect(latest!.session).toBeNull();
  });

  it("cancels an open prompt on branch switch and discards the stale flow", async () => {
    await render("a");
    createSession.mockRejectedValueOnce(new ResidentLimitError(3, []));

    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = latest!.ensureSession();
    });
    expect(latest!.residentLimitPrompt).not.toBeNull();

    // Switch workspace while the dialog is up.
    await render("b");

    expect(latest!.residentLimitPrompt).toBeNull();
    await expect(pending).resolves.toBeNull();
    // No force-create fired for the old branch, nothing written back into
    // the new workspace's UI state.
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(latest!.session).toBeNull();
    expect(latest!.error).toBeNull();
  });

  it("resolves a suspended caller on unmount instead of hanging it", async () => {
    await render("main");
    createSession.mockRejectedValueOnce(new ResidentLimitError(3, []));

    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = latest!.ensureSession();
    });
    expect(latest!.residentLimitPrompt).not.toBeNull();

    const r = root!;
    root = null;
    await act(async () => {
      r.unmount();
    });

    await expect(pending).resolves.toBeNull();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("returns a created session without adopting it after switching workspaces", async () => {
    await render("a");
    addPlaceholder(workspaceKey("p1", "a", null));
    let settle!: (value: typeof sessionPayload) => void;
    createSession.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));

    let pending!: ReturnType<HookApi["ensureSession"]>;
    await act(async () => { pending = latest!.ensureSession(); });
    expect(hasPlaceholder(workspaceKey("p1", "a", null))).toBe(true);

    await render("b");
    await act(async () => {
      settle({ ...sessionPayload, session: { ...sessionPayload.session, branch: "a" } });
      await pending;
    });

    const ensured = await pending;
    expect(ensured).toMatchObject({
      session: { id: "s-new", branch: "a" },
      origin: { projectId: "p1", branch: "a" },
      adopted: false,
    });
    expect(latest!.session).toBeNull();
    expect(hasPlaceholder(workspaceKey("p1", "a", null))).toBe(false);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "gone" }),
    } as unknown as Response);
    await act(async () => {
      expect(await latest!.sendEnsuredMessage(ensured!, "hello")).toBe(false);
    });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(url)).toContain("/api/agent-sessions/s-new/message");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      content: "hello",
    });
    // The failure belonged to branch a and must not blank or error branch b.
    expect(latest!.session).toBeNull();
    expect(latest!.error).toBeNull();
  });

  it("adopts a create that resolves after switching away and back", async () => {
    await render("a");
    addPlaceholder(workspaceKey("p1", "a", null));
    let settle!: (value: typeof sessionPayload) => void;
    createSession.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));

    let pending!: ReturnType<HookApi["ensureSession"]>;
    await act(async () => { pending = latest!.ensureSession(); });
    await render("b");
    await render("a");
    await act(async () => {
      settle({ ...sessionPayload, session: { ...sessionPayload.session, branch: "a" } });
      await pending;
    });

    await expect(pending).resolves.toMatchObject({ adopted: true, session: { id: "s-new" } });
    expect(latest!.session?.id).toBe("s-new");
    expect(hasPlaceholder(workspaceKey("p1", "a", null))).toBe(false);
  });

  it("normalizes omitted and literal local targets to the same identity", async () => {
    await render("main");
    createSession.mockResolvedValue(sessionPayload);

    let ensured!: Awaited<ReturnType<HookApi["ensureSession"]>>;
    await act(async () => { ensured = await latest!.ensureSession(); });

    expect(ensured!.origin.agentMode).toBe("local");
    expect(sameAgentWorkspace(
      ensured!.origin,
      createAgentWorkspaceIdentity("p1", "main", "local", null)!,
    )).toBe(true);
  });

  it("restores the origin placeholder after discarding an empty created session", async () => {
    await render("main");
    addPlaceholder(workspaceKey("p1", "main", null));
    createSession.mockResolvedValue(sessionPayload);

    let ensured!: Awaited<ReturnType<HookApi["ensureSession"]>>;
    await act(async () => { ensured = await latest!.ensureSession(); });
    expect(latest!.session?.id).toBe("s-new");
    expect(hasPlaceholder(workspaceKey("p1", "main", null))).toBe(false);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, discarded: true }),
    } as unknown as Response);
    await act(async () => {
      expect(await latest!.discardEnsuredSessionIfEmpty(ensured!)).toBe(true);
    });

    expect(latest!.session).toBeNull();
    expect(latest!.isInitialized).toBe(true);
    expect(hasPlaceholder(workspaceKey("p1", "main", null))).toBe(true);
  });
});
