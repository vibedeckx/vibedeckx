import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { findScrollParent } from "@/lib/scroll";

// Treat a marker within this many pixels of the viewport top as "current" so
// repeated Shift+Arrow presses keep advancing instead of re-selecting the
// marker that scrollIntoView just parked at the top edge. Must exceed the
// scroll-margin-top applied to message wrappers in agent-conversation.tsx
// (scroll-mt-2 = 8px), or Shift+Down re-selects the just-landed marker.
const TOP_EPSILON_PX = 12;

// How long the landed message stays highlighted, in ms.
const HIGHLIGHT_MS = 1000;

// After scrollIntoView, poll the scroll container until scrollTop stays put for
// this long, then treat the smooth scroll as complete. ~80ms (~5 frames @ 60Hz)
// lets the animation start without noticeably delaying the no-scroll-needed case.
const SCROLL_STABLE_MS = 80;
// Absolute cap on how long we'll wait for scroll completion before highlighting
// anyway, so a stuck or interrupted animation never swallows the visual feedback.
const SCROLL_POLL_TIMEOUT_MS = 1500;

interface MarkerNav {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  highlightedIndex: number | null;
}

/**
 * Keyboard navigation between user-input markers in the agent messages area.
 *
 * Shift+ArrowUp jumps to the nearest user message whose top is above the current
 * scroll-viewport top; Shift+ArrowDown to the nearest one below. Navigation is
 * scroll-position based (stateless) so it stays correct after manual scrolling.
 * Stops at the ends. The landed message index is reported via `highlightedIndex`
 * for a transient pulse, then cleared after HIGHLIGHT_MS.
 *
 * Attach `onKeyDown` to the messages container (made focusable with tabIndex={-1});
 * keydown events bubble from focused children, so it fires whenever focus is within
 * the messages area.
 */
export function useMarkerKeyboardNav(
  contentRef: RefObject<HTMLDivElement | null>
): MarkerNav {
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScrollEndRef = useRef<(() => void) | null>(null);

  // Clear any pending highlight timer and scroll-end watcher on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      pendingScrollEndRef.current?.();
    };
  }, []);

  const triggerHighlight = useCallback((index: number) => {
    setHighlightedIndex(index);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHighlightedIndex(null), HIGHLIGHT_MS);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;

      const contentEl = contentRef.current;
      if (!contentEl) return;
      const scrollEl = findScrollParent(contentEl);
      if (!scrollEl) return;

      const scrollRect = scrollEl.getBoundingClientRect();
      const viewTop = scrollEl.scrollTop;
      const goUp = event.key === "ArrowUp";

      let target: HTMLElement | null = null;
      let targetTop = goUp ? -Infinity : Infinity;

      const els = contentEl.querySelectorAll<HTMLElement>("[data-user-msg-idx]");
      els.forEach((el) => {
        const elRect = el.getBoundingClientRect();
        const top = elRect.top - scrollRect.top + scrollEl.scrollTop;
        if (goUp) {
          // Nearest marker above the viewport top: largest top still < viewTop.
          if (top < viewTop - TOP_EPSILON_PX && top > targetTop) {
            targetTop = top;
            target = el;
          }
        } else {
          // Nearest marker below the viewport top: smallest top still > viewTop.
          if (top > viewTop + TOP_EPSILON_PX && top < targetTop) {
            targetTop = top;
            target = el;
          }
        }
      });

      // Stop at the ends — nothing further in this direction.
      if (!target) return;

      // We're handling the keystroke now; suppress the default selection-extension.
      event.preventDefault();

      const targetEl = target as HTMLElement;
      const idx = Number.parseInt(targetEl.dataset.userMsgIdx ?? "", 10);

      // Cancel any prior scroll-end watcher so a rapid follow-up keypress doesn't
      // fire a stale-index highlight when its scroll happens to land.
      pendingScrollEndRef.current?.();

      targetEl.scrollIntoView({ block: "start", behavior: "smooth" });

      if (Number.isNaN(idx)) return;

      // Defer the highlight until the smooth scroll actually finishes — for long
      // jumps the 1s fade can otherwise run out before the user sees the target.
      const startTime = performance.now();
      let lastTop = scrollEl.scrollTop;
      let stableSince = startTime;
      let frameId = 0;

      const tick = (now: number) => {
        const currentTop = scrollEl.scrollTop;
        if (currentTop !== lastTop) {
          lastTop = currentTop;
          stableSince = now;
        }
        const settled = now - stableSince >= SCROLL_STABLE_MS;
        const timedOut = now - startTime >= SCROLL_POLL_TIMEOUT_MS;
        if (settled || timedOut) {
          pendingScrollEndRef.current = null;
          triggerHighlight(idx);
          return;
        }
        frameId = requestAnimationFrame(tick);
      };
      frameId = requestAnimationFrame(tick);

      pendingScrollEndRef.current = () => {
        cancelAnimationFrame(frameId);
        pendingScrollEndRef.current = null;
      };
    },
    [contentRef, triggerHighlight]
  );

  return { onKeyDown, highlightedIndex };
}
