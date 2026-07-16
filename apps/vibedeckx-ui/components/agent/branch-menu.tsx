"use client";

import { Bot, Loader2, Split } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AgentType } from "@/lib/api";

interface BranchMenuProps {
  agentType: AgentType;
  currentAgentName: string;
  alternateProviders: Array<{ type: AgentType; displayName: string }>;
  onBranch: (agentType?: AgentType) => void;
  disabled?: boolean;
  /** "subtle" = low-contrast historical divider; parent raises contrast via group-hover/group-focus-within. */
  emphasis?: "normal" | "subtle";
}

const agentDot = (type: AgentType) =>
  cn(
    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
    type === "codex" ? "bg-emerald-500/10 text-emerald-600" : "bg-violet-500/10 text-violet-600",
  );

export function BranchMenu({ agentType, currentAgentName, alternateProviders, onBranch, disabled, emphasis = "normal" }: BranchMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7 rounded-md transition-colors hover:bg-muted hover:text-foreground",
            emphasis === "subtle"
              ? "text-muted-foreground/50 group-hover:text-muted-foreground group-focus-within:text-muted-foreground"
              : "text-muted-foreground",
          )}
          disabled={disabled}
          aria-label="Branch conversation"
        >
          {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <Split className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44 p-1.5">
        <DropdownMenuLabel className="px-2 py-1.5">
          <div className="text-xs font-medium">Branch conversation</div>
        </DropdownMenuLabel>
        <DropdownMenuItem className="h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs" onSelect={() => onBranch()}>
          <div className={agentDot(agentType)}><Bot className="h-3 w-3" /></div>
          <span className="min-w-0 flex-1 truncate">{currentAgentName}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">current</span>
        </DropdownMenuItem>
        {alternateProviders.length > 0 && (
          <>
            <DropdownMenuSeparator className="my-1" />
            {alternateProviders.map((p) => (
              <DropdownMenuItem key={p.type} className="h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs" onSelect={() => onBranch(p.type)}>
                <div className={agentDot(p.type)}><Bot className="h-3 w-3" /></div>
                <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
