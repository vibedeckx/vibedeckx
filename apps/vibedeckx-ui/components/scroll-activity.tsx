"use client";

import { useEffect } from "react";

/**
 * Adds the `scrolling` class to the element that is actively scrolling and
 * removes it shortly after that element stops. globals.css uses this to deepen
 * the scrollbar thumb (faint at rest → solid rgb(127,127,127) while scrolling)
 * for only the scrolled container, not every scrollbar on the page. Renders
 * nothing.
 */
export function ScrollActivity() {
  useEffect(() => {
    // Per-element timers so each container fades independently. WeakMap lets
    // detached elements be garbage-collected.
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

    const handleScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof Element)) return; // ignore document/window scrolls

      el.classList.add("scrolling");
      const prev = timers.get(el);
      if (prev) clearTimeout(prev);
      timers.set(
        el,
        setTimeout(() => el.classList.remove("scrolling"), 600)
      );
    };

    // Capture phase so scrolls inside any nested container are caught (scroll
    // events don't bubble).
    const options: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("scroll", handleScroll, options);
    return () => window.removeEventListener("scroll", handleScroll, options);
  }, []);

  return null;
}
