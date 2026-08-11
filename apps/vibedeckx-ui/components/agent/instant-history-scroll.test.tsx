// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileRefIndex } from "@/lib/file-ref/file-ref-index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToBottom = vi.fn();
const stickCtx = { scrollToBottom, isAtBottom: true };
vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => stickCtx,
}));

import { InstantHistoryScroll } from "./instant-history-scroll";
import { FileNavigationProvider } from "./file-navigation-context";

const INSTANT_PIN = { animation: "instant", duration: expect.any(Number) };

function fakeIndex(version: string): FileRefIndex {
  return { version, resolve: () => [] } as unknown as FileRefIndex;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  scrollToBottom.mockClear();
  stickCtx.isAtBottom = true;
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

async function renderWith(count: number, index: FileRefIndex | null = null) {
  await act(async () => {
    root!.render(
      <FileNavigationProvider value={{ openFile: () => {}, index }}>
        <InstantHistoryScroll messageCount={count} />
      </FileNavigationProvider>
    );
  });
}

describe("InstantHistoryScroll — history fill", () => {
  it("pins instantly when history fills from empty in one flush (cache-hit Ready path)", async () => {
    await renderWith(0);
    expect(scrollToBottom).not.toHaveBeenCalled();

    await renderWith(42);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledWith(INSTANT_PIN);
  });

  it("does not re-fire on subsequent growth (live streaming stays smooth)", async () => {
    await renderWith(0);
    await renderWith(5);
    await renderWith(6);
    await renderWith(7);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the reset effect clears messages (session/workspace switch)", async () => {
    await renderWith(0);
    await renderWith(10);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);

    await renderWith(0); // reset effect: setMessages([])
    await renderWith(20); // next session's history fills in
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it("fires when mounted with history already present", async () => {
    await renderWith(10);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });
});

describe("InstantHistoryScroll — file-ref index arrival", () => {
  it("re-pins instantly when the index version changes while at the bottom", async () => {
    await renderWith(0);
    await renderWith(10); // fill pin
    scrollToBottom.mockClear();

    await renderWith(10, fakeIndex("idx-1")); // late index → markdown remount
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledWith(INSTANT_PIN);

    await renderWith(10, fakeIndex("idx-2")); // index refresh → remount again
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
  });

  it("does not yank down a user who scrolled up to read", async () => {
    await renderWith(0);
    await renderWith(10);
    scrollToBottom.mockClear();

    stickCtx.isAtBottom = false;
    await renderWith(10, fakeIndex("idx-1"));
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("ignores index arrival while the conversation is still empty", async () => {
    await renderWith(0);
    await renderWith(0, fakeIndex("idx-1"));
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("does not fire when mounting with the index already present", async () => {
    await renderWith(0, fakeIndex("idx-1"));
    await renderWith(10, fakeIndex("idx-1")); // fill pin only
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });
});
