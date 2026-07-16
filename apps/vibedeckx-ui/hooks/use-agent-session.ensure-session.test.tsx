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
import { useAgentSession } from "./use-agent-session";

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
    expect(createSession).toHaveBeenLastCalledWith("p1", "main", undefined, undefined, true);
    expect(latest!.residentLimitPrompt).toBeNull();
    await expect(p1).resolves.toMatchObject({ id: "s-new" });
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
});
