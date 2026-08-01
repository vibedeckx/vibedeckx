// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mobile: true,
  chat: {} as import("@/hooks/use-project-chat").UseProjectChatResult,
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }));
vi.mock("@/hooks/use-project-chat", () => ({
  useProjectChat: (_projectId: string, threadId: string) => ({
    ...state.chat,
    thread: thread(threadId),
    contextRefs: state.chat.contextRefs.map((ref) => ({ ...ref, thread_id: threadId })),
  }),
}));

import { ProjectChatWorkbench } from "./project-chat-workbench";
import type { ProjectChatThread } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
(globalThis as unknown as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame = ((callback: FrameRequestCallback) => (
  window.setTimeout(() => callback(performance.now()), 0)
)) as typeof requestAnimationFrame;

const thread = (id: string): ProjectChatThread => ({
  id,
  project_id: "project-1",
  user_id: "user-1",
  title: id === "thread-1" ? "Release plan" : "Login refactor",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  archived_at: null,
});

function setupChat() {
  state.chat = {
    thread: thread("thread-1"),
    threads: [thread("thread-1"), thread("thread-2")],
    messages: [],
    status: "idle",
    activeTurnId: null,
    queueLength: 0,
    contextRefs: [{
      thread_id: "thread-1",
      entity_type: "task",
      entity_id: "task-1",
      last_referenced_at: "2026-08-01T00:00:00.000Z",
      deleted: false,
      navigation: { kind: "task", taskId: "task-1", label: "Ship release" },
    }],
    loading: false,
    threadsLoading: false,
    threadLoading: false,
    isConnected: true,
    error: null,
    terminalError: null,
    refetchThreads: vi.fn(async () => undefined),
    createThread: vi.fn(async () => thread("thread-3")),
    renameThread: vi.fn(async (_id, title) => ({ ...thread("thread-1"), title })),
    archiveThread: vi.fn(async () => ({ ...thread("thread-1"), archived_at: Date.now() })),
    deleteThread: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    stopTurn: vi.fn(async () => true),
    resolveToolApproval: vi.fn(async () => undefined),
    selectWorkspace: vi.fn(async () => undefined),
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found as HTMLButtonElement;
}

function typeIn(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Project Chat responsive workbench", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    setupChat();
    state.mobile = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("moves Threads and Context together into one focused drawer without duplicating Chat", async () => {
    act(() => root.render(<ProjectChatWorkbench
      projectId="project-1"
      threadId="thread-1"
      projectName="VibeDeckX"
      onBack={vi.fn()}
      onSelectThread={vi.fn()}
      onOpenContext={vi.fn()}
    />));

    expect(container.querySelectorAll('[data-testid="project-chat-main"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="project-chat-rail"]')).toHaveLength(0);
    act(() => button("Open threads and context").click());

    const drawer = document.querySelector('[data-testid="project-chat-mobile-drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer!.querySelectorAll('[data-testid="project-chat-rail"]')).toHaveLength(1);
    expect(drawer!.textContent).toContain("Chat Threads");
    expect(drawer!.textContent).toContain("Context");
    expect(drawer!.textContent).toContain("Ship release");
    expect(container.querySelectorAll('[data-testid="project-chat-main"]')).toHaveLength(1);
    expect(document.querySelectorAll('textarea[aria-label="Message Project Chat"]')).toHaveLength(1);
    expect(drawer!.contains(document.activeElement)).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.querySelector('[data-testid="project-chat-mobile-drawer"]')).toBeNull();
    expect(document.activeElement).toBe(button("Open threads and context"));
  });

  it("closes the drawer on thread switch while preserving the live Chat draft", async () => {
    function StatefulWorkbench() {
      const [threadId, setThreadId] = useState("thread-1");
      return <ProjectChatWorkbench
        projectId="project-1"
        threadId={threadId}
        projectName="VibeDeckX"
        onBack={vi.fn()}
        onSelectThread={setThreadId}
      />;
    }
    act(() => root.render(<StatefulWorkbench />));
    const composer = document.querySelector('textarea[aria-label="Message Project Chat"]') as HTMLTextAreaElement;
    act(() => typeIn(composer, "Keep this draft"));
    act(() => button("Open threads and context").click());

    await act(async () => {
      button("Open thread: Login refactor").click();
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="project-chat-mobile-drawer"]')).toBeNull();
    expect(button("Current thread: Login refactor")).toBeTruthy();
    expect(document.activeElement).toBe(button("Open threads and context"));
    expect(document.querySelectorAll('[data-testid="project-chat-main"]')).toHaveLength(1);
    expect(document.querySelectorAll('textarea[aria-label="Message Project Chat"]')).toHaveLength(1);
    const secondComposer = document.querySelector('textarea[aria-label="Message Project Chat"]') as HTMLTextAreaElement;
    expect(secondComposer).not.toBe(composer);
    expect(secondComposer.value).toBe("");

    act(() => button("Open threads and context").click());
    await act(async () => {
      button("Open thread: Release plan").click();
      await Promise.resolve();
    });
    expect(button("Current thread: Release plan")).toBeTruthy();
    expect((document.querySelector('textarea[aria-label="Message Project Chat"]') as HTMLTextAreaElement).value)
      .toBe("Keep this draft");
  });

  it("renders the auxiliary rail only on desktop and never mounts a mobile drawer", () => {
    state.mobile = false;
    act(() => root.render(<ProjectChatWorkbench
      projectId="project-1"
      threadId="thread-1"
      projectName="VibeDeckX"
      onBack={vi.fn()}
      onSelectThread={vi.fn()}
    />));

    expect(container.querySelectorAll('[data-testid="project-chat-main"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="project-chat-rail"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="project-chat-mobile-drawer"]')).toBeNull();
    expect(button("Hide threads and context")).toBeTruthy();
  });
});
