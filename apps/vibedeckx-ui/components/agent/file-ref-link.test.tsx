// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileNavigationProvider, type FileNavigationValue } from "./file-navigation-context";
import { FileRefLink, classifyExternalRef } from "./file-ref-link";
import { buildFileRefIndex } from "@/lib/file-ref/file-ref-index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const SCOPE = { projectId: "p1", branch: "dev", target: "remote" as const };

async function render(raw: string, value: Partial<FileNavigationValue>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const full: FileNavigationValue = { openFile: () => {}, index: null, scope: SCOPE, ...value };
  await act(async () => {
    root!.render(
      <FileNavigationProvider value={full}>
        <FileRefLink href="#file-ref" node={{ properties: { dataFileRaw: raw } }}>
          {raw}
        </FileRefLink>
      </FileNavigationProvider>,
    );
  });
}

describe("classifyExternalRef", () => {
  it("links images anywhere and other files only when absolute", () => {
    expect(classifyExternalRef("/tmp/splash-vs-icon.png")).toBe("image");
    expect(classifyExternalRef("out/screenshot.png")).toBe("image");
    expect(classifyExternalRef("~/shots/a.webp")).toBe("image");
    expect(classifyExternalRef("/tmp/report.md")).toBe("file");
    expect(classifyExternalRef("notes/report.md")).toBeNull();
    expect(classifyExternalRef("/api/projects")).toBeNull();
    expect(classifyExternalRef("and/or")).toBeNull();
    expect(classifyExternalRef("/etc/.hidden")).toBeNull();
  });
});

describe("FileRefLink for paths outside the repo index", () => {
  it("stays plain text while the index is still loading", async () => {
    await render("/tmp/shot.png", { index: null });
    expect(container!.querySelector("a")).toBeNull();
    expect(container!.textContent).toBe("/tmp/shot.png");
  });

  it("becomes a link that opens the path in the Files tab once the index says 'not ours'", async () => {
    const openFile = vi.fn();
    await render("/tmp/shot.png", { index: buildFileRefIndex(["src/a.ts"]), openFile });
    const a = container!.querySelector("a");
    expect(a).not.toBeNull();
    await act(async () => {
      a!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openFile).toHaveBeenCalledWith("/tmp/shot.png", null);
  });

  it("links an absolute non-image file too, but not a bare relative one", async () => {
    await render("/tmp/report.md", { index: buildFileRefIndex(["src/a.ts"]) });
    expect(container!.querySelector("a")).not.toBeNull();
    await render("notes/report.md", { index: buildFileRefIndex(["src/a.ts"]) });
    expect(container!.querySelector("a")).toBeNull();
  });

  it("still prefers the repo file when the index resolves the same path", async () => {
    const openFile = vi.fn();
    await render("/work/repo/src/a.png", { index: buildFileRefIndex(["src/a.png"]), openFile });
    await act(async () => {
      container!.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openFile).toHaveBeenCalledWith("src/a.png", null);
  });

  it("opens the absolute path itself when a repo file merely shares its basename", async () => {
    const openFile = vi.fn();
    await render("/tmp/screenshot.png", {
      index: buildFileRefIndex(["screenshot.png"], "/work/repo"),
      openFile,
    });
    await act(async () => {
      container!.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openFile).toHaveBeenCalledWith("/tmp/screenshot.png", null);
  });

  it("links an outside path even when the file list never loaded (empty index)", async () => {
    await render("/tmp/shot.png", { index: buildFileRefIndex([]) });
    expect(container!.querySelector("a")).not.toBeNull();
  });

  it("does not link without a read scope (no project open)", async () => {
    await render("/tmp/shot.png", { index: buildFileRefIndex(["src/a.ts"]), scope: null });
    expect(container!.querySelector("a")).toBeNull();
  });
});
