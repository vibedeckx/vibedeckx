"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Quote } from "lucide-react";

/**
 * Format a free-form selection as a Markdown blockquote. Each line is
 * prefixed with "> " so multi-line selections render as a single quote
 * block. A trailing blank line is appended so the caret lands on a fresh
 * line below the quote.
 */
export function formatAsQuote(text: string): string {
  return text.replace(/\r?\n/g, "\n").split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
}

interface QuotePopoverProps {
  containerRef: React.RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
}

interface SelectionState {
  text: string;
  rect: { top: number; bottom: number; left: number; width: number };
}

/**
 * Walk up from `node` until we find an element with `data-message-idx`.
 * Returns the value of the attribute, or null if none is found before
 * reaching `boundary` (or the document root).
 */
function findMessageIdx(node: Node | null, boundary: HTMLElement): string | null {
  let cur: Node | null = node;
  while (cur && cur !== boundary) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const idx = (cur as HTMLElement).getAttribute("data-message-idx");
      if (idx !== null) return idx;
    }
    cur = cur.parentNode;
  }
  return null;
}

export function QuotePopover({ containerRef, onQuote }: QuotePopoverProps) {
  const [sel, setSel] = useState<SelectionState | null>(null);

  useEffect(() => {
    function recompute() {
      const container = containerRef.current;
      if (!container) {
        setSel(null);
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSel(null);
        return;
      }
      const text = selection.toString();
      if (!text.trim()) {
        setSel(null);
        return;
      }
      const { anchorNode, focusNode } = selection;
      if (!anchorNode || !focusNode) {
        setSel(null);
        return;
      }
      if (!container.contains(anchorNode) || !container.contains(focusNode)) {
        setSel(null);
        return;
      }
      const anchorIdx = findMessageIdx(anchorNode, container);
      const focusIdx = findMessageIdx(focusNode, container);
      if (anchorIdx === null || focusIdx === null || anchorIdx !== focusIdx) {
        setSel(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSel(null);
        return;
      }
      setSel({
        text,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      });
    }

    // Hide-only handler: collapses the popover the instant the user clears the
    // selection (click elsewhere, etc.) without ever showing it mid-drag.
    function maybeHide() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        setSel(null);
      }
    }

    // Show on selection finalization, not on every selectionchange tick.
    document.addEventListener("mouseup", recompute);
    document.addEventListener("keyup", recompute);
    document.addEventListener("touchend", recompute);
    document.addEventListener("selectionchange", maybeHide);
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    return () => {
      document.removeEventListener("mouseup", recompute);
      document.removeEventListener("keyup", recompute);
      document.removeEventListener("touchend", recompute);
      document.removeEventListener("selectionchange", maybeHide);
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
    };
  }, [containerRef]);

  if (!sel) return null;
  if (typeof document === "undefined") return null;

  // Position centered above the selection. If the top would be off-screen,
  // flip below. Clamp horizontally to the viewport.
  const BTN_GAP = 8;
  const BTN_HEIGHT = 28;
  const flipBelow = sel.rect.top - BTN_GAP - BTN_HEIGHT < 8;
  const top = flipBelow ? sel.rect.bottom + BTN_GAP : sel.rect.top - BTN_GAP - BTN_HEIGHT;
  const rawLeft = sel.rect.left + sel.rect.width / 2;
  const left = Math.max(8, Math.min(window.innerWidth - 8, rawLeft));

  return createPortal(
    <button
      type="button"
      onMouseDown={(e) => {
        // Prevent the textarea-or-elsewhere focus shift that would clear the
        // browser selection before our handler reads it.
        e.preventDefault();
        const text = sel.text;
        onQuote(text);
        window.getSelection()?.removeAllRanges();
        setSel(null);
      }}
      style={{
        position: "fixed",
        top,
        left,
        transform: "translateX(-50%)",
        zIndex: 50,
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-md hover:bg-accent"
    >
      <Quote className="h-3 w-3" />
      Quote
    </button>,
    document.body
  );
}
