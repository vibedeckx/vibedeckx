"use client";

import type { CSSProperties, ReactNode } from "react";
import type { TaskStatus, TaskPriority } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { statusConfig, priorityConfig, statusOptions, priorityOptions } from "./task-utils";

/**
 * Status as a 14px glyph: ring = todo, half-filled = in progress, check =
 * done, cross = cancelled. `pending` is the dashed ring of a create in flight.
 */
export function StatusGlyph({ status, pending, className }: { status: TaskStatus; pending?: boolean; className?: string }) {
  const base = "grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px] text-white";
  if (pending) return <span aria-hidden className={cn(base, "border-dashed border-border", className)} />;
  switch (status) {
    case "in_progress":
      return (
        <span
          aria-hidden
          className={cn(base, "border-[oklch(0.58_0.16_245)] p-[2px]", className)}
          style={{ background: "conic-gradient(oklch(0.58 0.16 245) 0 50%, transparent 0) content-box" }}
        />
      );
    case "done":
      return (
        <span aria-hidden className={cn(base, "border-[oklch(0.6_0.14_152)] bg-[oklch(0.6_0.14_152)]", className)}>
          <Check className="size-[9px]" strokeWidth={3.5} />
        </span>
      );
    case "cancelled":
      return (
        <span aria-hidden className={cn(base, "border-muted-foreground/70 bg-muted-foreground/70", className)}>
          <X className="size-2" strokeWidth={3.5} />
        </span>
      );
    default:
      return <span aria-hidden className={cn(base, "border-muted-foreground/60", className)} />;
  }
}

const BAR_TONE: Record<Exclude<TaskPriority, "urgent">, { lit: number; color: string }> = {
  low: { lit: 1, color: "bg-muted-foreground" },
  medium: { lit: 2, color: "bg-[oklch(0.76_0.15_85)]" },
  high: { lit: 3, color: "bg-[oklch(0.7_0.17_50)]" },
};

/** Priority as a 3-bar signal; urgent is a red "!" square. */
export function PriorityGlyph({ priority, className }: { priority: TaskPriority; className?: string }) {
  if (priority === "urgent") {
    return (
      <span
        aria-hidden
        className={cn("inline-grid size-[13px] shrink-0 place-items-center rounded-[3.5px] bg-[oklch(0.6_0.2_25)] font-mono text-[9.5px] font-bold leading-none text-white", className)}
      >
        !
      </span>
    );
  }
  const { lit, color } = BAR_TONE[priority];
  return (
    <span aria-hidden className={cn("inline-flex h-[11px] shrink-0 items-end gap-[1.5px]", className)}>
      {[4, 7, 11].map((h, i) => (
        <i key={h} className={cn("w-[3px] rounded-[1px]", i < lit ? color : "bg-border")} style={{ height: h }} />
      ))}
    </span>
  );
}

/** Sub-task progress as a small ring plus done/total. */
export function ProgressRing({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  const mask = "radial-gradient(circle, transparent 2.6px, #000 3px)";
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px] font-normal tabular-nums text-muted-foreground", className)} title="Sub-tasks done">
      <span
        aria-hidden
        className="size-[11px] shrink-0 rounded-full"
        style={{
          background: `conic-gradient(oklch(0.6 0.14 152) ${pct}%, var(--border) 0)`,
          WebkitMask: mask,
          mask,
        } as CSSProperties}
      />
      {done}/{total}
    </span>
  );
}

/** Status picker opened from any status glyph or field. */
export function StatusMenu({ status, onChange, children }: { status: TaskStatus; onChange: (status: TaskStatus) => void; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {statusOptions.map((s) => (
          <DropdownMenuItem key={s} onClick={() => onChange(s)} className="gap-2.5 text-[12.5px]">
            <StatusGlyph status={s} />
            {statusConfig[s].label}
            {s === status && <Check className="ml-auto size-3 text-primary" strokeWidth={2.5} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Priority picker, highest first. */
export function PriorityMenu({ priority, onChange, children }: { priority: TaskPriority; onChange: (priority: TaskPriority) => void; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {[...priorityOptions].reverse().map((p) => (
          <DropdownMenuItem key={p} onClick={() => onChange(p)} className="gap-2.5 text-[12.5px]">
            <PriorityGlyph priority={p} />
            {priorityConfig[p].label}
            {p === priority && <Check className="ml-auto size-3 text-primary" strokeWidth={2.5} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
