"use client";

// Query echo for type-to-locate, styled like Chrome's link-status bubble:
// flush against the bottom-left corner, only the top-right corner rounded,
// hairline border, no shadow. Rendered by LocateProvider whenever a query is
// active, one chip for every scope. Deliberately display-only, not an input
// and not a palette: no result list, no focus; the matches highlight in the
// owning list itself. It exists so mistyped input is never invisible (query
// goes red when nothing matches) and so the current scope is always named.

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export function LocateChip({ query, matchCount }: { query: string; matchCount: number }) {
  return (
    <div className="pointer-events-none fixed bottom-0 left-0 z-50 flex max-w-[360px] items-center gap-2 rounded-tr-md border-t border-r border-border bg-popover px-2.5 py-1">
      <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "min-w-0 truncate font-mono text-xs leading-4",
          matchCount === 0 ? "text-destructive" : "text-foreground",
        )}
      >
        {query}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground/80">{matchCount}</span>
    </div>
  );
}
