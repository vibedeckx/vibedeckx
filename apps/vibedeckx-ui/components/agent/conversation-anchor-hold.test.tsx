// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileRefIndex } from "@/lib/file-ref/file-ref-index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToBottom = vi.fn();
const stickCtx = {
  scrollToBottom,
  isAtBottom: true,
  scrollRef: { current: null },
  contentRef: { current: null },
};
vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => stickCtx,
}));

import { ConversationAnchorHold, shouldHoldBottom } from "./conversation-anchor-hold";
import { FileNavigationProvider } from "./file-navigation-context";

function fakeIndex(version: string): FileRefIndex {
  return { version, resolve: () => [] } as unknown as FileRefIndex;
}

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

async function renderWith(count: number, index: FileRefIndex | null = null, turnInFlight = false) {
  await act(async () => {
    root!.render(
      <FileNavigationProvider value={{ openFile: () => {}, index }}>
        <ConversationAnchorHold messageCount={count} turnInFlight={turnInFlight} />
      </FileNavigationProvider>
    );
  });
}

describe("ConversationAnchorHold — history fill pin", () => {
  it("pins instantly when history fills from empty in one flush (cache-hit Ready path)", async () => {
    await renderWith(0);
    expect(scrollToBottom).not.toHaveBeenCalled();

    await renderWith(42);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledWith({ animation: "instant" });
  });

  it("pins on fill regardless of a turn being in flight (active-session deep-link)", async () => {
    await renderWith(0, null, true);
    await renderWith(42, null, true);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire on subsequent growth (live streaming stays smooth)", async () => {
    await renderWith(0);
    await renderWith(5);
    await renderWith(6);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the reset effect clears messages (session/workspace switch)", async () => {
    await renderWith(0);
    await renderWith(10);
    await renderWith(0);
    await renderWith(20);
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it("does not scroll on index arrival alone — mid-list readers must not be yanked", async () => {
    await renderWith(0);
    await renderWith(10);
    scrollToBottom.mockClear();

    await renderWith(10, fakeIndex("idx-1"));
    await renderWith(10, fakeIndex("idx-2"));
    expect(scrollToBottom).not.toHaveBeenCalled();
  });
});

describe("shouldHoldBottom — hold vs smooth-follow decision", () => {
  it("holds during settle even while a turn is in flight (opening a running session)", () => {
    expect(shouldHoldBottom({ settling: true, turnInFlight: true, wasAtBottom: true })).toBe(true);
  });

  it("holds any post-settle growth when no turn is in flight (late images/highlighting)", () => {
    expect(shouldHoldBottom({ settling: false, turnInFlight: false, wasAtBottom: true })).toBe(true);
  });

  it("leaves streaming into a stable view to the smooth follow", () => {
    expect(shouldHoldBottom({ settling: false, turnInFlight: true, wasAtBottom: true })).toBe(false);
  });

  it("never forces a mid-list reader to the bottom", () => {
    expect(shouldHoldBottom({ settling: true, turnInFlight: false, wasAtBottom: false })).toBe(false);
    expect(shouldHoldBottom({ settling: false, turnInFlight: false, wasAtBottom: false })).toBe(false);
  });
});
