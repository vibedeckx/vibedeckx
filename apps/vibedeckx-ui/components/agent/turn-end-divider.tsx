"use client";

import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-duration";
import { BranchMenu } from "./branch-menu";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FileCheck, Loader2 } from "lucide-react";
import type { AgentType } from "@/lib/api";

interface TurnEndDividerProps {
  durationMs?: number;
  outcome?: string;
  /** "normal" for the last stop point (discoverable tail affordance), "subtle" for history. */
  emphasis: "normal" | "subtle";
  agentType: AgentType;
  currentAgentName: string;
  alternateProviders: Array<{ type: AgentType; displayName: string }>;
  onBranch: (agentType?: AgentType) => void;
  disabled?: boolean;
  /** Reviewer-of-an-active-run affordance: "生成 review 终稿" (spec: review discussion rounds). */
  showFinalize?: boolean;
  finalizeBusy?: boolean;
  onFinalize?: () => void;
}

/**
 * Stop-point divider rendered for each persisted turn_end entry:
 *   ────────────  2m 14s  [⑂]  ────────────
 * The button is always rendered and interactive (no hover-only visibility —
 * touch devices and keyboard focus); "subtle" emphasis is raised via the
 * row's group-hover / group-focus-within.
 */
export function TurnEndDivider({
  durationMs, outcome, emphasis,
  agentType, currentAgentName, alternateProviders, onBranch, disabled,
  showFinalize, finalizeBusy, onFinalize,
}: TurnEndDividerProps) {
  const label = durationMs !== undefined ? formatDuration(durationMs) : outcome === "server_restart" ? "interrupted" : null;
  return (
    <div className="group flex items-center gap-2 py-0.5" data-turn-end>
      <div className="h-px flex-1 bg-border/60" />
      {label !== null && (
        <span
          className={cn(
            "shrink-0 text-[11px] tabular-nums transition-colors",
            emphasis === "subtle"
              ? "text-muted-foreground/50 group-hover:text-muted-foreground group-focus-within:text-muted-foreground"
              : "text-muted-foreground",
          )}
        >
          {label}
        </span>
      )}
      {showFinalize && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7 shrink-0 rounded-md transition-colors hover:bg-muted hover:text-foreground",
                  emphasis === "subtle"
                    ? "text-muted-foreground/50 group-hover:text-muted-foreground group-focus-within:text-muted-foreground"
                    : "text-muted-foreground",
                )}
                aria-label="生成 review 终稿"
                onClick={onFinalize}
                disabled={disabled || finalizeBusy}
              >
                {finalizeBusy
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <FileCheck className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>生成 review 终稿</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <BranchMenu
        agentType={agentType}
        currentAgentName={currentAgentName}
        alternateProviders={alternateProviders}
        onBranch={onBranch}
        disabled={disabled}
        emphasis={emphasis}
      />
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}
