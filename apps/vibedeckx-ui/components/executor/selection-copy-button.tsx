"use client";

import { Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectionAnchor {
  top: number;
  left: number;
}

const BUTTON_HEIGHT = 22;
const BUTTON_WIDTH = 64;
const GAP = 4;

/**
 * Where to float the copy button for a selection whose first line occupies
 * `first`, inside a host box `host` (both viewport rects). Above the line by
 * default; below it when the selection starts flush with the host's top edge.
 * The result is in the host's coordinate space.
 */
export function placeAboveSelection(
  first: Pick<DOMRect, "top" | "bottom" | "left">,
  host: Pick<DOMRect, "top" | "left" | "width">
): SelectionAnchor {
  let top = first.top - host.top - BUTTON_HEIGHT - GAP;
  if (top < 0) top = first.bottom - host.top + GAP;
  const maxLeft = Math.max(0, host.width - BUTTON_WIDTH - 2);
  const left = Math.min(Math.max(first.left - host.left, 2), maxLeft);
  return { top, left };
}

interface SelectionCopyButtonProps {
  anchor: SelectionAnchor;
  onCopy: () => void;
  className?: string;
}

// Floating "Copy" pill shown over a mouse selection. It is positioned by the
// host, which knows where the selection is; the button only copies.
export function SelectionCopyButton({ anchor, onCopy, className }: SelectionCopyButtonProps) {
  return (
    <button
      type="button"
      data-testid="selection-copy-button"
      aria-label="Copy selection"
      // mousedown would collapse the selection before click fires.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onCopy}
      style={{ top: anchor.top, left: anchor.left, height: BUTTON_HEIGHT }}
      className={cn(
        "absolute z-20 flex items-center gap-1 rounded border border-zinc-600 bg-zinc-800 px-2",
        "text-[11px] text-zinc-100 shadow-md hover:bg-zinc-700 hover:border-zinc-500",
        className
      )}
    >
      <Copy className="h-3 w-3" />
      Copy
    </button>
  );
}
