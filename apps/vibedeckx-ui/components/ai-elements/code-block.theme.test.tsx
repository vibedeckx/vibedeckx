// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Each highlighter request stays pending until the test releases it, so the
// order in which highlight results land can be controlled.
const pending: Array<() => void> = [];
vi.mock("@/lib/shiki", () => ({
  THEMES: { light: "one-light", dark: "one-dark-pro" },
  getHighlighterFor: () =>
    new Promise((resolve) => {
      pending.push(() =>
        resolve({
          codeToHtml: (code: string, opts: { theme: string }) =>
            `<pre data-theme="${opts.theme}"><code>${code}</code></pre>`,
        }),
      );
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
  pending.length = 0;
  document.documentElement.classList.remove("dark");
});

describe("CodeBlock theme", () => {
  it("shows the current theme when a stale highlight resolves first", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<CodeBlock code="x" language="text" />));
    expect(pending).toHaveLength(1);

    // Switch to dark while the light highlight is still in flight.
    await act(async () => {
      document.documentElement.classList.add("dark");
      await Promise.resolve();
    });
    expect(pending).toHaveLength(2);

    // The stale light result lands first, then the current dark one.
    await act(async () => pending[0]());
    await act(async () => pending[1]());

    expect(container.querySelector("pre")?.getAttribute("data-theme")).toBe("one-dark-pro");
  });
});
