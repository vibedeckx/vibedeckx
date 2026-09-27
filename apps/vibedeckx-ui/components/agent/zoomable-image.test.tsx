// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ZoomableImage, clampView, zoomAt, MAX_SCALE } from "./zoomable-image";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = "data:image/png;base64,AAAA";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ZoomableImage src={SRC} alt="Shot" className="max-w-sm" />));
  const trigger = container.querySelector("button")!;
  act(() => trigger.click());
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const layer = () => document.querySelector<HTMLElement>('[data-testid="image-lightbox-layer"]')!;

describe("ZoomableImage", () => {
  it("opens the image in a terminal-sized lightbox panel on click", () => {
    mount();
    expect(dialog()).not.toBeNull();
    expect(layer().querySelector("img")!.getAttribute("src")).toBe(SRC);
    const panel = document.querySelector('[data-testid="image-lightbox-panel"]')!;
    expect(panel.className).toContain("max-w-6xl");
    expect(panel.className).toContain("max-h-[85vh]");
  });

  it("closes on Escape", () => {
    mount();
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it("closes when the dimmed margin is pressed, not the panel", () => {
    mount();
    const panel = document.querySelector<HTMLElement>('[data-testid="image-lightbox-panel"]')!;
    act(() => panel.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(dialog()).not.toBeNull();
    act(() => dialog()!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(dialog()).toBeNull();
  });

  it("zooms in on wheel-up and resets on double-click", () => {
    mount();
    const panel = document.querySelector<HTMLElement>('[data-testid="image-lightbox-panel"]')!;
    act(() => {
      panel.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true, cancelable: true }));
    });
    expect(layer().style.transform).toMatch(/scale\(1\.[0-9]+\)/);
    act(() => panel.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(layer().style.transform).toContain("scale(1)");
  });
});

describe("zoom math", () => {
  it("keeps the point under the cursor fixed", () => {
    const v = zoomAt({ scale: 1, x: 0, y: 0 }, 100, 50, 2, 400, 300);
    expect(v).toEqual({ scale: 2, x: -100, y: -50 });
    // the image point that was at (100,50) is still at (100,50)
    expect(100 * v.scale + v.x).toBe(100);
  });

  it("clamps scale and keeps the image covering the panel", () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0, 0, 0.2, 400, 300).scale).toBe(1);
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0, 0, 100, 400, 300).scale).toBe(MAX_SCALE);
    expect(clampView({ scale: 2, x: 50, y: -1000 }, 400, 300)).toEqual({ scale: 2, x: 0, y: -300 });
  });
});
