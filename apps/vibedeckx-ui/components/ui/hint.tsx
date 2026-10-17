"use client";

import type { FocusEvent, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Keyboard focus only. A menu or dialog hands focus back to its trigger when
 * it closes, and Radix opens a tooltip on any focus — so without this every
 * closed session menu or review dialog would leave its tooltip standing.
 * Calling preventDefault skips Radix's own focus handler.
 */
function openOnKeyboardFocusOnly(event: FocusEvent<HTMLElement>) {
  let keyboard = true;
  try {
    keyboard = event.currentTarget.matches(":focus-visible");
  } catch {
    // An engine without :focus-visible: keep the tooltip reachable.
  }
  if (!keyboard) event.preventDefault();
}

/**
 * The app's tooltip around one control, in place of a native `title`. The
 * child must accept a ref and pointer/focus handlers (a button, or a span
 * around a disabled one — a disabled button gets no hover events). Icon-only
 * controls still need their own aria-label: the tooltip is not their name.
 * A null label shows nothing — for a hint that only applies sometimes (a
 * label that may or may not be clipped) without remounting the control.
 */
export function Hint({
  label,
  children,
  side = "bottom",
}: {
  label: ReactNode | null;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild onFocus={openOnKeyboardFocusOnly}>
          {children}
        </TooltipTrigger>
        {label != null && <TooltipContent side={side} className="max-w-72">{label}</TooltipContent>}
      </Tooltip>
    </TooltipProvider>
  );
}
