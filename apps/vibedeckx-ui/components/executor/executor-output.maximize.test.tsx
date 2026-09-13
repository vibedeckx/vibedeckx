// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExecutorOutput } from "./executor-output";
import { isInOverlay } from "@/components/locate/locate-context";

// xterm needs canvas + layout; the maximize toggle only needs a Terminal that
// can be opened, focused and disposed.
const focusCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    loadAddon() {}
    open() {}
    write(_d: string, cb?: () => void) { cb?.(); }
    onData() {}
    onResize() {}
    attachCustomKeyEventHandler() {}
    focus() { focusCalls.n++; }
    reset() {}
    scrollToBottom() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() { return { cols: 80, rows: 24 }; }
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  focusCalls.n = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

function layer() {
  return document.querySelector('[data-testid="executor-output-layer"]') as HTMLElement;
}

function toggle() {
  return document.querySelector(
    'button[aria-label="Maximize terminal"], button[aria-label="Restore terminal size"]'
  ) as HTMLButtonElement;
}

describe("ExecutorOutput maximize", () => {
  it("lifts the terminal into a fixed layer without remounting it, and restores", () => {
    act(() => {
      root!.render(<ExecutorOutput logs={[]} isPty={true} />);
    });
    const before = layer();
    expect(before.dataset.maximized).toBeUndefined();
    expect(before.className).toContain("absolute");
    const xtermHost = before.firstElementChild!.firstElementChild!;

    act(() => toggle().click());
    const after = layer();
    expect(after).toBe(before); // same DOM node → same xterm instance
    expect(after.dataset.maximized).toBe("true");
    expect(after.className).toContain("fixed");
    expect(after.firstElementChild!.firstElementChild).toBe(xtermHost);
    expect(toggle().getAttribute("aria-label")).toBe("Restore terminal size");
    // The inline slot advertises where the terminal went.
    expect(document.body.textContent).toContain("Terminal is maximized");
    // A PTY terminal gets keyboard focus when enlarged.
    expect(focusCalls.n).toBe(1);

    act(() => toggle().click());
    expect(layer().dataset.maximized).toBeUndefined();
    expect(document.body.textContent).not.toContain("Terminal is maximized");
  });

  it("restores on a click in the dimmed margin but not inside the terminal", () => {
    act(() => {
      root!.render(<ExecutorOutput logs={[]} isPty={false} />);
    });
    act(() => toggle().click());
    expect(layer().dataset.maximized).toBe("true");
    // Read-only output does not steal focus.
    expect(focusCalls.n).toBe(0);

    const inner = layer().firstElementChild as HTMLElement;
    act(() => {
      inner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(layer().dataset.maximized).toBe("true");

    act(() => {
      layer().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(layer().dataset.maximized).toBeUndefined();
  });

  it("counts as an overlay for the panel's global keyboard handlers", () => {
    // ExecutorPanel's window keydown handler (←/→ cycles the executor target,
    // ↑↓ moves the cursor) skips targets inside an overlay. The toggle button
    // keeps focus after the click, so it must sit inside such an overlay
    // while maximized — otherwise ArrowRight would switch targets and unmount
    // the maximized output.
    act(() => {
      root!.render(<ExecutorOutput logs={[]} isPty={false} />);
    });
    expect(isInOverlay(toggle())).toBe(false);

    act(() => toggle().click());
    expect(layer().getAttribute("role")).toBe("dialog");
    expect(isInOverlay(toggle())).toBe(true);
    const xtermHost = layer().firstElementChild!.firstElementChild!;
    expect(isInOverlay(xtermHost)).toBe(true);

    act(() => toggle().click());
    expect(layer().getAttribute("role")).toBeNull();
    expect(isInOverlay(toggle())).toBe(false);
  });
});
