// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowseEntry, FileContentResponse } from "@/lib/api";

const browseProjectDirectory = vi.hoisted(() => vi.fn());
const getFileContent = vi.hoisted(() => vi.fn());
const uploadFilesApi = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: { browseProjectDirectory, getFileContent, uploadFiles: uploadFilesApi } };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useFileBrowser } from "./use-file-browser";
import { makeKey, saveView } from "@/lib/files/open-file-persistence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (name: string): BrowseEntry => ({ name, path: name, type: "file" }) as unknown as BrowseEntry;
const content = (text: string): FileContentResponse => ({ content: text }) as unknown as FileContentResponse;

/** A promise plus the handles to settle it, so response order is the test's to choose. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Result = ReturnType<typeof useFileBrowser>;

describe("useFileBrowser workspace scoping", () => {
  let container: HTMLElement;
  let root: Root;
  let latest: Result;

  // Mirrors FilesView: fetch the root whenever the workspace (fetchRoot) changes.
  function Probe({ branch }: { branch: string }) {
    const value = useFileBrowser({ projectId: "p1", branch });
    const { fetchRoot } = value;
    useEffect(() => { fetchRoot(); }, [fetchRoot]);
    useEffect(() => { latest = value; });
    return null;
  }

  const names = () => latest.rootEntries.map((e) => e.name);

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function openWorkspaceA() {
    saveView(makeKey("p1", "a", undefined), {
      selectedFile: "a.txt",
      history: { entries: [{ path: "a.txt", line: null }], index: 0 },
      scrollTop: 0,
    });
    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("a.txt")] });
    getFileContent.mockResolvedValueOnce(content("A"));
    await act(async () => { root.render(<Probe branch="a" />); });
    expect(names()).toEqual(["a.txt"]);
    expect(latest.selectedFile).toBe("a.txt");
  }

  it("shows loading, not the previous workspace's tree and file, until the new tree lands", async () => {
    await openWorkspaceA();

    const treeB = deferred<{ items: BrowseEntry[] }>();
    browseProjectDirectory.mockReturnValueOnce(treeB.promise);
    await act(async () => { root.render(<Probe branch="b" />); });

    expect(names()).toEqual([]);
    expect(latest.selectedFile).toBeNull();
    expect(latest.fileContent).toBeNull();
    expect(latest.canGoBack).toBe(false);
    expect(latest.rootLoading).toBe(true);

    await act(async () => { treeB.resolve({ items: [entry("b.txt")] }); await treeB.promise; });
    expect(names()).toEqual(["b.txt"]);
    expect(latest.selectedFile).toBeNull();
    expect(latest.rootLoading).toBe(false);
  });

  it("settles on an empty workspace when the new tree fails to load", async () => {
    await openWorkspaceA();

    browseProjectDirectory.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { root.render(<Probe branch="b" />); });

    expect(names()).toEqual([]);
    expect(latest.selectedFile).toBeNull();
    expect(latest.fileContent).toBeNull();
    expect(latest.rootLoading).toBe(false);
  });

  it("drops a folder listing that answers after the switch", async () => {
    await openWorkspaceA();
    const lateDir = deferred<{ items: BrowseEntry[] }>();
    browseProjectDirectory.mockReturnValueOnce(lateDir.promise);
    await act(async () => { void latest.toggleDirectory("src"); });

    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("b.txt")] });
    await act(async () => { root.render(<Probe branch="b" />); });
    await act(async () => { lateDir.resolve({ items: [entry("from-a.ts")] }); await lateDir.promise; });
    expect(latest.directoryContents.has("src")).toBe(false);

    // Opening the same path in this workspace fetches this workspace's listing.
    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("from-b.ts")] });
    await act(async () => { await latest.toggleDirectory("src"); });
    expect(latest.directoryContents.get("src")?.map((e) => e.name)).toEqual(["from-b.ts"]);
  });

  it("drops a root refresh that answers after the switch", async () => {
    await openWorkspaceA();
    const lateRoot = deferred<{ items: BrowseEntry[] }>();
    browseProjectDirectory.mockReturnValueOnce(lateRoot.promise);
    let refreshing: Promise<void> = Promise.resolve();
    await act(async () => { refreshing = latest.refreshDirectory(""); });

    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("b.txt")] });
    await act(async () => { root.render(<Probe branch="b" />); });
    await act(async () => { lateRoot.resolve({ items: [entry("a.txt")] }); await refreshing; });
    expect(names()).toEqual(["b.txt"]);
  });

  it("drops a file load that answers after switching to a workspace with nothing to reopen", async () => {
    await openWorkspaceA();
    const lateFile = deferred<FileContentResponse>();
    getFileContent.mockReturnValueOnce(lateFile.promise);
    await act(async () => { void latest.navigate("other.txt"); });
    expect(latest.fileLoading).toBe(true);

    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("b.txt")] });
    await act(async () => { root.render(<Probe branch="b" />); });
    await act(async () => { lateFile.resolve(content("from A")); await lateFile.promise; });
    expect(latest.selectedFile).toBeNull();
    expect(latest.fileContent).toBeNull();
    expect(latest.fileLoading).toBe(false);
  });

  it("reopens the previous workspace's file, history and scroll on switching back", async () => {
    saveView(makeKey("p1", "a", undefined), {
      selectedFile: "two.txt",
      history: { entries: [{ path: "one.txt", line: null }, { path: "two.txt", line: 4 }], index: 1 },
      scrollTop: 120,
    });
    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("one.txt"), entry("two.txt")] });
    getFileContent.mockResolvedValueOnce(content("TWO"));
    await act(async () => { root.render(<Probe branch="a" />); });

    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("b.txt")] });
    await act(async () => { root.render(<Probe branch="b" />); });
    expect(latest.selectedFile).toBeNull();

    // Back to A: file content comes from the page's cache, the tree is re-fetched.
    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("one.txt"), entry("two.txt")] });
    await act(async () => { root.render(<Probe branch="a" />); });
    expect(latest.selectedFile).toBe("two.txt");
    expect(latest.fileContent).toEqual(content("TWO"));
    expect(latest.canGoBack).toBe(true);
    expect(latest.canGoForward).toBe(false);
    expect(latest.restoreScroll?.top).toBe(120);
    expect(getFileContent).toHaveBeenCalledTimes(1);
  });

  it("drops a file load that answers after switching back to a workspace whose file is cached", async () => {
    await openWorkspaceA(); // A's a.txt is now cached

    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("b.txt")] });
    await act(async () => { root.render(<Probe branch="b" />); });
    const slowB = deferred<FileContentResponse>();
    getFileContent.mockReturnValueOnce(slowB.promise);
    await act(async () => { void latest.navigate("b.txt"); });

    // Back to A: a.txt comes from the cache, then B's slow load answers.
    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("a.txt")] });
    await act(async () => { root.render(<Probe branch="a" />); });
    expect(latest.fileContent).toEqual(content("A"));
    await act(async () => { slowB.resolve(content("from B")); await slowB.promise; });
    expect(latest.selectedFile).toBe("a.txt");
    expect(latest.fileContent).toEqual(content("A"));
  });

  it("does not refresh the new workspace's tree with an upload that finished after the switch", async () => {
    await openWorkspaceA();
    const upload = deferred<{ uploaded: string[] }>();
    uploadFilesApi.mockReturnValueOnce(upload.promise);
    let uploading: Promise<void> = Promise.resolve();
    await act(async () => { uploading = latest.uploadFiles("", [new File(["x"], "new.txt")]); });

    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("b.txt")] });
    await act(async () => { root.render(<Probe branch="b" />); });
    // Were the upload's refresh to run, it would list A's root.
    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("a.txt"), entry("new.txt")] });
    await act(async () => { upload.resolve({ uploaded: ["new.txt"] }); await uploading; });
    expect(names()).toEqual(["b.txt"]);
  });

  it("keeps a file opened while the session changes in the same workspace", async () => {
    function SessionProbe({ sessionId }: { sessionId: string }) {
      const value = useFileBrowser({ projectId: "p1", branch: "a", sessionId });
      const { fetchRoot } = value;
      useEffect(() => { fetchRoot(); }, [fetchRoot]);
      useEffect(() => { latest = value; });
      return null;
    }
    saveView(makeKey("p1", "a", undefined), {
      selectedFile: "old.txt",
      history: { entries: [{ path: "old.txt", line: null }], index: 0 },
      scrollTop: 0,
    });
    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("old.txt"), entry("target.txt")] });
    getFileContent.mockResolvedValueOnce(content("OLD"));
    await act(async () => { root.render(<SessionProbe sessionId="s1" />); });
    expect(latest.selectedFile).toBe("old.txt");

    // A Task file link: the pin clears (the session changes) and the file opens
    // in the same commit. A re-run restore would answer late and put old.txt back.
    const lateRoot = deferred<{ items: BrowseEntry[] }>();
    browseProjectDirectory.mockReturnValueOnce(lateRoot.promise);
    getFileContent.mockResolvedValue(content("TARGET"));
    await act(async () => {
      root.render(<SessionProbe sessionId="s2" />);
      void latest.navigate("target.txt", 3);
    });
    await act(async () => { lateRoot.resolve({ items: [entry("old.txt"), entry("target.txt")] }); });

    expect(latest.selectedFile).toBe("target.txt");
    expect(browseProjectDirectory).toHaveBeenCalledTimes(1);
  });

  it("expands the open file's folders and redoes it after a refresh", async () => {
    browseProjectDirectory.mockReset(); // drop listings queued but never consumed by earlier tests
    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("src")] });
    await act(async () => { root.render(<Probe branch="a" />); });

    browseProjectDirectory.mockImplementation(async (_p: string, dir?: string) => ({
      items: dir === "src" ? [entry("lib")] : dir === "src/lib" ? [entry("x.ts")] : [entry("src")],
    }));
    getFileContent.mockResolvedValue(content("X"));
    await act(async () => { await latest.navigate("src/lib/x.ts"); });
    await act(async () => {}); // the reveal's listings, fetched from an effect
    expect([...latest.expandedDirs].sort()).toEqual(["src", "src/lib"]);
    expect(latest.directoryContents.get("src/lib")?.map((e) => e.name)).toEqual(["x.ts"]);
    expect(browseProjectDirectory).toHaveBeenCalledTimes(3);

    // Refresh rebuilds the tree collapsed; the open file is revealed again.
    await act(async () => { await latest.refresh(); });
    await act(async () => {});
    expect([...latest.expandedDirs].sort()).toEqual(["src", "src/lib"]);
    expect(latest.directoryContents.has("src/lib")).toBe(true);
  });

  it("leaves the tree alone for a file outside the checkout", async () => {
    browseProjectDirectory.mockReset();
    browseProjectDirectory.mockResolvedValueOnce({ items: [entry("src")] });
    await act(async () => { root.render(<Probe branch="a" />); });
    getFileContent.mockResolvedValue(content("T"));
    await act(async () => { await latest.navigate("/tmp/out/report.md"); });
    expect(latest.expandedDirs.size).toBe(0);
    expect(browseProjectDirectory).toHaveBeenCalledTimes(1);
  });

  it("re-reveals the file already open when it is opened again, keeping other open folders", async () => {
    browseProjectDirectory.mockReset();
    browseProjectDirectory.mockImplementation(async (_p: string, dir?: string) => ({
      items: dir === "src" ? [entry("lib")] : dir === "src/lib" ? [entry("x.ts")] : [entry("src"), entry("docs")],
    }));
    getFileContent.mockResolvedValue(content("X"));
    await act(async () => { root.render(<Probe branch="a" />); });
    await act(async () => { await latest.navigate("src/lib/x.ts"); });
    await act(async () => {});
    await act(async () => { await latest.toggleDirectory("docs"); });
    await act(async () => { await latest.toggleDirectory("src"); }); // user collapses it
    expect(latest.expandedDirs.has("src")).toBe(false);

    const before = latest.revealNonce;
    await act(async () => { await latest.navigate("src/lib/x.ts"); }); // e.g. a search hit
    await act(async () => {});
    expect([...latest.expandedDirs].sort()).toEqual(["docs", "src", "src/lib"]);
    expect(latest.revealNonce).toBeGreaterThan(before);
  });
});
