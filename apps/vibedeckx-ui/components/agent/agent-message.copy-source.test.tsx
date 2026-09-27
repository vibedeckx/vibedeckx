// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
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
  vi.unstubAllGlobals();
});

describe("AgentMessageItem assistant copy source", () => {
  it("copies the raw markdown source, not the rendered text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const source = "# Title\n\nSome **bold** text and `code`.";
    const message = { type: "assistant", content: source, timestamp: Date.now() } as AgentMessage;

    await act(async () => {
      root!.render(<AgentMessageItem message={message} messageIndex={0} />);
    });

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy source"]');
    expect(button).not.toBeNull();

    await act(async () => {
      button!.click();
    });

    expect(writeText).toHaveBeenCalledWith(source);
    expect(container.querySelector('button[aria-label="Copied"]')).not.toBeNull();
    // Still in rendered view — copying must not switch to the source view.
    expect(container.querySelector("pre")).toBeNull();
  });
});
