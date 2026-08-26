"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-duration";
import { BranchMenu } from "./branch-menu";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Check, CornerUpLeft, FileCheck, Loader2 } from "lucide-react";
import type { AgentType } from "@/lib/api";

/** Send-back affordance for branched sessions: post this turn's answer into the parent session. */
export interface SendBackControl {
  /** False once the parent session no longer exists (reclaimed by retention). */
  available: boolean;
  /** This turn's answer was already sent back (soft guard — resending is allowed). */
  sent: boolean;
  busy: boolean;
  /**
   * The composed message that would be sent (provenance preamble + the turn's
   * final assistant text), or null when the turn produced no text answer.
   * Called lazily when the confirm popover opens.
   */
  getContent: () => string | null;
  /** Send exactly `content` — the string the user just previewed. */
  onSend: (content: string) => void;
}

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
  /** Present only on sessions branched from another session. */
  sendBack?: SendBackControl;
}

const dividerButtonClass = (emphasis: "normal" | "subtle") =>
  cn(
    "h-7 w-7 shrink-0 rounded-md transition-colors hover:bg-muted hover:text-foreground",
    emphasis === "subtle"
      ? "text-muted-foreground/50 group-hover:text-muted-foreground group-focus-within:text-muted-foreground"
      : "text-muted-foreground",
  );

/**
 * Confirm-before-send popover: shows the exact composed message so a mis-aimed
 * turn or an unexpected extraction is caught before it lands in the parent
 * session's history and wakes its agent.
 */
function SendBackButton({ sendBack, emphasis }: { sendBack: SendBackControl; emphasis: "normal" | "subtle" }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);

  const label = !sendBack.available
    ? "源会话已被清理，无法发回"
    : sendBack.sent
      ? "已发回源会话（可再次发送）"
      : "把本轮回答发回源会话";

  const button = (
    <Button
      variant="ghost"
      size="icon"
      className={dividerButtonClass(emphasis)}
      aria-label="发回源会话"
      disabled={!sendBack.available || sendBack.busy}
    >
      {sendBack.busy
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : sendBack.sent
          ? <Check className="h-4 w-4" />
          : <CornerUpLeft className="h-4 w-4" />}
    </Button>
  );

  // A disabled trigger can't open the popover — render tooltip-only.
  if (!sendBack.available) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* span wrapper: disabled buttons swallow the hover events the tooltip needs */}
            <span tabIndex={-1}>{button}</span>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setContent(sendBack.getContent());
        setOpen(next);
      }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{button}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="mb-1.5 text-xs font-medium">发回源会话</div>
        {content === null ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            本轮没有可发回的文本回复。
          </p>
        ) : (
          <>
            <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-xs leading-relaxed text-muted-foreground">
              {content}
            </div>
            <Button
              size="sm"
              className="mt-2 h-7 w-full text-xs"
              onClick={() => {
                setOpen(false);
                sendBack.onSend(content);
              }}
            >
              {sendBack.sent ? "再次发送" : "确认发回"}
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
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
  sendBack,
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
                className={dividerButtonClass(emphasis)}
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
      {sendBack && <SendBackButton sendBack={sendBack} emphasis={emphasis} />}
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
