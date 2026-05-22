"use client";

import { useEffect } from "react";

/**
 * Adds the `scrolling` class to <html> while any scroll container is actively
 * scrolling and removes it shortly after scrolling stops. globals.css uses this
 * to deepen the scrollbar thumb (faint at rest → solid rgb(127,127,127) while
 * scrolling). Renders nothing.
 */
export function ScrollActivity() {
  useEffect(() => {
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const handleScroll = () => {
      root.classList.add("scrolling");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => root.classList.remove("scrolling"), 600);
    };

    // Capture phase so scrolls inside any nested container are caught (scroll
    // events don't bubble).
    const options: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("scroll", handleScroll, options);
    return () => {
      window.removeEventListener("scroll", handleScroll, options);
      if (timer) clearTimeout(timer);
      root.classList.remove("scrolling");
    };
  }, []);

  return null;
}
