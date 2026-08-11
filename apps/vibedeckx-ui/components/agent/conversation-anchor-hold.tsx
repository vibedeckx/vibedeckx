"use client";

import { useLayoutEffect, useEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { useFileNavigation } from "./file-navigation-context";

// A settle window stays open while content heights are still changing and
// closes after this much quiet. Measured on real sessions: markdown renders in
// phases (placeholder → full) for ~1s at normal speed, longer when throttled —
// a fixed-length hold loses that race, which is why this is quiet-based.
const SETTLE_QUIET_MS = 600;
// Safety cap so a perpetually-animating block can't hold the conversation in
// settle mode forever.
const SETTLE_MAX_MS = 8000;

// ---- Field diagnostics -----------------------------------------------------
// The occasional jump has had several plausible mechanisms (index remount,
// slow settle, hidden-panel collapse); attribution needs a captured timeline,
// not inference. Ring buffer, zero console output in normal operation; on an
// anomaly (we expected to hold the bottom but ended up displaced) the recent
// timeline is dumped via console.warn. Manual dump: window.__vdxScrollDiag.dump()
type DiagEvent = { t: number; ev: string } & Record<string, unknown>;
const DIAG_MAX = 200;
const diagBuf: DiagEvent[] = [];
function diag(ev: string, data: Record<string, unknown> = {}) {
  diagBuf.push({ t: Math.round(performance.now()), ev, ...data });
  if (diagBuf.length > DIAG_MAX) diagBuf.shift();
}
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__vdxScrollDiag = {
    buf: diagBuf,
    dump: () => console.table(diagBuf),
  };
}

export interface AnchorHoldDecisionInput {
  settling: boolean;
  turnInFlight: boolean;
  wasAtBottom: boolean;
}

// Exported for unit tests: whether a content-growth event should be corrected
// synchronously (true) or left to the library's smooth follow (false).
// - While settling (history fill / file-ref remount still playing out), hold
//   regardless of turn state — this covers opening a session mid-turn, where
//   the load artifacts must not crawl even though a turn is in flight.
// - Outside settling, hold whenever no turn is in flight: any growth then
//   (late images, highlighting) is a load artifact, never streaming output.
// - A turn streaming into a stable view keeps the library's smooth follow.
export function shouldHoldBottom({ settling, turnInFlight, wasAtBottom }: AnchorHoldDecisionInput): boolean {
  if (!wasAtBottom) return false;
  return settling || !turnInFlight;
}

/**
 * Keeps the conversation viewport stable through load-artifact height changes,
 * with zero painted displacement.
 *
 * Why the library alone can't do this: use-stick-to-bottom corrects resizes
 * via requestAnimationFrame, so the displaced layout paints for a frame before
 * the correction lands (and with `resize="smooth"` it then visibly crawls).
 * This component attaches its own ResizeObserver to the content element —
 * ResizeObserver callbacks run after layout but BEFORE paint, so assigning
 * scrollTop synchronously inside the callback means the displaced position is
 * never painted.
 *
 * Anchoring rules:
 * - Pinned at the bottom → stay glued to the bottom.
 * - Mid-list (user scrolled up, or returned to a preserved position) → during
 *   the settle window, keep the topmost visible message at a fixed viewport
 *   offset instead. The anchor is the `[data-message-idx]` wrapper, whose
 *   identity survives the file-ref remount (browser-native scroll anchoring
 *   loses its anchor there because the inner nodes are replaced). Never
 *   scrolls a mid-list reader to the bottom.
 *
 * The settle window arms on history fill and on file-ref index arrival, and
 * closes after SETTLE_QUIET_MS without height changes.
 */
export function ConversationAnchorHold({
  messageCount,
  turnInFlight,
}: {
  messageCount: number;
  turnInFlight: boolean;
}) {
  const { scrollToBottom, scrollRef, contentRef } = useStickToBottomContext();
  const { index } = useFileNavigation();
  const version = index?.version ?? null;

  const stateRef = useRef({
    turnInFlight,
    settleDeadline: 0,
    settleHardCap: 0,
    prevScrollHeight: 0,
  });
  stateRef.current.turnInFlight = turnInFlight;

  const armSettle = () => {
    const now = performance.now();
    stateRef.current.settleDeadline = now + SETTLE_QUIET_MS;
    stateRef.current.settleHardCap = now + SETTLE_MAX_MS;
  };

  const isSettling = () => {
    const s = stateRef.current;
    const now = performance.now();
    return now < s.settleDeadline && now < s.settleHardCap;
  };

  const wasEmptyRef = useRef(true);
  const lastVersionRef = useRef(version);

  // History fill: one-shot instant pin (the content goes 0 → full, so there is
  // no meaningful prior position to preserve) + open the settle window.
  useLayoutEffect(() => {
    if (wasEmptyRef.current && messageCount > 0) {
      armSettle();
      diag("fill", { messageCount });
      scrollToBottom({ animation: "instant" });
    }
    wasEmptyRef.current = messageCount === 0;
  }, [messageCount, scrollToBottom]);

  // File-ref index arrival: the remount's height churn is about to start.
  useLayoutEffect(() => {
    if (version === lastVersionRef.current) return;
    lastVersionRef.current = version;
    diag("index-version", { version, messageCount });
    if (messageCount > 0) armSettle();
  }, [version, messageCount]);

  // The synchronous pre-paint hold.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === "undefined") return;

    stateRef.current.prevScrollHeight = scroller.scrollHeight;

    // Mid-list anchor, refreshed on every scroll (user scrolls → new anchor;
    // our own corrections re-derive the same anchor, which is a no-op).
    let anchor: { el: HTMLElement; offset: number } | null = null;
    let lastScrollTop = scroller.scrollTop;
    const refreshAnchor = () => {
      const top = scroller.scrollTop;
      // Large discontinuities (collapse clamps, programmatic jumps) are prime
      // suspects for the reported jumps — record them with both endpoints.
      if (Math.abs(top - lastScrollTop) > 40) {
        diag("scroll-jump", { from: Math.round(lastScrollTop), to: Math.round(top) });
      }
      lastScrollTop = top;
      anchor = null;
      for (const el of content.querySelectorAll<HTMLElement>("[data-message-idx]")) {
        if (el.offsetTop + el.offsetHeight > top) {
          anchor = { el, offset: el.offsetTop - top };
          break;
        }
      }
    };
    refreshAnchor();
    scroller.addEventListener("scroll", refreshAnchor, { passive: true });

    // Per-message height cache so the diagnostics can name which entries grew.
    const msgHeights = new Map<string, number>();
    const diffMessageHeights = () => {
      const changed: Array<{ idx: string; from: number; to: number }> = [];
      for (const el of content.querySelectorAll<HTMLElement>("[data-message-idx]")) {
        const idx = el.getAttribute("data-message-idx") ?? "?";
        const h = el.offsetHeight;
        const old = msgHeights.get(idx);
        if (old !== undefined && Math.abs(old - h) > 2) changed.push({ idx, from: old, to: h });
        msgHeights.set(idx, h);
      }
      changed.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
      return changed.slice(0, 4);
    };

    const ro = new ResizeObserver(() => {
      const s = stateRef.current;
      const prev = s.prevScrollHeight;
      const next = scroller.scrollHeight;
      s.prevScrollHeight = next;
      if (Math.abs(next - prev) <= 1) return;
      const settling = isSettling();
      if (settling) armSettle(); // still churning — extend the quiet window
      const wasAtBottom = scroller.scrollTop + scroller.clientHeight >= prev - 6;
      const hold = shouldHoldBottom({ settling, turnInFlight: s.turnInFlight, wasAtBottom });

      if (hold) {
        scroller.scrollTop = next; // clamps to max; synchronous, pre-paint
      } else if (!wasAtBottom && settling && anchor?.el.isConnected) {
        // Mid-list reader during settle churn: keep the anchored message at its
        // viewport offset. Outside settling, native scroll anchoring suffices.
        scroller.scrollTop = anchor.el.offsetTop - anchor.offset;
      }

      const distAfter = next - scroller.clientHeight - scroller.scrollTop;
      diag("resize", {
        prev, next,
        clientH: scroller.clientHeight,
        scrollTop: Math.round(scroller.scrollTop),
        settling, turnInFlight: s.turnInFlight, wasAtBottom,
        action: hold ? "hold-bottom" : "none",
        distAfter: Math.round(distAfter),
        grew: diffMessageHeights(),
      });
      // Anomaly: we were pinned and expected stability, yet ended up displaced.
      // Streaming smooth-follow (turn in flight, not settling) is exempt.
      if (wasAtBottom && distAfter > 50 && !(s.turnInFlight && !settling)) {
        console.warn("[vdx-scroll] displaced while pinned — recent timeline:", diagBuf.slice(-30));
      }
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      scroller.removeEventListener("scroll", refreshAnchor);
    };
  }, [scrollRef, contentRef]);

  return null;
}
