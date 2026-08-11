"use client";

import { useLayoutEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { useFileNavigation } from "./file-navigation-context";

// How long an instant pin keeps re-snapping to the bottom. Markdown settles in
// phases after a fill or remount (placeholder → full height over ~1s measured),
// and each later growth would otherwise hand control back to the smooth resize
// animation — the visible "drift up, crawl back down". Passing `duration` keeps
// the instant animation alive so every growth inside the window snaps
// immediately; a user scrolling up still escapes it (ignoreEscapes is false).
const SETTLE_HOLD_MS = 1500;

/**
 * Pins the conversation to the bottom instantly (no smooth animation) in the
 * two situations where content height changes are load artifacts, not
 * streaming output:
 *
 * 1. History fill (empty → non-empty). History arrives after mount (REST
 *    pre-populate, or the WS Ready flush on cache hits), so use-stick-to-bottom
 *    treats it as live growth and spring-scrolls from the top. A `resize` prop
 *    switch can't fix the cache-hit path: the Ready handler batches setMessages
 *    with setIsInitialized, so the history commits with the prop already
 *    "smooth".
 * 2. File-ref index arrival. AgentMarkdown keys on `index.version`, so a
 *    late-loading index (remote projects fetch the file list over the tunnel
 *    and often lose the race) remounts every markdown block, which re-renders
 *    in phases and shifts the pinned viewport (~800px measured) before the
 *    smooth resize animation crawls back down. Only re-pin when already at the
 *    bottom — a user who scrolled up to read must not be yanked down.
 */
export function InstantHistoryScroll({ messageCount }: { messageCount: number }) {
  const { scrollToBottom, isAtBottom } = useStickToBottomContext();
  const { index } = useFileNavigation();
  const version = index?.version ?? null;
  const wasEmptyRef = useRef(true);
  const lastVersionRef = useRef(version);

  useLayoutEffect(() => {
    if (wasEmptyRef.current && messageCount > 0) {
      scrollToBottom({ animation: "instant", duration: SETTLE_HOLD_MS });
    }
    wasEmptyRef.current = messageCount === 0;
  }, [messageCount, scrollToBottom]);

  useLayoutEffect(() => {
    if (version === lastVersionRef.current) return;
    lastVersionRef.current = version;
    if (messageCount > 0 && isAtBottom) {
      scrollToBottom({ animation: "instant", duration: SETTLE_HOLD_MS });
    }
  }, [version, messageCount, isAtBottom, scrollToBottom]);

  return null;
}
