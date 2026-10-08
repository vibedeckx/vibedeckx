// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/shiki", () => ({
  THEMES: { light: "one-light", dark: "one-dark-pro" },
  getHighlighterFor: async () => ({
    codeToHtml: (code: string) => `<pre><code>${code}</code></pre>`,
  }),
}));

import { CodeBlock } from "./code-block";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("CodeBlock re-render", () => {
  // React 19 re-applies dangerouslySetInnerHTML whenever the prop object
  // changes identity. Replacing the code's DOM on an unrelated parent re-render
  // wiped the user's text selection in the Files preview.
  it("keeps the highlighted DOM when re-rendered with the same code", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<CodeBlock code="x" language="text" className="a" />));
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();

    await act(async () => root!.render(<CodeBlock code="x" language="text" className="b" />));

    expect(container.querySelector("pre")).toBe(pre);
  });
});
