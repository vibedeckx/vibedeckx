// @vitest-environment jsdom
//
// First-send lifecycle (design §10.1): the submission is persisted under a
// stable operation key before any request; a resident-limit prompt retries
// the SAME key with force; a transport failure keeps the key for the next
// send; a hard refresh replays it before the placeholder shows; the session
// is adopted (cached, connected, selected) only when the server says it is
// real; prepare → activate for uploads, with cancel on preprocessing failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    startAgentSession: vi.fn(),
    prepareAgentSession: vi.fn(),
    activateAgentSession: vi.fn(),
    cancelPreparedAgentSession: vi.fn(async () => ({ status: 200, kind: "cancelled" })),
    authFetch: vi.fn(),
    getFreshToken: vi.fn().mockResolvedValue("test-token"),
    getWebSocketUrl: vi.fn().mockReturnValue("ws://test"),
  };
});

import {
  startAgentSession, prepareAgentSession, activateAgentSession, cancelPreparedAgentSession, authFetch,
  type LifecycleResponse,
} from "@/lib/api";
import { useAgentSession } from "./use-agent-session";
import { readPendingSubmission, writePendingSubmission } from "@/lib/pending-submissions";
import { addPlaceholder, hasPlaceholder, removePlaceholder, workspaceKey } from "@/lib/placeholder-workspaces";

const start = vi.mocked(startAgentSession);
const prepare = vi.mocked(prepareAgentSession);
const activate = vi.mocked(activateAgentSession);
const cancel = vi.mocked(cancelPreparedAgentSession);
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

function Probe({ projectId, branch }: { projectId: string; branch: string }) {
  const hook = useAgentSession(projectId, branch);
  useEffect(() => { latest = hook; });
  return null;
}

let root: Root | null = null;
async function render(branch: string) {
  if (!root) root = createRoot(document.body.appendChild(document.createElement("div")));
  const r = root;
  await act(async () => { r.render(<Probe projectId="p1" branch={branch} />); });
}
async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const KEY = workspaceKey("p1", "main", null);
const view = (sessionId: string, state: "pending_first_turn" | "active" = "active") => ({
  sessionId, projectId: "p1", branch: "main", state, purpose: "interactive", leaseHeld: false,
  activationKey: "k", activationAttempt: 1, activatedAt: 1, activationErrorCode: null, userEntryIndex: 0,
  expiredReason: null, expiredAt: null, pendingExpiresAt: null,
});
const activated = (sessionId = "s-new", kind: LifecycleResponse["kind"] = "activated"): LifecycleResponse => ({
  status: 201, kind, lifecycle: view(sessionId),
  session: { id: sessionId, projectId: "p1", branch: "main", status: "running", permissionMode: "edit", agentType: "claude-code", model: null, processAlive: true },
});
const limit = (): LifecycleResponse => ({ status: 409, kind: "resident_limit", lifecycle: view("s-new", "pending_first_turn"), maxResidentAgentProcesses: 3, runningSessions: [] });

beforeEach(() => {
  window.sessionStorage.clear();
  for (const branch of ["main", "a", "b"]) removePlaceholder(workspaceKey("p1", branch, null));
  start.mockReset(); prepare.mockReset(); activate.mockReset(); cancel.mockReset();
  cancel.mockResolvedValue({ status: 200, kind: "cancelled" });
  // Auto-start: no existing session → placeholder (unless a submission is pending).
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ session: null, messages: [] }) } as unknown as Response);
});

afterEach(async () => {
  const r = root;
  if (r) await act(async () => { r.unmount(); });
  root = null;
  latest = null;
});

describe("startConversation", () => {
  it("persists the submission before the request, adopts only on activated, then clears it", async () => {
    await render("main");
    addPlaceholder(KEY);
    start.mockImplementationOnce(async (projectId, body) => {
      // The key is durable before the request goes out.
      expect(readPendingSubmission(KEY)).toMatchObject({ operationId: body.operationId, content: "hello", sessionId: null });
      expect(latest!.session).toBeNull();
      return activated();
    });
    let result: Awaited<ReturnType<HookApi["startConversation"]>> = null;
    await act(async () => { result = await latest!.startConversation("hello", "edit", null); });
    expect(start).toHaveBeenCalledWith("p1", expect.objectContaining({ branch: "main", instruction: "hello", permissionMode: "edit", force: false }));
    expect(result).toMatchObject({ session: { id: "s-new", status: "running" }, adopted: true });
    expect(latest!.session?.id).toBe("s-new");
    expect(readPendingSubmission(KEY)).toBeNull();
    expect(hasPlaceholder(KEY)).toBe(false);
  });

  it("retries the same operation with force after the eviction prompt is confirmed", async () => {
    await render("main");
    start.mockResolvedValueOnce(limit());
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => { pending = latest!.startConversation("hello"); });
    expect(latest!.residentLimitPrompt?.maxResidentAgentProcesses).toBe(3);
    const firstKey = start.mock.calls[0][1].operationId;
    expect(readPendingSubmission(KEY)?.operationId).toBe(firstKey);

    start.mockResolvedValueOnce(activated());
    await act(async () => { latest!.residentLimitPrompt!.resolve(true); });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1][1]).toMatchObject({ operationId: firstKey, force: true });
    await expect(pending).resolves.toMatchObject({ session: { id: "s-new" } });
    expect(readPendingSubmission(KEY)).toBeNull();
  });

  it("declining the prompt keeps the submission; resending the same text reuses the key", async () => {
    await render("main");
    start.mockResolvedValueOnce(limit());
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => { pending = latest!.startConversation("hello"); });
    await act(async () => { latest!.residentLimitPrompt!.resolve(false); });
    await expect(pending).resolves.toBeNull();
    const key = start.mock.calls[0][1].operationId;
    expect(readPendingSubmission(KEY)?.operationId).toBe(key);

    start.mockResolvedValueOnce(activated());
    await act(async () => { await latest!.startConversation("hello"); });
    expect(start.mock.calls[1][1].operationId).toBe(key);
    expect(latest!.session?.id).toBe("s-new");
  });

  it("a transport failure keeps the key; different text starts a new operation", async () => {
    await render("main");
    start.mockRejectedValueOnce(new Error("network down"));
    await act(async () => { expect(await latest!.startConversation("hello")).toBeNull(); });
    const key = start.mock.calls[0][1].operationId;
    expect(readPendingSubmission(KEY)?.operationId).toBe(key);
    expect(latest!.session).toBeNull();

    start.mockResolvedValueOnce(activated("s-other"));
    await act(async () => { await latest!.startConversation("something else"); });
    expect(start.mock.calls[1][1].operationId).not.toBe(key);
    expect(latest!.session?.id).toBe("s-other");
  });

  it("a terminal refusal clears the key", async () => {
    await render("main");
    start.mockResolvedValueOnce({ status: 410, kind: "expired", lifecycle: view("s-new", "pending_first_turn") });
    await act(async () => { expect(await latest!.startConversation("hello")).toBeNull(); });
    expect(readPendingSubmission(KEY)).toBeNull();
    expect(latest!.error).toBeTruthy();
  });

  it("collapses concurrent first sends: the second delivers into the first's session", async () => {
    await render("main");
    let settle!: (value: LifecycleResponse) => void;
    start.mockImplementationOnce(() => new Promise<LifecycleResponse>((resolve) => { settle = resolve; }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) } as unknown as Response);
    let p1: Promise<unknown> = Promise.resolve();
    let p2: Promise<unknown> = Promise.resolve();
    await act(async () => {
      p1 = latest!.startConversation("first");
      p2 = latest!.startConversation("second");
    });
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => { settle(activated()); });
    await expect(p1).resolves.toMatchObject({ session: { id: "s-new" } });
    await expect(p2).resolves.toMatchObject({ session: { id: "s-new" } });
    // The second content went to /message on the started session.
    const messageCalls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/api/agent-sessions/s-new/message"));
    expect(messageCalls).toHaveLength(1);
    expect(JSON.parse(String((messageCalls[0][1] as RequestInit).body))).toEqual({ content: "second" });
  });

  it("does not adopt into a workspace the user has left, but still records the session for its origin", async () => {
    await render("a");
    let settle!: (value: LifecycleResponse) => void;
    start.mockImplementationOnce(() => new Promise<LifecycleResponse>((resolve) => { settle = resolve; }));
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => { pending = latest!.startConversation("hello"); });
    await render("b");
    await act(async () => { settle({ ...activated("s-a"), session: { ...activated("s-a").session!, branch: "a" } }); });
    await expect(pending).resolves.toMatchObject({ session: { id: "s-a" }, adopted: false });
    expect(latest!.session).toBeNull();
    expect(readPendingSubmission(workspaceKey("p1", "a", null))).toBeNull();
  });
});

describe("refresh replay", () => {
  it("replays a pending submission under its key before settling on the placeholder", async () => {
    writePendingSubmission({
      workspaceKey: KEY, projectId: "p1", branch: "main", agentMode: "local",
      operationId: "op-persisted", sessionId: null, content: "hello again", permissionMode: "plan", model: "opus", createdAt: 1,
    });
    start.mockResolvedValueOnce(activated("s-replayed"));
    await render("main");
    await flush();
    expect(start).toHaveBeenCalledWith("p1", expect.objectContaining({
      operationId: "op-persisted", instruction: "hello again", permissionMode: "plan", model: "opus",
    }));
    expect(latest!.session?.id).toBe("s-replayed");
    expect(readPendingSubmission(KEY)).toBeNull();
  });

  it("replays a prepared submission through activate", async () => {
    writePendingSubmission({
      workspaceKey: KEY, projectId: "p1", branch: "main", agentMode: "local",
      operationId: "op-prepared", sessionId: "s-prepared", content: "with paste", createdAt: 1,
    });
    activate.mockResolvedValueOnce(activated("s-prepared", "replayed"));
    await render("main");
    await flush();
    expect(activate).toHaveBeenCalledWith("s-prepared", expect.objectContaining({ activationKey: "op-prepared", instruction: "with paste" }));
    expect(start).not.toHaveBeenCalled();
    expect(latest!.session?.id).toBe("s-prepared");
  });

  it("placeholder + pending across a refresh: the pending send is replayed, not blocked by the placeholder", async () => {
    // The user chose "New Conversation" (placeholder persists in localStorage),
    // sent a message, and the response was lost / the tab refreshed. Both the
    // placeholder and the submission survive the reload.
    addPlaceholder(KEY);
    writePendingSubmission({
      workspaceKey: KEY, projectId: "p1", branch: "main", agentMode: "local",
      operationId: "op-after-refresh", sessionId: null, content: "still mine", createdAt: 1,
    });
    // An older session exists on this branch: the replay must win over it.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({
      session: { id: "s-older", projectId: "p1", branch: "main", status: "stopped" }, messages: [],
    }) } as unknown as Response);
    start.mockResolvedValueOnce(activated("s-replayed"));
    await render("main");
    await flush();
    expect(start).toHaveBeenCalledWith("p1", expect.objectContaining({ operationId: "op-after-refresh", instruction: "still mine" }));
    expect(latest!.session?.id).toBe("s-replayed");
    expect(hasPlaceholder(KEY)).toBe(false);
    expect(readPendingSubmission(KEY)).toBeNull();
  });

  it("placeholder + pending: a failed replay stays on the placeholder and keeps the submission for the next send", async () => {
    addPlaceholder(KEY);
    writePendingSubmission({
      workspaceKey: KEY, projectId: "p1", branch: "main", agentMode: "local",
      operationId: "op-retry-later", sessionId: null, content: "try again", createdAt: 1,
    });
    fetchMock.mockClear();
    start.mockResolvedValueOnce({ status: 503, kind: "retryable_failure", lifecycle: view("s-x", "pending_first_turn"), error: "spawn failed" });
    await render("main");
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(latest!.session).toBeNull();
    expect(latest!.isInitialized).toBe(true);
    expect(hasPlaceholder(KEY)).toBe(true);
    expect(readPendingSubmission(KEY)).toMatchObject({ operationId: "op-retry-later" });
    // The placeholder's "latest session" lookup never ran: the user's choice stands.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/agent-sessions"))).toBe(false);
  });

  it("ignores a submission that never reached its content (prepare-only)", async () => {
    writePendingSubmission({
      workspaceKey: KEY, projectId: "p1", branch: "main", agentMode: "local",
      operationId: "op-half", sessionId: "s-half", content: null, createdAt: 1,
    });
    await render("main");
    await flush();
    expect(activate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(latest!.session).toBeNull();
  });
});

describe("prepare → activate", () => {
  it("prepares an invisible identity, activates it with the same key, and adopts on activated", async () => {
    await render("main");
    prepare.mockResolvedValueOnce({ status: 201, kind: "prepared", lifecycle: view("s-prep", "pending_first_turn") });
    const out: { prepared: Awaited<ReturnType<HookApi["prepareConversation"]>> } = { prepared: null };
    await act(async () => { out.prepared = await latest!.prepareConversation("edit", null); });
    const prepared = out.prepared!;
    expect(prepared).toMatchObject({ sessionId: "s-prep", legacy: false });
    expect(prepare).toHaveBeenCalledWith("p1", expect.objectContaining({ operationId: prepared.operationId, purpose: "interactive_upload" }));
    expect(latest!.session).toBeNull();
    expect(readPendingSubmission(KEY)).toMatchObject({ operationId: prepared.operationId, sessionId: "s-prep", content: null });

    activate.mockResolvedValueOnce(activated("s-prep"));
    await act(async () => { await latest!.activateConversation(prepared, "<vpaste path=x />"); });
    expect(activate).toHaveBeenCalledWith("s-prep", { activationKey: prepared.operationId, instruction: "<vpaste path=x />", force: false });
    expect(latest!.session?.id).toBe("s-prep");
    expect(readPendingSubmission(KEY)).toBeNull();
  });

  it("cancel tombstones the identity and forgets the submission", async () => {
    await render("main");
    prepare.mockResolvedValueOnce({ status: 201, kind: "prepared", lifecycle: view("s-prep", "pending_first_turn") });
    const out: { prepared: Awaited<ReturnType<HookApi["prepareConversation"]>> } = { prepared: null };
    await act(async () => { out.prepared = await latest!.prepareConversation(); });
    await act(async () => { await latest!.cancelPreparedConversation(out.prepared!); });
    expect(cancel).toHaveBeenCalledWith("s-prep");
    expect(readPendingSubmission(KEY)).toBeNull();
  });

  it("a prepare that hits a tombstone starts a fresh operation", async () => {
    await render("main");
    writePendingSubmission({
      workspaceKey: KEY, projectId: "p1", branch: "main", agentMode: "local",
      operationId: "op-old", sessionId: "s-old", content: null, createdAt: 1,
    });
    prepare
      .mockResolvedValueOnce({ status: 410, kind: "expired", lifecycle: { ...view("s-old", "pending_first_turn"), state: "expired" } })
      .mockResolvedValueOnce({ status: 201, kind: "prepared", lifecycle: view("s-fresh", "pending_first_turn") });
    const out: { prepared: Awaited<ReturnType<HookApi["prepareConversation"]>> } = { prepared: null };
    await act(async () => { out.prepared = await latest!.prepareConversation(); });
    expect(prepare.mock.calls[0][1].operationId).toBe("op-old");
    expect(prepare.mock.calls[1][1].operationId).not.toBe("op-old");
    expect(out.prepared?.sessionId).toBe("s-fresh");
  });
});
