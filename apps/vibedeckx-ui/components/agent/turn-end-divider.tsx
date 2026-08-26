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
   * Send this turn's answer to the parent session and go there. Composing the
   * message (provenance preamble + the turn's final assistant text) and the
   * "this turn has no text answer" case both belong to the caller — the button
   * fires the action, it does not preview it.
   */
  onSend: () => void;
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
 * Send-back button: one click posts this turn's answer into the parent session
 * and follows it there — the mirror of the branch button, which creates the
 * child session and navigates into it.
 */
function SendBackButton({ sendBack, emphasis }: { sendBack: SendBackControl; emphasis: "normal" | "subtle" }) {
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
      onClick={sendBack.onSend}
    >
      {sendBack.busy
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : sendBack.sent
          ? <Check className="h-4 w-4" />
          : <CornerUpLeft className="h-4 w-4" />}
    </Button>
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper: a disabled button swallows the hover events the tooltip needs */}
          {sendBack.available ? button : <span tabIndex={-1}>{button}</span>}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
