"use client";

import { Check, Equal } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BranchMergeInfo } from "@/hooks/use-merge-status";

interface WorkspaceMergeBadgeProps {
  info: BranchMergeInfo;
  onClick: () => void;
}

export function WorkspaceMergeBadge({ info, onClick }: WorkspaceMergeBadgeProps) {
  const label =
    info.status === "merged"
      ? `Merged into ${info.target}`
      : info.status === "no-unique-commits"
        ? `In sync with ${info.target}`
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
          ) : info.status === "no-unique-commits" ? (
            // Tip equals target (just fast-forward-merged, or a fresh branch):
            // "identical to target", one shade fainter than the merged check.
            <Equal className="h-3 w-3 text-muted-foreground/40" />
          ) : (
            <span className="text-[10px] font-mono leading-none text-amber-500">
              {info.unmergedCount}
            </span>
          )}
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
