"use client";

import { MessageSquare } from "lucide-react";
import type { SourceSessionSummary } from "@/lib/api";

/**
 * Link back to the agent session something was created from (a schedule
 * proposed via propose_schedule). A deleted source stays visible as plain
 * muted text — the provenance is still true, there is just nowhere to go.
 */
export function SourceSessionLink({
  source,
  onOpen,
}: {
  source: SourceSessionSummary;
  onOpen?: (branch: string | null, sessionId: string) => void;
}) {
  const title = source.title?.trim() || "Untitled session";
  if (!source.exists) {
    return <span className="text-muted-foreground italic">Source session deleted</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen?.(source.branch || null, source.id)}
      disabled={!onOpen}
      className="inline-flex min-w-0 items-center gap-1 text-primary hover:underline disabled:no-underline disabled:text-foreground"
      title={title}
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{title}</span>
    </button>
  );
}
