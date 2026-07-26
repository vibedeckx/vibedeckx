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
