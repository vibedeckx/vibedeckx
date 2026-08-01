"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Chrome shared by every card on the project Home tab.
 *
 * The design treats these as flush "panels", not padded shadcn cards: a tinted
 * title bar sits directly on the border, and rows run edge to edge with hairline
 * dividers. Keeping that in one place stops the five call sites from drifting.
 */
export function ActivityCard({ className, children, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("overflow-hidden rounded-[10px] border bg-card", className)}
      {...props}
    >
      {children}
    </section>
  );
}

interface ActivityCardTitleProps {
  icon: ReactNode;
  children: ReactNode;
  /** Right-aligned slot: a count, a link, an action. */
  trailing?: ReactNode;
  className?: string;
}

export function ActivityCardTitle({ icon, children, trailing, className }: ActivityCardTitleProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border/60 bg-secondary px-3.5 py-2.5 text-[11.5px] font-semibold text-foreground",
        className,
      )}
    >
      <span className="flex shrink-0 items-center text-muted-foreground">{icon}</span>
      {children}
      <span className="flex-1" />
      {trailing}
    </div>
  );
}

/** Monospace counter for the right edge of a card title. */
export function ActivityCardCount({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-[10.5px] font-medium text-muted-foreground/70", className)}>
      {children}
    </span>
  );
}

export function ActivityCardEmpty({ children }: { children: ReactNode }) {
  return <p className="px-3.5 py-4 text-xs text-muted-foreground">{children}</p>;
}

/** Full-bleed clickable row with a hairline divider. */
export function ActivityRow({ className, children, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-start gap-2.5 border-b border-border/60 px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

const dotTone = {
  neutral: "bg-muted-foreground/60",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  // Warm yellow-green for a finished agent session — same tone the sidebar's
  // per-session dot uses, so one session reads identically in both places.
  lime: "bg-lime-400",
  amber: "bg-amber-500",
  rose: "bg-destructive",
} as const;

export type DotTone = keyof typeof dotTone;

/**
 * 7px status dot. `pulse` adds the expanding halo the design uses to mark work
 * that is live right now — animate-ping matches its scale/fade curve closely.
 */
export function StatusDot({ tone, pulse, className }: { tone: DotTone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("relative flex size-[7px] shrink-0", className)} aria-hidden="true">
      {pulse ? (
        <span className={cn("absolute inset-0 animate-ping rounded-full opacity-50", dotTone[tone])} />
      ) : null}
      <span className={cn("relative size-[7px] rounded-full", dotTone[tone])} />
    </span>
  );
}
