// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const browser = vi.hoisted(() => ({ settled: false, navigate: vi.fn(), jumpTo: vi.fn() }));

vi.mock("@/hooks/use-file-browser", () => ({
  useFileBrowser: () => ({
    rootEntries: [],
    directoryContents: new Map(),
    expandedDirs: new Set(),
    selectedFile: null,
    fileContent: null,
    fileLoading: false,
    rootLoading: !browser.settled,
    loadingDirs: new Set(),
    uploadingDirs: new Set(),
    deletingPaths: new Set(),
    jumpTarget: null,
    revealNonce: 0,
    canGoBack: false,
    canGoForward: false,
    fetchRoot: () => {},
    refresh: () => {},
    reportScroll: () => {},
    restoreScroll: null,
    toggleDirectory: () => {},
    navigate: browser.navigate,
    jumpTo: browser.jumpTo,
    goBack: () => {},
    goForward: () => {},
    uploadFiles: () => {},
    deleteEntry: () => {},
    settled: browser.settled,
  }),
}));
vi.mock("@/hooks/use-file-search", () => ({
  useFileSearch: () => ({ query: "", setQuery: () => {}, results: [], truncated: false, loading: false, loaded: false, ensureLoaded: () => {}, refresh: () => {} }),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
vi.mock("./file-tree", () => ({ FileTree: () => null }));
vi.mock("./file-preview", () => ({ FilePreview: () => null }));

import { FilesView } from "./files-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("FilesView navRequest", () => {
  it("waits for the workspace to settle, then opens the file once", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (navRequest: { path: string; line: number | null; nonce: number }) =>
      act(() => root!.render(<FilesView projectId="p" selectedBranch="feat" navRequest={navRequest} />));

    browser.settled = false;
    render({ path: "docs/x.md", line: 42, nonce: 1 });
    expect(browser.jumpTo).not.toHaveBeenCalled();

    browser.settled = true;
    render({ path: "docs/x.md", line: 42, nonce: 1 });
    expect(browser.jumpTo).toHaveBeenCalledTimes(1);
    expect(browser.jumpTo).toHaveBeenCalledWith("docs/x.md", 42);

    render({ path: "docs/x.md", line: 42, nonce: 1 });
    expect(browser.jumpTo).toHaveBeenCalledTimes(1);

    render({ path: "Makefile", line: null, nonce: 2 });
    expect(browser.navigate).toHaveBeenCalledWith("Makefile");
  });
});
