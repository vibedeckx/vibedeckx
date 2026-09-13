"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  SelectionCopyButton,
  placeAboveSelection,
  type SelectionAnchor,
} from "./selection-copy-button";

interface TerminalFilterViewProps {
  lines: string[];
  fontSize: number;
  fontFamily: string;
  /** PTY windows show a hint that typing is paused while filtered. */
  isPty: boolean;
  className?: string;
}

// Read-only rendering of the filtered buffer lines, laid over the live xterm.
// Plain text on purpose: colours would need per-line ANSI re-serialisation
// and a second xterm instance for little gain on log-style output. A single
// <pre> is fine up to the 100k-row scrollback cap; virtualise only if that
// ever grows.
export function TerminalFilterView({
  lines,
  fontSize,
  fontFamily,
  isPty,
  className,
}: TerminalFilterViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // Floating copy button over a native text selection inside this view.
  // Hidden while the mouse is down so it does not flicker under a drag.
  const [selection, setSelection] = useState<SelectionAnchor | null>(null);
  const dragRef = useRef(false);

  const placeSelection = useCallback(() => {
    const root = rootRef.current;
    const sel = document.getSelection();
    if (
      dragRef.current ||
      !root ||
      !sel ||
      sel.isCollapsed ||
      sel.rangeCount === 0 ||
      !root.contains(sel.anchorNode)
    ) {
      setSelection(null);
      return;
    }
    // Anchor to the first selected line that is actually on screen: after a
    // long drag or a scroll, the range's first rect can sit above the
    // viewport, and a button placed there would be unreachable.
    const host = root.getBoundingClientRect();
    const first = Array.from(sel.getRangeAt(0).getClientRects()).find(
      (r) => (r.width > 0 || r.height > 0) && r.bottom > host.top && r.top < host.bottom
    );
    if (!first) {
      setSelection(null);
      return;
    }
    setSelection(placeAboveSelection(first, host));
  }, []);

  const handleMouseDown = useCallback(() => {
    dragRef.current = true;
    setSelection(null);
    // The drag may end outside the view; window sees the release regardless.
    window.addEventListener(
      "mouseup",
      () => {
        dragRef.current = false;
        placeSelection();
      },
      { once: true }
    );
  }, [placeSelection]);

  // Collapsing the selection anywhere (click, Escape, typing) removes the
  // button; releasing the mouse is what shows it, so a drag never flickers.
  useEffect(() => {
    const onChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  const copySelection = async () => {
    const text = document.getSelection()?.toString() ?? "";
    setSelection(null);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied selection");
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  // Follow the tail like the terminal does, unless the user scrolled up to
  // read something — then hold position as new matches arrive.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    // Always re-place, not only while the button is showing: a selection
    // that scrolled fully out of view (button hidden) may scroll back in.
    placeSelection();
  };

  return (
    <div
      ref={rootRef}
      data-testid="terminal-filter-view"
      className={cn("absolute inset-0 flex flex-col bg-zinc-950", className)}
    >
      {selection && <SelectionCopyButton anchor={selection} onCopy={copySelection} />}
      <div
        ref={scrollRef}
        data-testid="terminal-filter-scroller"
        onScroll={handleScroll}
        onMouseDown={handleMouseDown}
        // Room at the top for the toolbar row (chips, input, buttons) that
        // floats over the terminal.
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 pt-9"
      >
        {lines.length === 0 ? (
          <div className="select-none py-4 text-center text-xs text-zinc-500">No lines match</div>
        ) : (
          // Wrap at the container edge the way xterm does (break anywhere,
          // not at word boundaries) instead of growing a horizontal scrollbar.
          <pre
            className="m-0 whitespace-pre-wrap break-all text-zinc-100"
            style={{ fontSize, fontFamily, lineHeight: 1.2 }}
          >
            {lines.map((line, i) => (
              // Index keys are fine: rows are positional text with no state.
              <div key={i}>{line === "" ? " " : line}</div>
            ))}
          </pre>
        )}
      </div>
      {isPty && (
        <div className="select-none border-t border-zinc-800 px-2 py-1 text-[11px] text-zinc-500">
          Filtered view — clear filters to type into the shell
        </div>
      )}
    </div>
  );
}
