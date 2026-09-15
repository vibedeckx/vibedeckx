// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
} from "./prompt-input";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Radix's menu machinery expects browser APIs jsdom does not implement.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (el) => el.textContent?.includes(label),
  );

describe("PromptInputActionAddAttachments", () => {
  it("opens the file picker and then closes the menu", async () => {
    const picks: string[] = [];
    await act(async () => {
      root.render(
        <PromptInput onSubmit={async () => {}}>
          <PromptInputActionMenu defaultOpen>
            <PromptInputActionMenuTrigger />
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments label="Add files" />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
          <textarea name="message" />
        </PromptInput>,
      );
    });

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    // jsdom would try to open nothing at all; just record the call.
    fileInput.addEventListener("click", (e) => {
      e.preventDefault();
      picks.push("open");
    });

    const item = menuItem("Add files");
    expect(item).toBeTruthy();

    await act(async () => {
      item!.click();
    });
    // The picker opens inside the gesture, while the menu is still up.
    expect(picks).toEqual(["open"]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(menuItem("Add files")).toBeUndefined();
  });
});
