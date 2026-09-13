// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { placeAboveSelection } from "./selection-copy-button";
import { TerminalFilterView } from "./terminal-filter-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rect = (top: number, left: number, w = 100, h = 16): DOMRect =>
  ({ top, left, width: w, height: h, bottom: top + h, right: left + w, x: left, y: top, toJSON() {} }) as DOMRect;

describe("placeAboveSelection", () => {
  const host = rect(100, 50, 400, 300);

  it("floats above the first selected line, aligned to its start", () => {
    expect(placeAboveSelection(rect(160, 80), host)).toEqual({ top: 160 - 100 - 22 - 4, left: 30 });
  });

  it("drops below the line when there is no room above", () => {
    expect(placeAboveSelection(rect(102, 80), host)).toEqual({ top: 102 + 16 - 100 + 4, left: 30 });
  });

  it("clamps horizontally so the button stays inside the host", () => {
    expect(placeAboveSelection(rect(160, 20), host).left).toBe(2);
    expect(placeAboveSelection(rect(160, 440), host).left).toBe(400 - 64 - 2);
  });
});

describe("TerminalFilterView selection copy", () => {
  let container: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.fn>;
  let fakeSelection: {
    isCollapsed: boolean;
    rangeCount: number;
    anchorNode: Node | null;
    rects: DOMRect[];
    getRangeAt: () => { getClientRects: () => DOMRect[] };
    toString: () => string;
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    fakeSelection = {
      isCollapsed: true,
      rangeCount: 0,
      anchorNode: null,
      rects: [rect(40, 30)],
      getRangeAt: () => ({ getClientRects: () => fakeSelection.rects }),
      toString: () => "ERROR db\nerror: timeout",
    };
    vi.spyOn(document, "getSelection").mockImplementation(
      () => fakeSelection as unknown as Selection
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const view = () => document.querySelector('[data-testid="terminal-filter-view"]') as HTMLElement;
  const button = () =>
    document.querySelector('[data-testid="selection-copy-button"]') as HTMLButtonElement | null;
  const scroller = () =>
    document.querySelector('[data-testid="terminal-filter-scroller"]') as HTMLElement;
  // A mouse drag: press on the view, release anywhere (bubbles to window).
  const drag = () => {
    act(() => scroller().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    act(() => scroller().dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
  };
  const scroll = () => act(() => scroller().dispatchEvent(new Event("scroll")));

  it("shows a copy button on mouseup over a selection and copies it", async () => {
    act(() => {
      root.render(
        <TerminalFilterView
          lines={["ERROR db", "error: timeout"]}
          fontSize={13}
          fontFamily="monospace"
          isPty={false}
        />
      );
    });
    vi.spyOn(view(), "getBoundingClientRect").mockReturnValue(rect(0, 0, 500, 300));

    // Collapsed selection → nothing.
    drag();
    expect(button()).toBeNull();

    fakeSelection.isCollapsed = false;
    fakeSelection.rangeCount = 1;
    fakeSelection.anchorNode = view().querySelector("pre")!;
    // Mid-drag nothing shows even though a selection exists.
    act(() => scroller().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    scroll();
    expect(button()).toBeNull();
    act(() => window.dispatchEvent(new MouseEvent("mouseup")));
    const btn = button()!;
    expect(btn).not.toBeNull();
    expect(btn.style.top).toBe(`${40 - 22 - 4}px`);
    expect(btn.style.left).toBe("30px");

    await act(async () => btn.click());
    expect(writeText).toHaveBeenCalledWith("ERROR db\nerror: timeout");
    expect(button()).toBeNull();
  });

  it("ignores selections that start outside the view and hides when the selection collapses", () => {
    act(() => {
      root.render(
        <TerminalFilterView lines={["one"]} fontSize={13} fontFamily="monospace" isPty={false} />
      );
    });
    vi.spyOn(view(), "getBoundingClientRect").mockReturnValue(rect(0, 0, 500, 300));
    const outside = document.createElement("p");
    document.body.appendChild(outside);

    fakeSelection.isCollapsed = false;
    fakeSelection.rangeCount = 1;
    fakeSelection.anchorNode = outside;
    drag();
    expect(button()).toBeNull();

    fakeSelection.anchorNode = view().querySelector("pre")!;
    drag();
    expect(button()).not.toBeNull();

    fakeSelection.isCollapsed = true;
    act(() => document.dispatchEvent(new Event("selectionchange")));
    expect(button()).toBeNull();
    outside.remove();
  });

  it("anchors to the first selected line that is on screen, and hides when none is", () => {
    act(() => {
      root.render(
        <TerminalFilterView lines={["one", "two"]} fontSize={13} fontFamily="monospace" isPty={false} />
      );
    });
    vi.spyOn(view(), "getBoundingClientRect").mockReturnValue(rect(0, 0, 500, 300));
    fakeSelection.isCollapsed = false;
    fakeSelection.rangeCount = 1;
    fakeSelection.anchorNode = view().querySelector("pre")!;

    // First two lines of the range have scrolled above the view; the third
    // is visible — the button sits above that one.
    fakeSelection.rects = [rect(-60, 30), rect(-40, 10), rect(80, 10), rect(100, 10)];
    drag();
    expect(button()!.style.top).toBe(`${80 - 22 - 4}px`);
    expect(button()!.style.left).toBe("10px");

    // Every selected line is off screen → no button rather than one at a
    // negative offset.
    fakeSelection.rects = [rect(-60, 30), rect(-40, 10)];
    drag();
    expect(button()).toBeNull();
    fakeSelection.rects = [rect(320, 30)];
    drag();
    expect(button()).toBeNull();
  });

  it("follows the selection through scrolling: visible → off screen → visible again", () => {
    act(() => {
      root.render(
        <TerminalFilterView lines={["one", "two"]} fontSize={13} fontFamily="monospace" isPty={false} />
      );
    });
    vi.spyOn(view(), "getBoundingClientRect").mockReturnValue(rect(0, 0, 500, 300));
    fakeSelection.isCollapsed = false;
    fakeSelection.rangeCount = 1;
    fakeSelection.anchorNode = view().querySelector("pre")!;
    fakeSelection.rects = [rect(120, 10)];
    drag();
    expect(button()!.style.top).toBe(`${120 - 22 - 4}px`);

    // Scrolling moves the selected line; the button tracks it.
    fakeSelection.rects = [rect(60, 10)];
    scroll();
    expect(button()!.style.top).toBe(`${60 - 22 - 4}px`);

    // Scrolled fully out of view → hidden…
    fakeSelection.rects = [rect(-40, 10)];
    scroll();
    expect(button()).toBeNull();

    // …and back in → shown again, with no new mouse interaction.
    fakeSelection.rects = [rect(200, 10)];
    scroll();
    expect(button()!.style.top).toBe(`${200 - 22 - 4}px`);
  });
});
