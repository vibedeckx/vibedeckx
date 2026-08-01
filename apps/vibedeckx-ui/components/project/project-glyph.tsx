"use client";

import { Folder } from "lucide-react";
import { projectInitials } from "@/lib/project-initials";
import { cn } from "@/lib/utils";

/**
 * Small project identity chip for list contexts (sidebar rows, quick switcher).
 *
 * Monochrome on purpose: the sidebar's selected row already spends the accent
 * colour, so per-project hues here would blunt the one signal that has to stay
 * legible. The hero renders its own 52px treatment rather than a size variant —
 * the chrome differs too much (border, shadow, accent underline) to share.
 */
const SIZES = {
  /** Sidebar rows. One letter — two are illegible in a 16px box. */
  sm: { box: "size-4 rounded", text: "text-[9.5px]", icon: "size-2.5", letters: 1 },
  /** Quick switcher rows. */
  md: { box: "size-5 rounded-[5px]", text: "text-[9px]", icon: "size-3", letters: 2 },
} as const;

interface ProjectGlyphProps {
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}

export function ProjectGlyph({ name, size = "sm", className }: ProjectGlyphProps) {
  const spec = SIZES[size];
  const initials = projectInitials(name, spec.letters);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center bg-primary/14 font-mono font-semibold leading-none tracking-[-0.02em] text-primary",
        spec.box,
        spec.text,
        className,
      )}
    >
      {initials || <Folder className={cn(spec.icon, "text-primary")} />}
    </span>
  );
}
