"use client";

import { useLayoutEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

/**
 * Jumps to the bottom instantly whenever the conversation fills from empty.
 *
 * Session history arrives after mount (REST pre-populate, or only the WS
 * Ready flush on session-cache hits), so use-stick-to-bottom treats it as
 * live content growth and spring-scrolls from the top with the `resize`
 * animation — visible as "show at top, then scroll down" when opening a
 * session from Cmd+K or a notification. Switching the `resize` prop on an
 * isInitialized flag can't fix the cache-hit path: the Ready handler batches
 * setMessages with setIsInitialized, so the history commits with the prop
 * already "smooth". Forcing an instant scroll on the empty→non-empty
 * transition covers all fill paths; the scroll applies on the rAF before the
 * next paint, so the first painted frame is already at the bottom, and the
 * ResizeObserver's own smooth scrollToBottom then finds nothing to animate.
 * The empty→non-empty guard keeps live streaming growth on the smooth path.
 */
export function InstantHistoryScroll({ messageCount }: { messageCount: number }) {
  const { scrollToBottom } = useStickToBottomContext();
  const wasEmptyRef = useRef(true);
  useLayoutEffect(() => {
    if (wasEmptyRef.current && messageCount > 0) {
      scrollToBottom({ animation: "instant" });
    }
    wasEmptyRef.current = messageCount === 0;
  }, [messageCount, scrollToBottom]);
  return null;
}
