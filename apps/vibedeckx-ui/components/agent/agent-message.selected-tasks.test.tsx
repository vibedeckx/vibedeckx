// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Task } from "@/lib/api";

vi.mock("./agent-conversation", () => ({
  useOptionalAgentConversation: () => null,
  useAgentConversation: () => null,
}));
vi.mock("@/hooks/global-event-stream", () => ({ useGlobalEventStream: () => {} }));

import { AgentMessageItem } from "./agent-message";
import type { AgentMessage } from "@/hooks/use-agent-session";
import { appendSelectedTasks } from "@/lib/selected-tasks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const TASKS = [
  { id: "t1", title: "Retention test", status: "todo", priority: "high", description: "SECRET BODY TEXT" },
  { id: "t2", title: "Drop flag", status: "done", priority: "low", description: null },
] as Task[];

describe("user message with selected tasks", () => {
  it("names the tasks in the header and keeps the block out of the body", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const message = {
      type: "user", content: appendSelectedTasks("what's left?", TASKS), timestamp: Date.now(),
    } as AgentMessage;

    await act(async () => {
      root!.render(<AgentMessageItem message={message} messageIndex={0} />);
    });

    const text = container.textContent ?? "";
    expect(text).toContain("what's left?");
    expect(text).toContain("Retention test");
    expect(text).toContain("Drop flag");
    expect(text).not.toContain("SECRET BODY TEXT");
    expect(text).not.toContain("vselected-tasks");
  });
});
