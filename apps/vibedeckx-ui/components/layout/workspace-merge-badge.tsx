"use client";

import { Check, CheckCheck, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BranchMergeInfo } from "@/hooks/use-merge-status";

interface WorkspaceMergeBadgeProps {
  info: BranchMergeInfo;
  repositoryLabel?: string | null;
  onClick: () => void;
}

export function mergeBadgeAriaLabel(
  info: BranchMergeInfo,
  repositoryLabel?: string | null,
): string {
  if (info.error === "target-not-found") {
    const warning = `Target branch '${info.requestedTarget}' not found — pick a new target or reset to default`;
    return repositoryLabel ? `${warning} · ${repositoryLabel}` : warning;
  }

  const relationshipLabel =
    info.status === "merged"
      ? `Merged into ${info.target}`
      : info.status === "no-unique-commits"
        ? `In sync with ${info.target}`
        : `${info.unmergedCount} commit${info.unmergedCount !== 1 ? "s" : ""} not in ${info.target}`;
  const parts = [relationshipLabel];
  if (info.dirty) parts.push("uncommitted changes");
  if (repositoryLabel) parts.push(repositoryLabel);
  return parts.join(" · ");
}

export function WorkspaceMergeBadge({
  info,
  repositoryLabel,
  onClick,
}: WorkspaceMergeBadgeProps) {
  const ariaLabel = mergeBadgeAriaLabel(info, repositoryLabel);

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
          {info.error === "target-not-found" ? (
            <TriangleAlert className="h-3 w-3 text-amber-500" />
          ) : info.status === "merged" ? (
            <Check className="h-3 w-3 text-muted-foreground/70" />
          ) : info.status === "no-unique-commits" ? (
            // Tip equals target (just fast-forward-merged, or a fresh branch):
            // the goal state. Green double-check — distinct from the merged
            // single check in both shape and color (color-blind safe).
            <CheckCheck className="h-3 w-3 text-emerald-500" />
          ) : (
            <span className="text-[10px] font-mono leading-none text-amber-500">
              {info.unmergedCount}
            </span>
          )}
          {!info.error && info.dirty && (
            <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-orange-400" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{ariaLabel}</TooltipContent>
    </Tooltip>
  );
}
