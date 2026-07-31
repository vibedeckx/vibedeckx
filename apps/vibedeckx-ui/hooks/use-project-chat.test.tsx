// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: {
    listProjectChatThreads: vi.fn(), createProjectChatThread: vi.fn(), getProjectChatThread: vi.fn(),
    updateProjectChatThread: vi.fn(), deleteProjectChatThread: vi.fn(),
    sendProjectChatMessage: vi.fn(), stopProjectChatTurn: vi.fn(), approveProjectChatTool: vi.fn(),
  },
  getFreshToken: vi.fn(),
  getWebSocketUrl: vi.fn((path: string) => `ws://example.test${path}`),
}));
vi.mock("@/lib/api", () => mocks);

import { useProjectChat, type UseProjectChatResult } from "./use-project-chat";
import type { ProjectChatSnapshot, ProjectChatThread } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const thread = (id: string, projectId = "p1", title: string | null = id): ProjectChatThread => ({
  id, project_id: projectId, user_id: "user", title,
  created_at: "2026-07-31 00:00:00", updated_at: "2026-07-31 00:00:00", archived_at: null,
});

const snapshot = (id: string, projectId = "p1"): ProjectChatSnapshot => ({
  identity: { projectId, threadId: id, userId: "user" },
  thread: thread(id, projectId),
  messages: [{
    id: "m1", thread_id: id, sequence: 1, type: "user", content: "hello",
    created_at: "2026-07-31 00:00:00",
  }],
  status: "idle",
  queueLength: 0,
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

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn(() => { this.readyState = FakeWebSocket.CLOSED; });

  constructor(url: string | URL) {
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
  vi.stubGlobal("WebSocket", FakeWebSocket);
  mocks.getFreshToken.mockResolvedValue("token");
  mocks.api.listProjectChatThreads.mockResolvedValue([]);
  mocks.api.getProjectChatThread.mockImplementation(async (id: string) => thread(id));
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
    expect(mocks.api.listProjectChatThreads).toHaveBeenCalledWith("p1", false);
    expect(latest.threads).toEqual([first]);

    await act(async () => { await latest.createThread("first question"); });
    expect(mocks.api.createProjectChatThread).toHaveBeenCalledWith("p1", "first question");
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
    expect(mocks.api.getProjectChatThread).toHaveBeenCalledWith("t1");
    expect(FakeWebSocket.instances[0].url).toContain("/api/project-chat/threads/t1/stream");
    expect(mocks.getWebSocketUrl).not.toHaveBeenCalledWith(expect.stringContaining("/chat-sessions/"));
  });

  it("rehydrates from the WebSocket snapshot and applies JSON patches", async () => {
    render("p1", "t1");
    await flush();
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.open();
      socket.message({ type: "project_chat_snapshot", snapshot: snapshot("t1") });
    });
    expect(latest).toMatchObject({ isConnected: true, status: "idle", queueLength: 0 });
    expect(latest.messages.map((message) => message.content)).toEqual(["hello"]);

    const assistant = {
      id: "m2", thread_id: "t1", sequence: 2, type: "assistant" as const, content: "world",
      created_at: "2026-07-31 00:00:01",
    };
    act(() => socket.message({ JsonPatch: [
      { op: "add", path: "/messages/1", value: { type: "ENTRY", content: assistant } },
      { op: "replace", path: "/status", value: { type: "STATUS", content: "running" } },
      { op: "replace", path: "/queueLength", value: { type: "QUEUE", content: 2 } },
    ] }));
    expect(latest.messages).toEqual([snapshot("t1").messages[0], assistant]);
    expect(latest).toMatchObject({ status: "running", queueLength: 2 });
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

    act(() => first.message({ type: "project_chat_snapshot", snapshot: snapshot("t1") }));
    expect(latest.thread?.id).toBe("t2");
    expect(latest.messages).toEqual([]);
  });

  it("sends and stops turns only for the selected thread", async () => {
    mocks.api.sendProjectChatMessage.mockResolvedValue(undefined);
    mocks.api.stopProjectChatTurn.mockResolvedValue(true);
    render("p1", "t1");
    await flush();

    await act(async () => { await latest.sendMessage("  do it  "); });
    expect(mocks.api.sendProjectChatMessage).toHaveBeenCalledWith("t1", "do it");
    await act(async () => { await latest.stopTurn(); });
    expect(mocks.api.stopProjectChatTurn).toHaveBeenCalledWith("t1");
  });

  it("rejects a snapshot whose thread or project identity does not match the selection", async () => {
    render("p1", "t1");
    await flush();
    const socket = FakeWebSocket.instances[0];
    act(() => socket.message({ type: "project_chat_snapshot", snapshot: snapshot("t1", "other") }));
    expect(latest.messages).toEqual([]);
    expect(latest.error).toBe("Project Chat stream identity mismatch");
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
});
