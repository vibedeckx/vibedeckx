import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Colour lives on the icon tile only: each tool keeps its hue there so rows
 * are easy to tell apart at a glance, while every title stays body text so
 * the transcript doesn't turn into a wall of coloured labels.
 */
const COLORS = {
  sky: "bg-sky-500/10 text-sky-500",
  violet: "bg-violet-500/10 text-violet-500",
  purple: "bg-purple-500/10 text-purple-500",
  indigo: "bg-indigo-500/10 text-indigo-500",
  blue: "bg-blue-500/10 text-blue-500",
  cyan: "bg-cyan-500/10 text-cyan-500",
  teal: "bg-teal-500/10 text-teal-500",
  emerald: "bg-emerald-500/10 text-emerald-500",
  green: "bg-green-500/10 text-green-500",
  amber: "bg-amber-500/10 text-amber-500",
  orange: "bg-orange-500/10 text-orange-500",
  pink: "bg-pink-500/10 text-pink-500",
  red: "bg-red-500/10 text-red-500",
} as const;

export type MessageColor = keyof typeof COLORS;

export function MessageRow({
  icon: Icon,
  title,
  color,
  className,
  titleClassName,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  color: MessageColor;
  className?: string;
  titleClassName?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex gap-3 py-3", className)}>
      <div className={cn("flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center", COLORS[color])}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className={cn("conv-text-sm font-medium text-foreground mb-1", titleClassName)}>{title}</p>
        {children}
      </div>
    </div>
  );
}
