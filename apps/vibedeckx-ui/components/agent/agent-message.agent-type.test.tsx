// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentMessageItem } from "./agent-message";
import type { AgentMessage } from "@/hooks/use-agent-session";

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
