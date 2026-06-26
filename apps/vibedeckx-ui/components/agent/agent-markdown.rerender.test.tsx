// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileNavigationProvider } from "./file-navigation-context";
import { AgentMarkdown } from "./agent-markdown";
import { buildFileRefIndex, type FileRefIndex } from "@/lib/file-ref/file-ref-index";

// Reproduces the late-`/list-files` bug: a message is rendered while the
// file-ref index is still null (refs stay plain text), then the index arrives
// and the SAME message must upgrade its bare paths into clickable links —
// purely via a context-driven re-render, with the markdown text unchanged.
//
// This is the gap the integration test can't see: it runs the rehype chain by
// hand and never exercises Streamdown's memoized React update path. Streamdown's
// own memo comparator ignores `rehypePlugins`, so without a re-mount signal the
// new index never reaches the renderer and the link never appears (the real-app
// symptom: must toggle source↔rendered to force a fresh mount).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MESSAGE = "see src/app/foo.ts:3 here";

function Harness({ index }: { index: FileRefIndex | null }) {
  return (
    <FileNavigationProvider value={{ openFile: () => {}, index }}>
      <AgentMarkdown>{MESSAGE}</AgentMarkdown>
    </FileNavigationProvider>
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("AgentMarkdown re-render when the file-ref index arrives late", () => {
  it("upgrades a bare path to a link after the index loads (no re-mount)", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // 1. Index not ready yet — the path must stay plain text (no anchor).
    await act(async () => {
      root!.render(<Harness index={null} />);
    });
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).toContain("src/app/foo.ts:3");

    // 2. `/list-files` resolves and the index arrives, same message text.
    const index = buildFileRefIndex(["src/app/foo.ts"]);
    await act(async () => {
      root!.render(<Harness index={index} />);
    });

    // The path should now be a clickable link without any manual toggle.
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toContain("src/app/foo.ts:3");
  });
});
