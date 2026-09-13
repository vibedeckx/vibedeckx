// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExecutorOutput } from "./executor-output";

// Terminal stub with a controllable selection (buffer coordinates, like the
// real getSelectionPosition) and a DOM-renderer-style `.xterm-rows` layer of
// fixed-size row elements. Placement reads these synchronously — no frames.
const ROWS = 5;
const COLS = 80;
const ROW_H = 16;
const ROWS_TOP = 90;
const ROWS_LEFT = 60;
const ROWS_W = 800; // → 10px per cell

const fake = vi.hoisted(() => ({
  selection: null as { start: { x: number; y: number }; end: { x: number; y: number } } | null,
  viewportY: 0,
  text: "",
  selectionListeners: [] as Array<() => void>,
  scrollListeners: [] as Array<() => void>,
  element: null as HTMLElement | null,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 5;
    options = {};
    buffer = {
      active: {
        length: 0,
        getLine: () => undefined,
        get viewportY() {
          return fake.viewportY;
        },
      },
    };
    element: HTMLElement | undefined;
    loadAddon() {}
    open() {
      this.element = fake.element ?? undefined;
    }
    write(_d: string, cb?: () => void) { cb?.(); }
    onData() {}
    onResize() {}
    onWriteParsed() { return { dispose() {} }; }
    onSelectionChange(cb: () => void) { fake.selectionListeners.push(cb); }
    onScroll(cb: () => void) { fake.scrollListeners.push(cb); }
    hasSelection() { return fake.selection !== null; }
    getSelectionPosition() { return fake.selection ?? undefined; }
    getSelection() { return fake.text; }
    attachCustomKeyEventHandler() {}
    focus() {}
    reset() {}
    scrollToBottom() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() { return { cols: 80, rows: 5 }; }
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@/hooks/use-terminal-settings", () => ({
  useTerminalSettings: () => ({
    settings: { fontSize: 13, fontFamily: "monospace", scrollback: 1000 },
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rect = (top: number, left: number, w: number, h: number): DOMRect =>
  ({ top, left, width: w, height: h, bottom: top + h, right: left + w, x: left, y: top, toJSON() {} }) as DOMRect;

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

  fake.element = document.createElement("div");
  const rowsLayer = document.createElement("div");
  rowsLayer.className = "xterm-rows";
  for (let i = 0; i < ROWS; i++) {
    const row = document.createElement("div");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
      rect(ROWS_TOP + i * ROW_H, ROWS_LEFT, ROWS_W, ROW_H)
    );
    rowsLayer.appendChild(row);
  }
  fake.element.appendChild(rowsLayer);
  fake.selection = null;
  fake.viewportY = 0;
  fake.text = "";
  fake.selectionListeners = [];
  fake.scrollListeners = [];

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const button = () =>
  document.querySelector('[data-testid="selection-copy-button"]') as HTMLButtonElement | null;
const xtermHost = () =>
  document.querySelector('[data-testid="executor-output-layer"]')!.firstElementChild!
    .firstElementChild as HTMLElement;
const HOST = rect(50, 20, 600, 400);
// Expected anchor for a cell at viewport row `row`, column `col`.
const expectedTop = (row: number) => `${ROWS_TOP + row * ROW_H - HOST.top - 22 - 4}px`;
const expectedLeft = (col: number) => `${ROWS_LEFT + col * (ROWS_W / COLS) - HOST.left}px`;

function mount() {
  act(() => {
    root.render(<ExecutorOutput logs={[]} isPty={false} />);
  });
  vi.spyOn(xtermHost().parentElement!, "getBoundingClientRect").mockReturnValue(HOST);
}
const fireSelection = () => act(() => fake.selectionListeners.forEach((l) => l()));
const fireScroll = () => act(() => fake.scrollListeners.forEach((l) => l()));

describe("ExecutorOutput selection copy", () => {
  it("shows the button after a drag ends, at the selection's start cell, and copies", async () => {
    mount();
    // Drag starts: nothing shows even though xterm reports a selection.
    act(() => xtermHost().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    fake.selection = { start: { x: 12, y: 2 }, end: { x: 30, y: 3 } };
    fake.text = "selected text";
    fireSelection();
    expect(button()).toBeNull();

    // Drag ends (anywhere in the window): anchored above row 2, column 12.
    act(() => window.dispatchEvent(new PointerEvent("pointerup")));
    const btn = button()!;
    expect(btn).not.toBeNull();
    expect(btn.style.top).toBe(expectedTop(2));
    expect(btn.style.left).toBe(expectedLeft(12));

    await act(async () => btn.click());
    expect(writeText).toHaveBeenCalledWith("selected text");
    expect(button()).toBeNull();
  });

  it("re-anchors from buffer coordinates on scroll, and hides when cleared", () => {
    mount();
    // Selection lives at absolute buffer rows 102–103 while the viewport
    // starts at row 100 → viewport row 2.
    fake.viewportY = 100;
    fake.selection = { start: { x: 5, y: 102 }, end: { x: 9, y: 103 } };
    fake.text = "x";
    fireSelection();
    expect(button()!.style.top).toBe(expectedTop(2));
    expect(button()!.style.left).toBe(expectedLeft(5));

    // Scroll down one row → the same selection now starts at viewport row 1.
    fake.viewportY = 101;
    fireScroll();
    expect(button()!.style.top).toBe(expectedTop(1));

    // First selected row scrolled above the viewport but the last is still
    // visible → anchor at the top row, column 0.
    fake.viewportY = 103;
    fireScroll();
    expect(button()!.style.top).toBe(expectedTop(0));
    expect(button()!.style.left).toBe(expectedLeft(0));

    // Whole selection above the viewport → no button.
    fake.viewportY = 104;
    fireScroll();
    expect(button()).toBeNull();

    // Whole selection below the viewport (rows 0–4 show 90–94) → no button.
    fake.viewportY = 90;
    fireScroll();
    expect(button()).toBeNull();

    // Scrolled back into view.
    fake.viewportY = 100;
    fireScroll();
    expect(button()).not.toBeNull();

    fake.selection = null;
    fireSelection();
    expect(button()).toBeNull();
  });
});
