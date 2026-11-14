// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentMessageItem } from "./agent-message";
import type { AgentMessage } from "@/hooks/use-agent-session";

vi.mock("./agent-conversation", () => ({
  useOptionalAgentConversation: () => ({
    agentType: "codex", sessionId: null,
    providers: [{ type: "third", displayName: "Third Agent", available: true }],
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("AgentMessageItem assistant agent label", () => {
  it("uses provider metadata for historical third-agent messages", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AgentMessageItem message={{ type: "assistant", content: "done", agentType: "third", timestamp: 0 }} messageIndex={0} />);
    });
    expect(container.textContent).toContain("Third Agent");
    expect(container.textContent).not.toContain("Claude");
    expect(container.querySelector(".text-muted-foreground")).not.toBeNull();
    expect(container.querySelector(".text-violet-500")).toBeNull();
  });

  it("uses the assistant message's recorded agent type", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const message = {
      type: "assistant",
      content: "done",
      agentType: "codex",
      timestamp: Date.now(),
    } as AgentMessage;

    await act(async () => {
      root!.render(<AgentMessageItem message={message} messageIndex={0} />);
    });

    expect(container.textContent).toContain("Codex");
    expect(container.textContent).not.toContain("Claude");
  });
});
