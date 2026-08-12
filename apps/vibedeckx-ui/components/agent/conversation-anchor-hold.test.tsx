// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileRefIndex } from "@/lib/file-ref/file-ref-index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToBottom = vi.fn();
// A stand-in scroller: scrollTop clamps to the scrollable range the way a real
// element does, so a pin can be asserted as a position rather than a call.
const scroller = {
  scrollHeight: 13867,
  clientHeight: 1050,
  _top: 1632,
  get scrollTop() {
    return this._top;
  },
  set scrollTop(v: number) {
    this._top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
  },
};
const stickCtx = {
  scrollToBottom,
  isAtBottom: true,
  scrollRef: { current: scroller },
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
  scroller._top = 1632;
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

async function renderWith(
  count: number,
  index: FileRefIndex | null = null,
  turnInFlight = false,
  sessionId: string | null = "s1"
) {
  await act(async () => {
    root!.render(
      <FileNavigationProvider value={{ openFile: () => {}, index }}>
        <ConversationAnchorHold messageCount={count} turnInFlight={turnInFlight} sessionId={sessionId} />
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

describe("ConversationAnchorHold — session switch pin", () => {
  // The cached-transcript preview swaps session and messages in one commit, so
  // the count never passes through 0 and the fill pin never arms. Without a pin
  // of its own the old offset survives into the new (taller) transcript and the
  // library's rAF correction only reaches the bottom frames later — a painted
  // mid-conversation flash.
  it("pins to the bottom when a warm cache swaps the transcript in one commit", async () => {
    await renderWith(28, null, false, "s1");
    scrollToBottom.mockClear();
    scroller._top = 1632;

    await renderWith(117, null, false, "s2");

    expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
    expect(scrollToBottom).toHaveBeenCalledWith({ animation: "instant" });
  });

  it("leaves the scroller alone when the switch has no cached transcript", async () => {
    await renderWith(28, null, false, "s1");
    scrollToBottom.mockClear();
    scroller._top = 1632;

    // Cache miss: the reset clears messages, and the fill pin owns the landing.
    await renderWith(0, null, false, "s2");

    expect(scroller.scrollTop).toBe(1632);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it("pins exactly once across a cache-miss switch (old → empty → new)", async () => {
    await renderWith(28, null, false, "s1");
    scrollToBottom.mockClear();
    scroller._top = 1632;

    // The reset commit clears messages and the session, then the fetched
    // transcript arrives with the new session id — both triggers at once.
    await renderWith(0, null, false, null);
    await renderWith(117, null, false, "s2");

    expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("opens at the latest turn even when the reader left the old session mid-list", async () => {
    // Deliberate, not incidental: the retained offset points into a different
    // transcript, so honouring it lands the reader at an arbitrary point in a
    // conversation they have not read. A warm cache must land where a cold one
    // does. Mid-list protection covers growth within an open transcript, which
    // the shouldHoldBottom cases below own.
    await renderWith(117, null, false, "s1");
    scroller._top = 400; // reader scrolled up in s1
    scrollToBottom.mockClear();

    await renderWith(28, null, false, "s2");

    expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
  });

  it("does not re-pin while the same session grows (streaming must stay free)", async () => {
    await renderWith(28, null, false, "s1");
    scrollToBottom.mockClear();
    scroller._top = 1632;

    await renderWith(29, null, true, "s1");

    expect(scroller.scrollTop).toBe(1632);
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
