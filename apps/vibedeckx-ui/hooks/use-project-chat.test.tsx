// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    listProjectChatThreads: vi.fn(), createProjectChatThread: vi.fn(), getProjectChatThread: vi.fn(),
    updateProjectChatThread: vi.fn(), deleteProjectChatThread: vi.fn(),
    sendProjectChatMessage: vi.fn(), stopProjectChatTurn: vi.fn(), approveProjectChatTool: vi.fn(),
    selectProjectChatWorkspace: vi.fn(),
    listProjectChatMessages: vi.fn(),
  },
  getFreshToken: vi.fn(),
  getWebSocketUrl: vi.fn((path: string) => `ws://example.test${path}`),
}));
vi.mock("@/lib/api", () => mocks);

import { useProjectChat, type UseProjectChatResult } from "./use-project-chat";
import type { ProjectChatSnapshot, ProjectChatThread, ProjectChatThreadDetail } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const thread = (id: string, projectId = "p1", title: string | null = id): ProjectChatThread => ({
  id, project_id: projectId, user_id: "user", title,
  created_at: "2026-07-31 00:00:00", updated_at: "2026-07-31 00:00:00", archived_at: null,
});

const detail = (id: string, projectId = "p1", title: string | null = id): ProjectChatThreadDetail => ({
  thread: thread(id, projectId, title), contextRefs: [],
});

const snapshot = (id: string, projectId = "p1"): ProjectChatSnapshot => ({
  identity: { projectId, threadId: id, userId: "user" },
  thread: thread(id, projectId),
  messages: [{
    id: "m1", thread_id: id, sequence: 1, type: "user", content: "hello",
    created_at: "2026-07-31 00:00:00",
  }],
  hasEarlierMessages: false,
  earliestSequence: 1,
  status: "idle",
  activeTurnId: null,
  queueLength: 0,
  contextRefs: [],
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static constructionFailures = 0;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn(() => { this.readyState = FakeWebSocket.CLOSED; });

  constructor(url: string | URL) {
    if (FakeWebSocket.constructionFailures > 0) {
      FakeWebSocket.constructionFailures -= 1;
      throw new Error("socket construction failed");
    }
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(value: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  disconnect() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  error() {
    this.onerror?.(new Event("error"));
  }
}

let root: Root;
let container: HTMLDivElement;
let latest: UseProjectChatResult;

function Probe({ projectId, threadId }: { projectId: string | null; threadId: string | null }) {
  const value = useProjectChat(projectId, threadId);
  useEffect(() => { latest = value; }, [value]);
  return null;
}

function render(projectId: string | null, threadId: string | null) {
  act(() => root.render(<Probe projectId={projectId} threadId={threadId} />));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakeWebSocket.instances = [];
  FakeWebSocket.constructionFailures = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  window.sessionStorage.clear();
  mocks.getFreshToken.mockResolvedValue("token");
  mocks.api.listProjectChatThreads.mockResolvedValue([]);
  mocks.api.getProjectChatThread.mockImplementation(async (id: string) => detail(id));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useProjectChat", () => {
  it("lists, creates, opens, renames, archives, and deletes threads using project-chat routes", async () => {
    const first = thread("t1");
    const created = thread("t2", "p1", null);
    mocks.api.listProjectChatThreads.mockResolvedValue([first]);
    mocks.api.createProjectChatThread.mockResolvedValue(created);
    mocks.api.updateProjectChatThread
      .mockResolvedValueOnce({ ...created, title: "Renamed" })
      .mockResolvedValueOnce({ ...created, title: "Renamed", archived_at: 1 });
    mocks.api.deleteProjectChatThread.mockResolvedValue(undefined);

    render("p1", null);
    await flush();
    expect(mocks.api.listProjectChatThreads).toHaveBeenCalledWith(
      "p1", false, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(latest.threads).toEqual([first]);

    await act(async () => { await latest.createThread("first question"); });
    expect(mocks.api.createProjectChatThread).toHaveBeenCalledWith(
      "p1", "first question", expect.any(String),
    );
    // The existing create route owns initial-message persistence; the hook must
    // not duplicate it through the separate enqueue endpoint.
    expect(mocks.api.sendProjectChatMessage).not.toHaveBeenCalled();
    expect(latest.threads[0].id).toBe("t2");

    await act(async () => { await latest.renameThread("t2", "Renamed"); });
    expect(mocks.api.updateProjectChatThread).toHaveBeenCalledWith("t2", { title: "Renamed" });
    await act(async () => { await latest.archiveThread("t2"); });
    expect(mocks.api.updateProjectChatThread).toHaveBeenCalledWith("t2", { archived: true });
    expect(latest.threads.some((item) => item.id === "t2")).toBe(false);

    await act(async () => { await latest.deleteThread("t1"); });
    expect(mocks.api.deleteProjectChatThread).toHaveBeenCalledWith("t1");
    expect(latest.threads).toEqual([]);

    render("p1", "t1");
    await flush();
    expect(mocks.api.getProjectChatThread).toHaveBeenCalledWith(
      "t1", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(FakeWebSocket.instances[0].url).toContain("/api/project-chat/threads/t1/stream");
    expect(mocks.getWebSocketUrl).not.toHaveBeenCalledWith(expect.stringContaining("/chat-sessions/"));
  });

  it("sends the exact pending request and offered workspace identities", async () => {
    render("p1", "t1");
    await flush();
    mocks.api.selectProjectChatWorkspace.mockResolvedValue({ status: "resolving" });

    await act(async () => latest.selectWorkspace("request-1", '["remote-1","dev"]'));

    expect(mocks.api.selectProjectChatWorkspace)
      .toHaveBeenCalledWith("t1", "request-1", '["remote-1","dev"]');
  });

  it("reuses one create request id after a lost response and hook remount, then rotates after success", async () => {
    const created = thread("created", "p1", null);
    mocks.api.createProjectChatThread
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce(thread("next", "p1", null));
    render("p1", null);
    await flush();

    await expect(latest.createThread("same intent")).rejects.toThrow("response lost");
    act(() => root.unmount());
    root = createRoot(container);
    render("p1", null);
    await flush();
    await act(async () => { await latest.createThread("same intent"); });
    await act(async () => { await latest.createThread("same intent"); });

    const keys = mocks.api.createProjectChatThread.mock.calls.map((call) => call[2]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(Array.from({ length: window.sessionStorage.length }, (_, index) => [
      window.sessionStorage.key(index),
      window.sessionStorage.getItem(window.sessionStorage.key(index)!),
    ]).flat().join(" ")).not.toContain("same intent");
  });

  it("isolates pending create ids by project and rotates after a deterministic conflict", async () => {
    const conflict = Object.assign(new Error("payload mismatch"), { status: 409 });
    mocks.api.createProjectChatThread
      .mockRejectedValueOnce(new Error("p1 response lost"))
      .mockRejectedValueOnce(new Error("p2 response lost"))
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(thread("created", "p1", null));
    render("p1", null);
    await flush();
    await expect(latest.createThread("same")).rejects.toThrow("p1 response lost");
    render("p2", null);
    await flush();
    await expect(latest.createThread("same")).rejects.toThrow("p2 response lost");
    render("p1", null);
    await flush();
    await expect(latest.createThread("same")).rejects.toMatchObject({ status: 409 });
    await act(async () => { await latest.createThread("same"); });

    const keys = mocks.api.createProjectChatThread.mock.calls.map((call) => call[2]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[2]);
  });

  it("rehydrates from the WebSocket snapshot and applies JSON patches", async () => {
    render("p1", "t1");
    await flush();
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.message({ type: "project_chat_snapshot", snapshot: {
        ...snapshot("t1"),
        contextRefs: [{
          thread_id: "t1", entity_type: "task", entity_id: "task-1",
          last_referenced_at: "2026-07-31 00:00:00", deleted: false,
          navigation: { kind: "task", taskId: "task-1", label: "Task one" },
        }],
      } });
    });
    expect(latest).toMatchObject({ isConnected: true, status: "idle", queueLength: 0 });
    expect(latest.messages.map((message) => message.content)).toEqual(["hello"]);
    expect(latest.contextRefs).toEqual([
      expect.objectContaining({ entity_id: "task-1", deleted: false }),
    ]);

    const assistant = {
      id: "m2", thread_id: "t1", sequence: 2, type: "assistant" as const, content: "world",
      created_at: "2026-07-31 00:00:01",
    };
    act(() => socket.message({ JsonPatch: [
      { op: "add", path: "/messages/1", value: { type: "ENTRY", content: assistant } },
      { op: "replace", path: "/status", value: { type: "STATUS", content: "running" } },
      { op: "replace", path: "/activeTurnId", value: { type: "ACTIVE_TURN", content: "turn-1" } },
      { op: "replace", path: "/queueLength", value: { type: "QUEUE", content: 2 } },
      { op: "replace", path: "/contextRefs", value: { type: "CONTEXT", content: [{
        thread_id: "t1", entity_type: "schedule", entity_id: "schedule-1",
        last_referenced_at: "2026-07-31 00:00:01", deleted: false,
        navigation: { kind: "schedule", scheduleId: "schedule-1", label: "Schedule one" },
      }] } },
    ] }));
    expect(latest.messages).toEqual([snapshot("t1").messages[0], assistant]);
    expect(latest).toMatchObject({ status: "running", activeTurnId: "turn-1", queueLength: 2 });
    expect(latest.contextRefs).toEqual([
      expect.objectContaining({ entity_type: "schedule", entity_id: "schedule-1" }),
    ]);
  });

  it("closes the old socket and reconnects with isolated state when the thread changes", async () => {
    render("p1", "t1");
    await flush();
    const first = FakeWebSocket.instances[0];
    act(() => first.message({ type: "project_chat_snapshot", snapshot: snapshot("t1") }));

    render("p1", "t2");
    await flush();
    expect(first.close).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toContain("/t2/stream");
    expect(latest.thread?.id).toBe("t2");
    expect(latest.messages).toEqual([]);
    expect(latest.contextRefs).toEqual([]);

    act(() => first.message({ type: "project_chat_snapshot", snapshot: snapshot("t1") }));
    expect(latest.thread?.id).toBe("t2");
    expect(latest.messages).toEqual([]);
    expect(latest.contextRefs).toEqual([]);
  });

  it("sends and stops turns only for the selected thread and observed turn identity", async () => {
    mocks.api.sendProjectChatMessage.mockResolvedValue(undefined);
    mocks.api.stopProjectChatTurn.mockResolvedValue(true);
    render("p1", "t1");
    await flush();

    await act(async () => { await latest.sendMessage("  do it  "); });
    expect(mocks.api.sendProjectChatMessage).toHaveBeenCalledWith("t1", "do it");
    await act(async () => { await latest.stopTurn("turn-1"); });
    expect(mocks.api.stopProjectChatTurn).toHaveBeenCalledWith("t1", "turn-1");
  });

  it("rejects a snapshot whose thread or project identity does not match the selection", async () => {
    render("p1", "t1");
    await flush();
    const socket = FakeWebSocket.instances[0];
    act(() => socket.message({ type: "project_chat_snapshot", snapshot: snapshot("t1", "other") }));
    expect(latest.messages).toEqual([]);
    expect(latest.error).toBe("Project Chat stream identity mismatch");
  });

  it.each([
    ["cross-thread Context ref", (valid: ProjectChatSnapshot): ProjectChatSnapshot => ({
      ...valid,
      contextRefs: [{
        thread_id: "other-thread", entity_type: "task", entity_id: "private-task",
        last_referenced_at: "2026-07-31 00:00:01", deleted: false,
        navigation: { kind: "task", taskId: "private-task", label: "Private" },
      }],
    })],
    ["cross-thread message", (valid: ProjectChatSnapshot): ProjectChatSnapshot => ({
      ...valid,
      messages: valid.messages.map((message) => ({ ...message, thread_id: "other-thread" })),
    })],
    ["identity user mismatch", (valid: ProjectChatSnapshot): ProjectChatSnapshot => ({
      ...valid,
      identity: { ...valid.identity, userId: "other-user" },
    })],
  ] as const)("rejects a %s snapshot without contaminating current or cached state", async (_label, corrupt) => {
    const valid = {
      ...snapshot("t1"),
      contextRefs: [{
        thread_id: "t1", entity_type: "task" as const, entity_id: "task-1",
        last_referenced_at: "2026-07-31 00:00:00", deleted: false,
        navigation: { kind: "task" as const, taskId: "task-1", label: "Task one" },
      }],
    };
    mocks.api.getProjectChatThread.mockResolvedValue({
      thread: valid.thread, contextRefs: valid.contextRefs,
    });
    render("p1", "t1");
    await flush();
    const socket = FakeWebSocket.instances[0];
    act(() => socket.message({ type: "project_chat_snapshot", snapshot: valid }));

    act(() => socket.message({ type: "project_chat_snapshot", snapshot: corrupt(valid) }));

    expect(latest.messages).toEqual(valid.messages);
    expect(latest.contextRefs).toEqual(valid.contextRefs);
    expect(latest.thread).toEqual(valid.thread);
    expect(latest.error).toBe("Invalid Project Chat stream message");
    expect(socket.close).toHaveBeenCalledOnce();

    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    // The reconnect keeps rendering only the last validated cache entry until
    // the replacement socket supplies an authoritative snapshot.
    expect(latest.messages).toEqual(valid.messages);
    expect(latest.contextRefs).toEqual(valid.contextRefs);

    const authoritative = {
      ...snapshot("t1"),
      messages: [{ ...snapshot("t1").messages[0], content: "authoritative" }],
    };
    act(() => FakeWebSocket.instances[1].message({
      type: "project_chat_snapshot", snapshot: authoritative,
    }));
    expect(latest.messages[0].content).toBe("authoritative");
    expect(latest.contextRefs).toEqual([]);
  });

  it("rejects a self-consistent foreign-user snapshot against the REST-owned Thread", async () => {
    const owned = { ...detail("t1").thread, user_id: "owned-user" };
    mocks.api.getProjectChatThread.mockResolvedValue({ thread: owned, contextRefs: [] });
    render("p1", "t1");
    await flush();
    const socket = FakeWebSocket.instances[0];
    const foreign = snapshot("t1");
    foreign.thread = { ...foreign.thread, user_id: "foreign-user" };
    foreign.identity = { ...foreign.identity, userId: "foreign-user" };

    act(() => socket.message({ type: "project_chat_snapshot", snapshot: foreign }));

    expect(latest.thread).toEqual(owned);
    expect(latest.messages).toEqual([]);
    expect(latest.error).toBe("Project Chat stream identity mismatch");
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("does not let a late thread-list success clear a stream identity error", async () => {
    const list = deferred<ProjectChatThread[]>();
    mocks.api.listProjectChatThreads.mockReturnValue(list.promise);
    render("p1", "t1");
    await flush();
    act(() => FakeWebSocket.instances[0].message({
      type: "project_chat_snapshot",
      snapshot: snapshot("t1", "other"),
    }));
    expect(latest.error).toBe("Project Chat stream identity mismatch");

    await act(async () => list.resolve([]));
    expect(latest.error).toBe("Project Chat stream identity mismatch");
  });

  it("keeps the newest same-project thread-list mode when an older request resolves last", async () => {
    const activeOnly = deferred<ProjectChatThread[]>();
    const withArchived = deferred<ProjectChatThread[]>();
    mocks.api.listProjectChatThreads
      .mockReturnValueOnce(activeOnly.promise)
      .mockReturnValueOnce(withArchived.promise);
    render("p1", null);

    let refetch!: Promise<void>;
    act(() => { refetch = latest.refetchThreads(true); });
    await act(async () => withArchived.resolve([
      thread("active"),
      { ...thread("archived"), archived_at: 1 },
    ]));
    await refetch;
    expect(latest.threads.map((item) => item.id)).toEqual(["active", "archived"]);

    await act(async () => activeOnly.resolve([thread("stale-active")]));
    expect(latest.threads.map((item) => item.id)).toEqual(["active", "archived"]);
    expect(mocks.api.listProjectChatThreads).toHaveBeenNthCalledWith(
      2, "p1", true, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("does not let a list started before create overwrite the created Thread", async () => {
    const staleList = deferred<ProjectChatThread[]>();
    const created = thread("created");
    mocks.api.listProjectChatThreads.mockReturnValue(staleList.promise);
    mocks.api.createProjectChatThread.mockResolvedValue(created);
    render("p1", null);
    await flush();
    const listSignal = mocks.api.listProjectChatThreads.mock.calls[0][2].signal as AbortSignal;

    await act(async () => { await latest.createThread(); });
    expect(listSignal.aborted).toBe(true);
    expect(latest.threads).toEqual([created]);

    await act(async () => staleList.resolve([]));
    expect(latest.threads).toEqual([created]);
  });

  it("does not let a list started before rename overwrite the renamed Thread", async () => {
    const staleList = deferred<ProjectChatThread[]>();
    const renamed = thread("t1", "p1", "new title");
    mocks.api.listProjectChatThreads.mockReturnValue(staleList.promise);
    mocks.api.updateProjectChatThread.mockResolvedValue(renamed);
    render("p1", null);
    await flush();
    const listSignal = mocks.api.listProjectChatThreads.mock.calls[0][2].signal as AbortSignal;

    await act(async () => { await latest.renameThread("t1", "new title"); });
    expect(listSignal.aborted).toBe(true);
    expect(latest.threads).toEqual([renamed]);

    await act(async () => staleList.resolve([thread("t1", "p1", "old title")]));
    expect(latest.threads).toEqual([renamed]);
  });

  it("keeps the latest rename intent when responses arrive in reverse order", async () => {
    const first = deferred<ProjectChatThread>();
    const second = deferred<ProjectChatThread>();
    mocks.api.listProjectChatThreads.mockResolvedValue([thread("t1", "p1", "original")]);
    mocks.api.updateProjectChatThread
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render("p1", null);
    await flush();

    let firstPromise!: Promise<ProjectChatThread>;
    let secondPromise!: Promise<ProjectChatThread>;
    act(() => {
      firstPromise = latest.renameThread("t1", "first");
      secondPromise = latest.renameThread("t1", "second");
    });
    await act(async () => second.resolve(thread("t1", "p1", "second")));
    await secondPromise;
    expect(latest.threads[0].title).toBe("second");

    await act(async () => first.resolve(thread("t1", "p1", "first")));
    await firstPromise;
    expect(latest.threads[0].title).toBe("second");
  });

  it("keeps the latest archive intent when responses arrive in reverse order", async () => {
    const archive = deferred<ProjectChatThread>();
    const unarchive = deferred<ProjectChatThread>();
    mocks.api.listProjectChatThreads.mockResolvedValue([thread("t1")]);
    mocks.api.updateProjectChatThread
      .mockReturnValueOnce(archive.promise)
      .mockReturnValueOnce(unarchive.promise);
    render("p1", null);
    await flush();

    let archivePromise!: Promise<ProjectChatThread>;
    let unarchivePromise!: Promise<ProjectChatThread>;
    act(() => {
      archivePromise = latest.archiveThread("t1", true);
      unarchivePromise = latest.archiveThread("t1", false);
    });
    await act(async () => unarchive.resolve(thread("t1")));
    await unarchivePromise;
    expect(latest.threads.map((item) => item.id)).toEqual(["t1"]);

    await act(async () => archive.resolve({ ...thread("t1"), archived_at: 1 }));
    await archivePromise;
    expect(latest.threads.map((item) => item.id)).toEqual(["t1"]);
  });

  it("keeps backing off after reconnect preflight and socket-construction failures until it succeeds", async () => {
    render("p1", "t1");
    await flush();
    const first = FakeWebSocket.instances[0];
    act(() => first.open());
    mocks.api.getProjectChatThread
      .mockRejectedValueOnce(new Error("preflight unavailable"))
      .mockResolvedValue(detail("t1"));
    FakeWebSocket.constructionFailures = 1;

    act(() => first.disconnect());
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    expect(mocks.api.getProjectChatThread).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1_999));
    expect(mocks.api.getProjectChatThread).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    expect(mocks.api.getProjectChatThread).toHaveBeenCalledTimes(3);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => { vi.advanceTimersByTime(4_000); await Promise.resolve(); });
    expect(mocks.api.getProjectChatThread).toHaveBeenCalledTimes(4);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toContain("/t1/stream");
  });

  it("resets reconnect backoff only after a valid snapshot, not merely on open", async () => {
    render("p1", "t1");
    await flush();
    const first = FakeWebSocket.instances[0];
    act(() => {
      first.open();
      first.message({ type: "project_chat_snapshot", snapshot: snapshot("t1") });
      first.disconnect();
    });
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    const second = FakeWebSocket.instances[1];
    act(() => {
      second.open();
      second.disconnect();
      vi.advanceTimersByTime(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("times out a connection that never receives its initial snapshot and retries", async () => {
    render("p1", "t1");
    await flush();
    const first = FakeWebSocket.instances[0];
    act(() => first.open());

    act(() => vi.advanceTimersByTime(10_000));
    expect(first.close).toHaveBeenCalledOnce();
    expect(latest.error).toBe("Project Chat connection timed out");
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("times out and aborts a hung REST preflight before retrying", async () => {
    const firstPreflight = deferred<ProjectChatThreadDetail>();
    let firstSignal!: AbortSignal;
    mocks.api.getProjectChatThread
      .mockImplementationOnce((_id: string, opts: { signal: AbortSignal }) => {
        firstSignal = opts.signal;
        return firstPreflight.promise;
      })
      .mockResolvedValue(detail("t1"));
    render("p1", "t1");
    await flush();

    act(() => vi.advanceTimersByTime(10_000));
    expect(firstSignal.aborted).toBe(true);
    expect(latest.error).toBe("Project Chat connection timed out");
    await act(async () => firstPreflight.resolve(detail("t1")));
    expect(FakeWebSocket.instances).toHaveLength(0);

    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    expect(mocks.api.getProjectChatThread).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("ignores a token promise that resolves after its connect attempt timed out", async () => {
    const staleToken = deferred<string>();
    mocks.getFreshToken
      .mockReturnValueOnce(staleToken.promise)
      .mockResolvedValue("fresh-token");
    render("p1", "t1");
    await flush();

    act(() => vi.advanceTimersByTime(10_000));
    await act(async () => staleToken.resolve("stale-token"));
    expect(FakeWebSocket.instances).toHaveLength(0);

    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(mocks.getWebSocketUrl).toHaveBeenLastCalledWith(
      "/api/project-chat/threads/t1/stream", "fresh-token",
    );
  });

  it("aborts a hung connect attempt and starts one fresh attempt when coming online", async () => {
    const stalePreflight = deferred<ProjectChatThreadDetail>();
    let staleSignal!: AbortSignal;
    mocks.api.getProjectChatThread
      .mockImplementationOnce((_id: string, opts: { signal: AbortSignal }) => {
        staleSignal = opts.signal;
        return stalePreflight.promise;
      })
      .mockResolvedValue(detail("t1"));
    render("p1", "t1");
    await flush();

    act(() => window.dispatchEvent(new Event("online")));
    await flush();
    expect(staleSignal.aborted).toBe(true);
    expect(mocks.api.getProjectChatThread).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => stalePreflight.resolve(detail("t1")));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("treats Thread not found as terminal and never reconnects", async () => {
    render("p1", "t1");
    await flush();
    const socket = FakeWebSocket.instances[0];
    act(() => socket.message({ error: "Thread not found" }));

    expect(socket.close).toHaveBeenCalledOnce();
    expect((latest as UseProjectChatResult & { terminalError: string | null }).terminalError)
      .toBe("thread_not_found");
    expect(latest.error).toBe("Thread not found");
    await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects when the server reports a retryable Project Chat open failure", async () => {
    render("p1", "t1");
    await flush();
    const socket = FakeWebSocket.instances[0];
    act(() => socket.message({ error: "Project Chat temporarily unavailable" }));

    expect(latest.terminalError).toBeNull();
    expect(latest.error).toBe("Project Chat temporarily unavailable");
    expect(socket.close).toHaveBeenCalledOnce();
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not retry a REST 404 while opening a Thread", async () => {
    mocks.api.getProjectChatThread.mockRejectedValue(
      Object.assign(new Error("Thread not found"), { status: 404 }),
    );
    render("p1", "missing");
    await flush();
    expect((latest as UseProjectChatResult & { terminalError: string | null }).terminalError)
      .toBe("thread_not_found");
    await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
    expect(mocks.api.getProjectChatThread).toHaveBeenCalledTimes(1);
  });

  it("recovers a stale open socket when the page becomes visible and removes listeners on cleanup", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render("p1", "t1");
    await flush();
    const first = FakeWebSocket.instances[0];
    act(() => {
      first.open();
      first.message({ type: "project_chat_snapshot", snapshot: snapshot("t1") });
      vi.advanceTimersByTime(40_001);
    });

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(first.close).toHaveBeenCalledOnce();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => root.unmount());
    act(() => window.dispatchEvent(new Event("online")));
    await act(async () => { vi.runOnlyPendingTimers(); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    visibility.mockRestore();
  });

  it("cancels pending reconnects on a thread switch and on unmount", async () => {
    render("p1", "t1");
    await flush();
    act(() => FakeWebSocket.instances[0].disconnect());

    render("p1", "t2");
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1].message({
      type: "project_chat_snapshot", snapshot: snapshot("t2"),
    }));
    act(() => vi.advanceTimersByTime(30_000));
    expect(mocks.api.getProjectChatThread.mock.calls.filter(([id]) => id === "t1")).toHaveLength(1);

    act(() => FakeWebSocket.instances[1].disconnect());
    act(() => root.unmount());
    act(() => vi.advanceTimersByTime(30_000));
    expect(mocks.api.getProjectChatThread.mock.calls.filter(([id]) => id === "t2")).toHaveLength(1);
  });

  it("does not let a late close from a replaced socket schedule a duplicate attempt", async () => {
    render("p1", "t1");
    await flush();
    const first = FakeWebSocket.instances[0];
    act(() => first.error());
    expect(first.close).toHaveBeenCalledOnce();
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => {
      FakeWebSocket.instances[1].open();
      FakeWebSocket.instances[1].message({
        type: "project_chat_snapshot", snapshot: snapshot("t1"),
      });
      first.disconnect();
    });
    await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("ignores a rename response that arrives after switching projects", async () => {
    const renamed = deferred<ProjectChatThread>();
    mocks.api.listProjectChatThreads.mockImplementation(async (projectId: string) => [thread(
      projectId === "p1" ? "a" : "b", projectId,
    )]);
    mocks.api.updateProjectChatThread.mockReturnValue(renamed.promise);
    render("p1", null);
    await flush();

    let renamePromise!: Promise<ProjectChatThread>;
    act(() => { renamePromise = latest.renameThread("a", "renamed"); });
    render("p2", null);
    await flush();
    await act(async () => renamed.resolve(thread("a", "p1", "renamed")));
    await renamePromise;

    expect(latest.threads.map((item) => item.id)).toEqual(["b"]);
  });

  it("ignores an unarchive response from archiveThread that arrives after switching projects", async () => {
    const archived = deferred<ProjectChatThread>();
    mocks.api.listProjectChatThreads.mockImplementation(async (projectId: string) => [thread(
      projectId === "p1" ? "a" : "b", projectId,
    )]);
    mocks.api.updateProjectChatThread.mockReturnValue(archived.promise);
    render("p1", null);
    await flush();

    let archivePromise!: Promise<ProjectChatThread>;
    act(() => { archivePromise = latest.archiveThread("a", false); });
    render("p2", null);
    await flush();
    await act(async () => archived.resolve(thread("a", "p1")));
    await archivePromise;

    expect(latest.threads.map((item) => item.id)).toEqual(["b"]);
  });

  it("does not apply a late delete response to the newly selected project", async () => {
    const deleted = deferred<void>();
    mocks.api.listProjectChatThreads.mockImplementation(async (projectId: string) => [
      thread("same-visible-id", projectId),
    ]);
    mocks.api.deleteProjectChatThread.mockReturnValue(deleted.promise);
    render("p1", null);
    await flush();

    let deletePromise!: Promise<void>;
    act(() => { deletePromise = latest.deleteThread("same-visible-id"); });
    render("p2", null);
    await flush();
    await act(async () => deleted.resolve(undefined));
    await deletePromise;

    expect(latest.threads).toEqual([thread("same-visible-id", "p2")]);
  });

  it("clears cached snapshots from other projects", async () => {
    mocks.api.getProjectChatThread.mockImplementation(async (id: string) =>
      detail(id, id === "p2-thread" ? "p2" : "p1"));
    render("p1", "p1-thread");
    await flush();
    act(() => FakeWebSocket.instances.at(-1)?.message({
      type: "project_chat_snapshot", snapshot: snapshot("p1-thread", "p1"),
    }));
    expect(latest.messages).toHaveLength(1);

    render("p2", "p2-thread");
    await flush();
    render("p1", "p1-thread");
    await flush();
    expect(latest.messages).toEqual([]);
  });

  it("bounds the per-project snapshot cache with LRU eviction", async () => {
    for (let index = 1; index <= 6; index += 1) {
      render("p1", `t${index}`);
      await flush();
      act(() => FakeWebSocket.instances.at(-1)?.message({
        type: "project_chat_snapshot", snapshot: snapshot(`t${index}`),
      }));
    }
    render("p1", "t1");
    await flush();
    expect(latest.messages).toEqual([]);
  });

  it("reconnects for an authoritative snapshot after an invalid patch", async () => {
    render("p1", "t1");
    await flush();
    const socket = FakeWebSocket.instances[0];
    act(() => socket.message({ type: "project_chat_snapshot", snapshot: snapshot("t1") }));
    const duplicate = snapshot("t1").messages[0];
    const extra = { ...duplicate, id: "m2", sequence: 2, content: "extra" };

    act(() => socket.message({ JsonPatch: [
      { op: "add", path: "/messages/1junk", value: { type: "ENTRY", content: extra } },
      { op: "add", path: "/messages/99", value: { type: "ENTRY", content: extra } },
      { op: "add", path: "/messages/1", value: { type: "ENTRY", content: duplicate } },
      { op: "replace", path: "/status", value: { type: "STATUS", content: "unknown" } },
      { op: "replace", path: "/queueLength", value: { type: "QUEUE", content: -1 } },
    ] }));
    expect(latest.messages).toEqual([duplicate]);
    expect(latest).toMatchObject({ status: "idle", queueLength: 0 });
    expect(latest.error).toBe("Invalid Project Chat stream message");
    expect(socket.close).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(999));
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(2);

    const replacement = FakeWebSocket.instances[1];
    act(() => {
      replacement.message({ type: "project_chat_snapshot", snapshot: snapshot("t1") });
      replacement.message({ JsonPatch: "not-an-array" });
    });
    expect(replacement.close).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(999));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("loads earlier messages by sequence cursor and merges without duplicates", async () => {
    const recent = snapshot("t1");
    recent.messages = [
      { ...recent.messages[0], id: "m3", sequence: 3, content: "recent" },
      { ...recent.messages[0], id: "m4", sequence: 4, content: "latest" },
    ];
    recent.hasEarlierMessages = true;
    recent.earliestSequence = 3;
    mocks.api.listProjectChatMessages.mockResolvedValue({
      messages: [
        { ...recent.messages[0], id: "m1", sequence: 1, content: "oldest" },
        { ...recent.messages[0], id: "m3", sequence: 3, content: "recent" },
      ],
      hasMore: false,
      nextCursor: null,
    });
    render("p1", "t1");
    await flush();
    act(() => FakeWebSocket.instances[0].message({ type: "project_chat_snapshot", snapshot: recent }));

    await act(async () => { await latest.loadEarlierMessages(); });
    expect(mocks.api.listProjectChatMessages).toHaveBeenCalledWith("t1", { beforeSequence: 3 });
    expect(latest.messages.map(({ sequence }) => sequence)).toEqual([1, 3, 4]);
    expect(latest.hasEarlierMessages).toBe(false);
  });
});
