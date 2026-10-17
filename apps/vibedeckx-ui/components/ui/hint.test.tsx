// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hint } from "./hint";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix measures the open tooltip; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const tooltip = () => document.querySelector("[data-slot='tooltip-content']")?.textContent ?? null;
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("Hint", () => {
  let container: HTMLDivElement;
  let root: Root;
  let button: HTMLButtonElement;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Hint label="New Conversation"><button type="button">+</button></Hint>);
    });
    button = container.querySelector("button")!;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("shows on hover after a short delay", async () => {
    await act(async () => { button.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })); });
    expect(tooltip()).toBeNull();
    await wait(350);
    expect(tooltip()).toContain("New Conversation");
  });

  it("stays shut when focus comes back from a closed menu or dialog", async () => {
    // What a Radix menu/dialog does on close after a mouse interaction.
    button.matches = (selector: string) => selector !== ":focus-visible";
    await act(async () => { button.focus(); });
    await wait(350);
    expect(tooltip()).toBeNull();
  });

  it("shows on keyboard focus", async () => {
    button.matches = (selector: string) => selector === ":focus-visible";
    await act(async () => { button.focus(); });
    await wait(50);
    expect(tooltip()).toContain("New Conversation");
  });
});
