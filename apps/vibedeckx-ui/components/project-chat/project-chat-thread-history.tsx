"use client";

import { useMemo, useState } from "react";
import { Archive, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ProjectChatThread } from "@/lib/api";

export function projectChatThreadTitle(thread: ProjectChatThread | null): string {
  return thread?.title?.trim() || "Untitled conversation";
}

interface ProjectChatThreadHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: ProjectChatThread[];
  onSelectThread: (threadId: string) => void;
  onLoadArchived: () => Promise<void>;
}

export function ProjectChatThreadHistory({
  open,
  onOpenChange,
  threads,
  onSelectThread,
  onLoadArchived,
}: ProjectChatThreadHistoryProps) {
  const [query, setQuery] = useState("");
  const [loadingArchived, setLoadingArchived] = useState(false);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return threads;
    return threads.filter((thread) => projectChatThreadTitle(thread).toLocaleLowerCase().includes(normalized));
  }, [query, threads]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] grid-rows-[auto_auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>All Project Chat threads</DialogTitle>
          <DialogDescription>Search, reopen, or include archived project conversations.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              autoFocus
              aria-label="Search threads"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-8"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loadingArchived}
            onClick={async () => {
              setLoadingArchived(true);
              try {
                await onLoadArchived();
              } finally {
                setLoadingArchived(false);
              }
            }}
          >
            <Archive className="size-4" aria-hidden="true" />
            {loadingArchived ? "Loading…" : "Show archived threads"}
          </Button>
        </div>
        <div className="min-h-0 space-y-1 overflow-y-auto" role="list">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No matching threads</p>
          ) : filtered.map((thread) => {
            const title = projectChatThreadTitle(thread);
            return (
              <button
                key={thread.id}
                type="button"
                role="listitem"
                data-testid="history-thread-row"
                aria-label={`Open history thread: ${title}`}
                onClick={() => {
                  onSelectThread(thread.id);
                  onOpenChange(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 truncate text-sm font-medium">{title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {thread.archived_at ? "Archived" : new Date(thread.updated_at).toLocaleDateString()}
                </span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
