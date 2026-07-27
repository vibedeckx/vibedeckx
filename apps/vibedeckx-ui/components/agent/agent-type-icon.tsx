"use client";

import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentType } from "@/lib/api";

/**
 * The accent colour is the fastest "who am I talking to" cue in the UI, so it has
 * to mean the same thing everywhere it appears — the collapsed chip, the picker
 * menu, and the message stream. Keeping the mapping in one place is what makes
 * that true; three inline ternaries drift.
 */
export function agentAccentTextClass(type: AgentType): string {
  return type === "codex" ? "text-green-500" : "text-violet-500";
}

export function AgentTypeIcon({ type, className }: { type: AgentType; className?: string }) {
  return <Bot className={cn("h-3 w-3 shrink-0", agentAccentTextClass(type), className)} />;
}
