// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentMessageItem } from "./agent-message";
import { parseImageBlocks } from "./file-tools";
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

const PNG = "iVBORw0KGgo=";
const IMAGE_OUTPUT = JSON.stringify([
  { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
]);

describe("parseImageBlocks", () => {
  it("extracts base64 image blocks from a JSON content array", () => {
    expect(parseImageBlocks(IMAGE_OUTPUT)).toEqual([{ mediaType: "image/png", data: PNG }]);
  });

  it("returns null for text output, even JSON-looking text", () => {
    expect(parseImageBlocks("1\tconst x = 1;")).toBeNull();
    expect(parseImageBlocks('[{"type":"text","text":"hi"}]')).toBeNull();
    expect(parseImageBlocks("[not json")).toBeNull();
  });
});

describe("AgentMessageItem image tool result", () => {
  it("renders the image the agent viewed inline", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const message = {
      type: "tool_result",
      tool: "Read",
      output: IMAGE_OUTPUT,
      toolUseId: "toolu_img",
      timestamp: Date.now(),
    } as AgentMessage;

    await act(async () => {
      root!.render(<AgentMessageItem message={message} messageIndex={1} />);
    });

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
    // No "File contents (1 line)" text dump of the base64 blob.
    expect(container.textContent).not.toContain("File contents");
  });
});
