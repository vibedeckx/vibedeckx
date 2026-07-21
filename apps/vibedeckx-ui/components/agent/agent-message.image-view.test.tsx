// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
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

describe("AgentMessageItem image view tool", () => {
  it("shows the viewed image path in a dedicated tool row", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const message = {
      type: "tool_use",
      tool: "ImageView",
      input: { path: "/tmp/screenshot.png" },
      toolUseId: "image-1",
      timestamp: Date.now(),
    } as AgentMessage;

    await act(async () => {
      root!.render(<AgentMessageItem message={message} messageIndex={0} />);
    });

    expect(container.textContent).toContain("View Image");
    expect(container.textContent).toContain("/tmp/screenshot.png");
    expect(container.textContent).not.toContain("Tool: ImageView");
    expect(container.textContent).not.toContain("Input");
  });
});
