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

// `branch` is a prop so a test can navigate to another workspace mid-request:
// the hook is not remounted, it is re-rendered against a different workspace,
// exactly as the app does it.
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

  it("does not collapse concurrent different-model calls into one create", async () => {
    await render();
    // Hold each create call open (never resolve within this act) so both
    // calls are genuinely in flight at once, not serialized by a microtask.
    const deferred: Array<(value: Awaited<ReturnType<typeof createNewAgentSession>>) => void> = [];
    createSession.mockImplementation(
      () => new Promise((resolve) => { deferred.push(resolve); }),
    );

    let opusPromise: Promise<unknown> = Promise.resolve();
    let sonnetPromise: Promise<unknown> = Promise.resolve();
    await act(async () => {
      opusPromise = latest!.ensureSession("edit", "opus");
      sonnetPromise = latest!.ensureSession("edit", "sonnet");
    });

    // Two distinct models in flight at once must produce two create calls,
    // not one collapsed via the single-flight guard.
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenNthCalledWith(1, "p1", "main", "edit", undefined, undefined, "opus");
    expect(createSession).toHaveBeenNthCalledWith(2, "p1", "main", "edit", undefined, undefined, "sonnet");
    expect(opusPromise).not.toBe(sonnetPromise);

    // Drain both so nothing leaks into the next test.
    await act(async () => {
      deferred[0]({ session: { id: "s-opus", projectId: "p1", branch: "main", status: "running", model: "opus" }, messages: [] });
      deferred[1]({ session: { id: "s-sonnet", projectId: "p1", branch: "main", status: "running", model: "sonnet" }, messages: [] });
      await Promise.all([opusPromise, sonnetPromise]);
    });
  });

  it("routes a third same-model call to the already in-flight entry instead of firing a duplicate create", async () => {
    await render();
    // Regression for the single-slot ref bug: A (opus) sets the guard, B
    // (sonnet) races in and must not clobber A's entry, then C (opus again)
    // must join A rather than seeing B's entry and firing its own create.
    const deferred: Array<(value: Awaited<ReturnType<typeof createNewAgentSession>>) => void> = [];
    createSession.mockImplementation(
      () => new Promise((resolve) => { deferred.push(resolve); }),
    );

    let opusPromiseA: Promise<unknown> = Promise.resolve();
    let sonnetPromise: Promise<unknown> = Promise.resolve();
    let opusPromiseC: Promise<unknown> = Promise.resolve();
    await act(async () => {
      opusPromiseA = latest!.ensureSession("edit", "opus");
      sonnetPromise = latest!.ensureSession("edit", "sonnet");
      opusPromiseC = latest!.ensureSession("edit", "opus");
    });

    // Only two physical create calls: one for opus (A), one for sonnet (B).
    // C must have joined A's in-flight promise rather than firing a third.
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(opusPromiseC).toBe(opusPromiseA);
    expect(sonnetPromise).not.toBe(opusPromiseA);

    await act(async () => {
      deferred[0]({ session: { id: "s-opus", projectId: "p1", branch: "main", status: "running", model: "opus" }, messages: [] });
      deferred[1]({ session: { id: "s-sonnet", projectId: "p1", branch: "main", status: "running", model: "sonnet" }, messages: [] });
      await Promise.all([opusPromiseA, sonnetPromise, opusPromiseC]);
    });
  });

  it("posts a model change for the existing session and shows what was stored", async () => {
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", model: "opus" },
      messages: [],
    });
    await act(async () => { await latest!.ensureSession("edit", "opus"); });

    // The server trims and folds a blank name to the CLI default, so the chip
    // must follow the stored value rather than the string that was sent.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, model: "sonnet" }),
    } as unknown as Response);

    let err: string | null = "unset";
    await act(async () => { err = await latest!.setModel("  sonnet  "); });

    expect(err).toBeNull();
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toContain("/api/agent-sessions/s1/model");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ model: "  sonnet  " });
    expect(latest!.session?.model).toBe("sonnet");
  });

  it("keeps the model on screen when the server refuses the change", async () => {
    // A 409 (turn in flight) must leave the chip showing the model the session
    // will actually run on, and hand the reason back for the toast.
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", model: "opus" },
      messages: [],
    });
    await act(async () => { await latest!.ensureSession("edit", "opus"); });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "Agent is currently running — stop it before changing the model" }),
    } as unknown as Response);

    let err: string | null = null;
    await act(async () => { err = await latest!.setModel("sonnet"); });

    expect(err).toContain("currently running");
    expect(latest!.session?.model).toBe("opus");
  });

  it("drops a reply that arrives after the user has moved to another session", async () => {
    // The reply belongs to the session it was sent for. Applying it to
    // whatever is on screen when it lands would stamp one conversation's model
    // onto another — and cache it under the workspace this call captured.
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", model: "opus" },
      messages: [],
    });
    await act(async () => { await latest!.ensureSession("edit", "opus"); });

    let settle: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    let pending: Promise<string | null>;
    await act(async () => { pending = latest!.setModel("sonnet"); });

    // Navigate to another workspace, which resolves to its own session, while
    // the model request is still in flight.
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        session: { id: "s2", projectId: "p1", branch: "other", status: "running", model: "haiku" },
        messages: [],
      }),
    } as unknown as Response));
    await render("other");
    expect(latest!.session?.id).toBe("s2");

    await act(async () => {
      settle({ ok: true, json: async () => ({ success: true, model: "sonnet" }) } as unknown as Response);
      await pending!;
    });

    // s2 is left on its own model — the reply was for s1.
    expect(latest!.session?.id).toBe("s2");
    expect(latest!.session?.model).toBe("haiku");
  });

  it("queues a second pick behind the first, so the last one is what sticks", async () => {
    // Sent concurrently, the server could apply them in either order and the
    // older reply could land last — leaving the chip on a model the user had
    // already replaced.
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", model: "opus" },
      messages: [],
    });
    await act(async () => { await latest!.ensureSession("edit", "opus"); });
    const callsBefore = fetchMock.mock.calls.length;

    let settleFirst: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { settleFirst = resolve; }));
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ success: true, model: "haiku" }),
    } as unknown as Response));

    let first: Promise<string | null>;
    let second: Promise<string | null>;
    await act(async () => {
      first = latest!.setModel("sonnet");
      second = latest!.setModel("haiku");
    });

    // Only the first is on the wire; the second is waiting its turn.
    expect(fetchMock.mock.calls.length - callsBefore).toBe(1);

    await act(async () => {
      settleFirst({ ok: true, json: async () => ({ success: true, model: "sonnet" }) } as unknown as Response);
      expect(await first!).toBeNull();
      expect(await second!).toBeNull();
    });

    expect(fetchMock.mock.calls.length - callsBefore).toBe(2);
    const bodies = fetchMock.mock.calls.slice(callsBefore).map(
      ([, init]) => JSON.parse((init as RequestInit).body as string).model,
    );
    expect(bodies).toEqual(["sonnet", "haiku"]);
    expect(latest!.session?.model).toBe("haiku");
  });

  it("clears the cached model after switching agent type", async () => {
    await render();
    createSession.mockResolvedValue({
      session: { id: "s1", projectId: "p1", branch: "main", status: "running", agentType: "claude-code", model: "opus" },
      messages: [],
    });

    await act(async () => { await latest!.ensureSession("edit", "opus"); });
    expect(latest!.session?.model).toBe("opus");

    // switchAgentType posts to /agent-type; the default authFetch mock
    // already resolves { ok: true }, which is all switchAgentTypeApi checks.
    let switchError: string | null = null;
    await act(async () => { switchError = await latest!.switchAgentType("codex"); });

    expect(switchError).toBeNull();
    // The server clears the model on an agent switch (a model name is
    // agent-specific — "opus" is meaningless to Codex). The cached session
    // exposed by the hook must reflect that, not keep echoing the old model.
    expect(latest!.session?.model).toBeNull();
  });
});
