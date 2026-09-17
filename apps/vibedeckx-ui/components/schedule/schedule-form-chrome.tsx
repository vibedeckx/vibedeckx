"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Field chrome shared by the scheduled-task dialog and its timing builder:
 * one control rhythm (34px tall, 9px radius, 12.5px text) for inputs,
 * selects and pickers so mixed rows read as a single line.
 */

/** Trigger geometry for shadcn `Select` / `Popover` triggers sitting next to text boxes. */
export const CONTROL_TRIGGER =
  "h-[34px] w-full min-w-0 rounded-[9px] border-input bg-card px-2.5 text-[12.5px] shadow-none " +
  "hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-accent " +
  "dark:bg-card dark:hover:bg-muted [&_svg:not([class*='size-'])]:size-3";

/** Geometry for shadcn `Input` / `Textarea` when they stand alone. */
export const CONTROL_INPUT =
  "rounded-[9px] border-input bg-card shadow-none text-[12.5px] md:text-[12.5px] " +
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-accent dark:bg-card";

/** Bare input inside a `ControlBox`. */
export const BOX_INPUT =
  "min-w-0 flex-1 bg-transparent p-0 text-[12.5px] text-foreground outline-none " +
  "placeholder:text-muted-foreground/70 disabled:cursor-not-allowed";

/**
 * A text box that can carry a leading icon and a trailing suffix. Focus and
 * invalid rings live on the box, so the inner input stays unstyled.
 */
export function ControlBox({
  className,
  disabled,
  invalid,
  children,
}: {
  className?: string;
  disabled?: boolean;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-disabled={disabled || undefined}
      data-invalid={invalid || undefined}
      className={cn(
        "flex h-[34px] min-w-0 items-center gap-2 rounded-[9px] border border-input bg-card px-[11px] text-[12.5px] transition-[color,box-shadow]",
        "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-accent",
        "data-[disabled]:bg-secondary data-[disabled]:text-muted-foreground",
        "data-[invalid]:border-destructive/50 data-[invalid]:ring-[3px] data-[invalid]:ring-destructive/10",
        "[&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:text-muted-foreground/70",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Label row above a field: uppercase name, optional inline control, right-aligned note or control. */
export function FieldLabel({
  children,
  after,
  note,
  trailing,
}: {
  children: ReactNode;
  /** Sits right after the label text (e.g. the agent picker next to "Prompt"). */
  after?: ReactNode;
  /** Small muted note on the right ("Required", "Runs in"). */
  note?: ReactNode;
  /** A control on the right (segmented switch). Wins over `note`. */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-[10px] font-semibold tracking-[0.07em] text-muted-foreground/80 uppercase">
        {children}
      </span>
      {after}
      <span className="flex-1" />
      {trailing ?? (note && <span className="text-[10.5px] text-muted-foreground/80">{note}</span>)}
    </div>
  );
}

/** Small two-or-three-way switch that lives in a label row. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-lg border bg-secondary p-[1.5px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-md border border-transparent px-2 py-[3px] text-[11px] font-medium whitespace-nowrap transition-colors disabled:opacity-50",
              on ? "border-border bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** One-line muted hint under a field. */
export function HintLine({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[10.5px] leading-snug text-muted-foreground/80">
      {children}
    </p>
  );
}

/** Inline text action inside a hint line or strip. */
export function InlineLink({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="whitespace-nowrap text-accent-foreground underline-offset-2 hover:underline disabled:opacity-50 disabled:hover:no-underline"
    >
      {children}
    </button>
  );
}

/** Tinted notice band: info (accent) or rose (destructive). */
export function Strip({
  tone,
  icon,
  children,
}: {
  tone: "info" | "rose";
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "rose" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11.5px] leading-snug [&>svg]:mt-px [&>svg]:size-[13px] [&>svg]:shrink-0",
        tone === "info"
          ? "border-primary/20 bg-accent text-accent-foreground"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {icon}
      <span className="min-w-0">{children}</span>
    </div>
  );
}
