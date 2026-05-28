import { useCallback, type KeyboardEvent, type RefObject } from "react";
import { findScrollParent } from "@/lib/scroll";

// Treat a marker within this many pixels of the viewport top as "current" so
// repeated Shift+Arrow presses keep advancing instead of re-selecting the
// marker that scrollIntoView just parked at the top edge. Must exceed the
// scroll-margin-top applied to message wrappers in agent-conversation.tsx
// (scroll-mt-2 = 8px), or Shift+Down re-selects the just-landed marker.
const TOP_EPSILON_PX = 12;

/**
 * Keyboard navigation between user-input markers in the agent messages area.
 *
 * Shift+ArrowUp jumps to the nearest user message whose top is above the current
 * scroll-viewport top; Shift+ArrowDown to the nearest one below. Navigation is
 * scroll-position based (stateless) so it stays correct after manual scrolling.
 * Stops at the ends.
 *
 * Attach the returned handler to the messages container (made focusable with
 * tabIndex={-1}); keydown events bubble from focused children, so it fires
 * whenever focus is within the messages area.
 */
export function useMarkerKeyboardNav(
  contentRef: RefObject<HTMLDivElement | null>
): (event: KeyboardEvent<HTMLElement>) => void {
  return useCallback(
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

      (target as HTMLElement).scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [contentRef]
  );
}
