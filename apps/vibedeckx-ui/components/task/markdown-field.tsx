"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Streamdown } from "streamdown";
import { caretClientY, scrollParent, sourceOffsetAt } from "./markdown-caret";
import { TASK_MARKDOWN_CLASS } from "./task-properties";

/**
 * Markdown shown rendered; a click (outside links, buttons and a text
 * selection) or Enter swaps in `children`, a textarea editing the source, and
 * its blur (Esc blurs via focus-region) swaps back. An empty value goes
 * straight to the editor so its placeholder stays clickable.
 *
 * Entering must not move the page: a click puts the caret at the matching
 * source offset and scrolls so that line sits where the pointer was (Enter
 * keeps the scroll position). Leaving just swaps back.
 */
export function MarkdownField({
  value,
  label,
  className,
  children,
}: {
  value: string;
  /** Names the field; the editor carries it as aria-label. */
  label: string;
  /** Classes for the rendered view, to line it up with the editor. */
  className?: string;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const swapRef = useRef<{ caret: number | null; clientY: number | null; scroller: HTMLElement | null; scrollTop: number } | null>(null);

  const startEditing = (el: HTMLElement, at?: { x: number; y: number }) => {
    const scroller = scrollParent(el);
    swapRef.current = {
      caret: at ? sourceOffsetAt(el, at.x, at.y, value) : null,
      clientY: at?.y ?? null,
      scroller,
      scrollTop: scroller?.scrollTop ?? 0,
    };
    setEditing(true);
  };

  // Layout effect: settle focus, caret and scroll before the swap paints.
  useLayoutEffect(() => {
    const el = editorRef.current?.querySelector("textarea");
    const swap = swapRef.current;
    swapRef.current = null;
    if (!editing || !el) return;
    const caret = swap?.caret ?? el.value.length;
    el.focus({ preventScroll: true });
    el.setSelectionRange(caret, caret);
    if (!swap?.scroller) return;
    swap.scroller.scrollTop = swap.scrollTop;
    if (swap.caret !== null && swap.clientY !== null) swap.scroller.scrollTop += caretClientY(el, caret) - swap.clientY;
  }, [editing]);

  if (!editing && value.trim()) {
    return (
      <div
        tabIndex={0}
        data-markdown-field={label}
        title="Click to edit"
        onClick={(e) => {
          if ((e.target as Element).closest("a, button")) return;
          if (!window.getSelection()?.isCollapsed) return;
          startEditing(e.currentTarget, { x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.target !== e.currentTarget) return;
          e.preventDefault();
          startEditing(e.currentTarget);
        }}
        className={`cursor-text outline-none ${className ?? ""}`}
      >
        <Streamdown mode="static" className={TASK_MARKDOWN_CLASS}>
          {value}
        </Streamdown>
      </div>
    );
  }

  // display:contents keeps the wrapper out of layout; React's focus events
  // bubble. Focus counts as editing so a controlled editor that starts empty
  // isn't swapped out by its first keystroke.
  return (
    <div ref={editorRef} className="contents" onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}>
      {children}
    </div>
  );
}
