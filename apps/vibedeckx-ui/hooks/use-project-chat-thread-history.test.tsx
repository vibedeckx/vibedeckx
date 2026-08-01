// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPage: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: { listProjectChatThreadPage: mocks.listPage },
}));

import {
  useProjectChatThreadHistory,
  type UseProjectChatThreadHistoryResult,
} from "./use-project-chat-thread-history";
import type { ProjectChatThread } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const thread = (index: number): ProjectChatThread => ({
  id: `thread-${index}`,
  project_id: "project-1",
  user_id: "user-1",
  title: `Thread ${index}`,
  created_at: "2026-08-01 00:00:00",
  updated_at: "2026-08-01 00:00:00",
  archived_at: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let current: UseProjectChatThreadHistoryResult;

function Probe({ projectId = "project-1", enabled = true }: { projectId?: string; enabled?: boolean }) {
  const value = useProjectChatThreadHistory(projectId, enabled);
  useEffect(() => { current = value; });
  return null;
}

async function render(props?: React.ComponentProps<typeof Probe>) {
  await act(async () => { root.render(<Probe {...props} />); });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useProjectChatThreadHistory", () => {
  it("loads every cursor page beyond thread 100 and deduplicates page boundaries", async () => {
    mocks.listPage
      .mockResolvedValueOnce({ threads: Array.from({ length: 50 }, (_, index) => thread(101 - index)), nextCursor: "page-2" })
      .mockResolvedValueOnce({ threads: [thread(52), ...Array.from({ length: 49 }, (_, index) => thread(51 - index))], nextCursor: "page-3" })
      .mockResolvedValueOnce({ threads: [thread(2), thread(1)], nextCursor: null });

    await render();
    expect(current.threads).toHaveLength(50);
    await act(async () => { await current.loadMore(); });
    expect(current.threads).toHaveLength(99);
    await act(async () => { await current.loadMore(); });

    expect(current.threads).toHaveLength(101);
    expect(current.threads.at(-1)?.id).toBe("thread-1");
    expect(new Set(current.threads.map(({ id }) => id)).size).toBe(101);
    expect(mocks.listPage).toHaveBeenNthCalledWith(2, "project-1", expect.objectContaining({ cursor: "page-2" }));
    expect(mocks.listPage).toHaveBeenNthCalledWith(3, "project-1", expect.objectContaining({ cursor: "page-3" }));
  });

  it("single-flights concurrent requests for the same next cursor", async () => {
    const nextPage = deferred<{ threads: ProjectChatThread[]; nextCursor: string | null }>();
    mocks.listPage
      .mockResolvedValueOnce({ threads: [thread(2)], nextCursor: "same-cursor" })
      .mockReturnValueOnce(nextPage.promise);
    await render();

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = current.loadMore();
      second = current.loadMore();
    });
    expect(mocks.listPage).toHaveBeenCalledTimes(2);
    await act(async () => {
      nextPage.resolve({ threads: [thread(1)], nextCursor: null });
      await Promise.all([first, second]);
    });
    expect(current.threads.map(({ id }) => id)).toEqual(["thread-2", "thread-1"]);
  });

  it("aborts and ignores a stale search response instead of mixing queries", async () => {
    const initial = deferred<{ threads: ProjectChatThread[]; nextCursor: string | null }>();
    const stale = deferred<{ threads: ProjectChatThread[]; nextCursor: string | null }>();
    mocks.listPage
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ threads: [thread(3)], nextCursor: null });

    await render();
    const initialSignal = mocks.listPage.mock.calls[0][1].signal as AbortSignal;
    act(() => current.setQuery("old"));
    expect(initialSignal.aborted).toBe(true);
    const staleSignal = mocks.listPage.mock.calls[1][1].signal as AbortSignal;
    act(() => current.setQuery("new"));
    expect(staleSignal.aborted).toBe(true);
    await act(async () => {});
    expect(current.threads.map(({ id }) => id)).toEqual(["thread-3"]);

    await act(async () => {
      stale.resolve({ threads: [thread(99)], nextCursor: null });
      initial.resolve({ threads: [thread(100)], nextCursor: null });
      await Promise.resolve();
    });
    expect(current.threads.map(({ id }) => id)).toEqual(["thread-3"]);
    expect(mocks.listPage).toHaveBeenLastCalledWith("project-1", expect.objectContaining({ query: "new" }));
  });

  it("loads archived history in a separate reset query", async () => {
    mocks.listPage
      .mockResolvedValueOnce({ threads: [thread(2)], nextCursor: "active-next" })
      .mockResolvedValueOnce({ threads: [{ ...thread(1), archived_at: 1 }], nextCursor: null });
    await render();

    act(() => current.showArchived());
    await act(async () => {});

    expect(current.threads.map(({ id }) => id)).toEqual(["thread-1"]);
    expect(mocks.listPage).toHaveBeenLastCalledWith("project-1", expect.objectContaining({ includeArchived: true }));
  });
});
