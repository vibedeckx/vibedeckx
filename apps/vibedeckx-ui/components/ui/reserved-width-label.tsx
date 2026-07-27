"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ReservedWidthLabelProps {
  /**
   * Every label this slot can ever show. The slot is held open at the widest
   * one, so swapping the visible label never resizes the control around it.
   */
  candidates: string[];
  className?: string;
  children: ReactNode;
}

/**
 * Holds a label slot at the width of the widest candidate.
 *
 * Every candidate is stacked into one grid cell; the hidden copies keep the cell
 * open while the visible label paints on top. Measuring in CSS rather than with
 * a `min-w-[Xrem]` constant means a new provider or model suggestion needs no
 * follow-up edit, the slot follows font-size changes, and there is no
 * measure-then-reflow flash on first paint.
 *
 * A label longer than every candidate (a hand-typed model name) truncates
 * instead of stretching the control — pair it with a `max-w-*` and a `title`.
 */
export function ReservedWidthLabel({ candidates, className, children }: ReservedWidthLabelProps) {
  const sizers = Array.from(new Set(candidates));

  return (
    <span className={cn("grid overflow-hidden text-left", className)}>
      {sizers.map((c) => (
        <span
          key={c}
          aria-hidden
          // `invisible` (not `hidden`) still occupies its cell, which is the
          // whole point. aria-hidden keeps the label set out of the accessible
          // name, which would otherwise repeat it once per candidate.
          className="col-start-1 row-start-1 invisible whitespace-nowrap"
        >
          {c}
        </span>
      ))}
      <span className="col-start-1 row-start-1 min-w-0 truncate">{children}</span>
    </span>
  );
}
