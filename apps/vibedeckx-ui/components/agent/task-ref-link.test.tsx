// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/api";

const conversation = vi.hoisted(() => ({
  value: { projectId: "proj-1", openTask: vi.fn() } as { projectId: string | null; openTask?: (t: Task) => void } | null,
}));
vi.mock("./agent-conversation", () => ({
  useOptionalAgentConversation: () => conversation.value,
  useAgentConversation: () => conversation.value,
}));
const apiMock = vi.hoisted(() => ({ getTasks: vi.fn(async () => [] as Task[]) }));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/hooks/global-event-stream", () => ({ useGlobalEventStream: () => {} }));

import { AgentMarkdown } from "./agent-markdown";
import { parseTaskRefHref } from "./task-ref-link";
import { __resetProposedTaskCache } from "@/hooks/use-proposed-tasks";

const TASK = { id: "task-1", project_id: "proj-1", title: "Retention test" } as Task;

describe("parseTaskRefHref", () => {
  it("reads the id of a #ref:task: link only", () => {
    expect(parseTaskRefHref("#ref:task:task-1")).toBe("task-1");
    expect(parseTaskRefHref("#ref:task:a%20b")).toBe("a b");
    expect(parseTaskRefHref("#ref:task:")).toBeNull();
    expect(parseTaskRefHref("#ref:schedule:x")).toBeNull();
    expect(parseTaskRefHref("https://example.com")).toBeNull();
  });
});

describe("task links in agent markdown", () => {
  let container: HTMLDivElement;
  let root: Root;
  const openTask = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    __resetProposedTaskCache();
    apiMock.getTasks.mockReset().mockResolvedValue([TASK]);
    openTask.mockReset();
    conversation.value = { projectId: "proj-1", openTask };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async (markdown: string) => {
    await act(async () => { root.render(<AgentMarkdown>{markdown}</AgentMarkdown>); });
    await act(async () => { await Promise.resolve(); });
  };

  it("opens a task of this project", async () => {
    await render("See [Retention test](#ref:task:task-1).");
    const link = container.querySelector<HTMLAnchorElement>("[data-task-ref]")!;
    expect(link.textContent).toBe("Retention test");
    await act(async () => { link.click(); });
    expect(openTask).toHaveBeenCalledWith(TASK);
  });

  it("leaves an unknown id as plain text", async () => {
    await render("See [Made up](#ref:task:nope).");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("Made up");
  });

  it("stays plain text outside a conversation", async () => {
    conversation.value = null;
    await render("See [Retention test](#ref:task:task-1).");
    expect(container.querySelector("a")).toBeNull();
    expect(apiMock.getTasks).not.toHaveBeenCalled();
  });
});
