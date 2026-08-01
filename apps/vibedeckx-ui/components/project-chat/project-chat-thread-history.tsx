"use client";

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
import { useProjectChatThreadHistory } from "@/hooks/use-project-chat-thread-history";

export function projectChatThreadTitle(thread: ProjectChatThread | null): string {
  return thread?.title?.trim() || "Untitled conversation";
}

interface ProjectChatThreadHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Open straight into archived threads. Only read on mount — see the hook. */
  defaultIncludeArchived?: boolean;
  onSelectThread: (threadId: string) => void;
}

export function ProjectChatThreadHistory({
  open,
  onOpenChange,
  projectId,
  defaultIncludeArchived,
  onSelectThread,
}: ProjectChatThreadHistoryProps) {
  const history = useProjectChatThreadHistory(projectId, open, defaultIncludeArchived);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] grid-rows-[auto_auto_minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>All Project Chat threads</DialogTitle>
          <DialogDescription>Search, reopen, or include archived project conversations.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                autoFocus
                aria-label="Search threads"
                maxLength={200}
                value={history.query}
                onChange={(event) => history.setQuery(event.target.value)}
                className="pl-8"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={history.includeArchived || history.loading}
              onClick={history.showArchived}
            >
              <Archive className="size-4" aria-hidden="true" />
              {history.includeArchived ? "Archived included" : "Show archived threads"}
            </Button>
          </div>
          {history.error ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{history.error}</div> : null}
        </div>
        <div className="min-h-0 space-y-1 overflow-y-auto" role="list">
          {history.loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading threads…</p>
          ) : history.threads.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No matching threads</p>
          ) : history.threads.map((thread) => {
            const title = projectChatThreadTitle(thread);
            return (
              <div key={thread.id} role="listitem">
                <button
                  type="button"
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
              </div>
            );
          })}
          {history.nextCursor ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 w-full"
              disabled={history.loadingMore}
              onClick={() => void history.loadMore()}
            >
              {history.loadingMore ? "Loading more…" : "Load more threads"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
