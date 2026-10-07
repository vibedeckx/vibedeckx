// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarkdownField } from "./markdown-field";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function render(value: string, onOpenFile = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MarkdownField value={value} label="Description" onOpenFile={onOpenFile}>
        <textarea aria-label="Description" />
      </MarkdownField>,
    );
  });
  return onOpenFile;
}

const links = () => Array.from(container!.querySelectorAll("a"));

describe("MarkdownField file links", () => {
  it("opens a file link without entering the editor or touching the hash", () => {
    const onOpenFile = render("参考 [设计](docs/x.md) 第 3 节");
    const [a] = links();
    expect(a.textContent).toBe("设计");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      a.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(onOpenFile).toHaveBeenCalledWith("docs/x.md", null);
    expect(container!.querySelector("textarea")).toBeNull();
  });

  it("passes the line of a path:42 link", () => {
    const onOpenFile = render("[h](src/a.ts:42)");
    act(() => links()[0].click());
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts", 42);
  });

  it("keeps bare paths and code spans as text", () => {
    render("see docs/x.md:42 and `[x](docs/x.md)`");
    expect(links()).toEqual([]);
    expect(container!.textContent).toContain("docs/x.md:42");
    expect(container!.textContent).toContain("[x](docs/x.md)");
  });

  it("renders out-of-repo hrefs as text and URLs as external links", () => {
    render("[a](/etc/x) [b](~/x) [c](../x) [d](https://example.com)");
    const [a] = links();
    expect(links()).toHaveLength(1);
    expect(a.getAttribute("href")).toBe("https://example.com/");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(container!.textContent).toContain("a b c");
  });
});
