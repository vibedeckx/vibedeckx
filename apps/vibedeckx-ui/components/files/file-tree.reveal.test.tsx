// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BrowseEntry } from "@/lib/api";
import { FileTree } from "./file-tree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe("FileTree reveal scrolling", () => {
  it("scrolls the open file into view again when it is re-opened", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const noop = () => {};
    const render = (revealNonce: number) =>
      act(() => root!.render(
        <FileTree
          entries={[{ name: "a.ts", type: "file" } as BrowseEntry, { name: "b.ts", type: "file" } as BrowseEntry]}
          expandedDirs={new Set()}
          directoryContents={new Map()}
          loadingDirs={new Set()}
          selectedFile="a.ts"
          revealNonce={revealNonce}
          uploadingDirs={new Set()}
          rootLoading={false}
          deletingPaths={new Set()}
          onToggleDirectory={noop}
          onSelectFile={noop}
          onUploadFiles={noop}
          onDeleteEntry={noop}
        />,
      ));

    render(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    render(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    render(2);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
