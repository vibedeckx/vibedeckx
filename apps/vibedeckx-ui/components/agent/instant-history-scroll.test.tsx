// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToBottom = vi.fn();
vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({ scrollToBottom }),
}));

import { InstantHistoryScroll } from "./instant-history-scroll";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  scrollToBottom.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderCount(count: number) {
  await act(async () => {
    root!.render(<InstantHistoryScroll messageCount={count} />);
  });
}

describe("InstantHistoryScroll", () => {
  it("scrolls instantly when history fills from empty in one flush (cache-hit Ready path)", async () => {
    await renderCount(0);
    expect(scrollToBottom).not.toHaveBeenCalled();

    await renderCount(42);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledWith({ animation: "instant" });
  });

  it("does not re-fire on subsequent growth (live streaming stays smooth)", async () => {
    await renderCount(0);
    await renderCount(5);
    await renderCount(6);
    await renderCount(7);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the reset effect clears messages (session/workspace switch)", async () => {
    await renderCount(0);
    await renderCount(10);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);

    await renderCount(0); // reset effect: setMessages([])
    await renderCount(20); // next session's history fills in
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it("fires when mounted with history already present", async () => {
    await renderCount(10);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });
});
