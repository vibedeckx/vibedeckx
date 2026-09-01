// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentMarkdown } from "./agent-markdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("AgentMarkdown external links", () => {
  it("renders external links with a visible link treatment", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <AgentMarkdown>
          {"Read the [FFmpeg official documentation](https://ffmpeg.org/documentation.html)."}
        </AgentMarkdown>,
      );
    });

    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.classList.contains("text-primary")).toBe(true);
    expect(anchor?.classList.contains("underline")).toBe(true);
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toContain("noopener");
  });
});
