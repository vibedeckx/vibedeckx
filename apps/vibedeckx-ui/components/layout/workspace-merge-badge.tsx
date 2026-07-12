"use client";

import { Check } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BranchMergeInfo } from "@/hooks/use-merge-status";

interface WorkspaceMergeBadgeProps {
  info: BranchMergeInfo;
  onClick: () => void;
}

export function WorkspaceMergeBadge({ info, onClick }: WorkspaceMergeBadgeProps) {
  // A fresh branch with a clean worktree needs no badge at all.
  if (info.status === "no-unique-commits" && !info.dirty) return null;

  const label =
    info.status === "merged"
      ? `Merged into ${info.target}`
      : info.status === "no-unique-commits"
        ? `No commits vs ${info.target}`
        : `${info.unmergedCount} commit${info.unmergedCount !== 1 ? "s" : ""} not in ${info.target}`;
  const ariaLabel = info.dirty ? `${label} · uncommitted changes` : label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          aria-label={ariaLabel}
          className="relative shrink-0 flex items-center justify-center h-4 min-w-4 px-0.5 rounded hover:bg-muted"
        >
          {info.status === "merged" ? (
            <Check className="h-3 w-3 text-muted-foreground/70" />
          ) : info.status !== "no-unique-commits" ? (
            <span className="text-[10px] font-mono leading-none text-amber-500">
              {info.unmergedCount}
            </span>
          ) : null}
          {info.dirty && (
            <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-orange-400" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {info.dirty ? " · uncommitted changes" : ""}
      </TooltipContent>
    </Tooltip>
  );
}
