"use client";

import { useState } from "react";
import { Archive, ChevronDown, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ProjectChatContextRef, ProjectChatThread } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ProjectChatThreadHistory, projectChatThreadTitle } from "./project-chat-thread-history";

const contextLabels: Record<ProjectChatContextRef["entity_type"], string> = {
  task: "Task",
  workspace: "Workspace",
  agent_session: "Agent session",
  schedule: "Schedule",
  schedule_run: "Schedule run",
};

interface ProjectChatAuxiliaryRailProps {
  currentThreadId: string;
  threads: ProjectChatThread[];
  contextRefs: ProjectChatContextRef[];
  onNewThread: () => Promise<void>;
  onSelectThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => Promise<void>;
  onArchiveThread: (threadId: string) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onLoadArchived: () => Promise<void>;
  onOpenContext?: (ref: ProjectChatContextRef) => void;
}

export function ProjectChatAuxiliaryRail({
  currentThreadId,
  threads,
  contextRefs,
  onNewThread,
  onSelectThread,
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
  onLoadArchived,
  onOpenContext,
}: ProjectChatAuxiliaryRailProps) {
  const [threadsOpen, setThreadsOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectChatThread | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<ProjectChatThread | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectChatThread | null>(null);
  const activeThreads = threads.filter((thread) => thread.archived_at === null);

  return (
    <aside
      data-testid="project-chat-rail"
      data-project-chat-column
      className="flex h-full w-[300px] shrink-0 flex-col overflow-hidden border-l border-border bg-muted/10"
      aria-label="Project Chat threads and context"
    >
      <section className="flex min-h-0 flex-col border-b border-border/70">
        <div className="flex h-11 shrink-0 items-center gap-1 px-3">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setThreadsOpen((value) => !value)}
            aria-expanded={threadsOpen}
          >
            {threadsOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Chat Threads</h2>
          </button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="New thread" onClick={() => void onNewThread()}>
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </div>
        {threadsOpen ? (
          <div className="space-y-1 px-2 pb-3">
            {activeThreads.slice(0, 5).map((thread) => {
              const title = projectChatThreadTitle(thread);
              const selected = thread.id === currentThreadId;
              return (
                <div
                  key={thread.id}
                  data-testid="thread-row"
                  className={cn("relative flex items-center rounded-md", selected ? "bg-accent" : "hover:bg-muted")}
                >
                  <button
                    type="button"
                    aria-label={`Open thread: ${title}`}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => onSelectThread(thread.id)}
                    className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {title}
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Thread actions: ${title}`}
                    aria-expanded={actionsFor === thread.id}
                    onClick={() => setActionsFor((value) => value === thread.id ? null : thread.id)}
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                  {actionsFor === thread.id ? (
                    <div className="absolute right-1 top-9 z-20 w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                        onClick={() => {
                          setActionsFor(null);
                          setRenameTarget(thread);
                          setRenameValue(title);
                        }}
                      >
                        <Pencil className="size-3.5" /> Rename thread
                      </button>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                        onClick={() => {
                          setActionsFor(null);
                          setArchiveTarget(thread);
                        }}
                      >
                        <Archive className="size-3.5" /> Archive thread
                      </button>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setActionsFor(null);
                          setDeleteTarget(thread);
                        }}
                      >
                        <Trash2 className="size-3.5" /> Delete thread
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
            <Button type="button" variant="ghost" size="sm" aria-label="View all threads" className="w-full" onClick={() => setHistoryOpen(true)}>
              View all
            </Button>
          </div>
        ) : null}
      </section>

      <section className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          className="flex h-11 shrink-0 items-center gap-1.5 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setContextOpen((value) => !value)}
          aria-expanded={contextOpen}
        >
          {contextOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Context</h2>
        </button>
        {contextOpen ? (
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
            {contextRefs.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">Referenced project items appear here.</p>
            ) : contextRefs.map((ref) => {
              const label = contextLabels[ref.entity_type];
              const unavailable = !ref.deleted && (!ref.navigation || !onOpenContext);
              const disabled = ref.deleted || unavailable;
              const unavailableReason = !ref.navigation
                ? "Navigation details are unavailable; refresh the thread and try again."
                : "Navigation is unavailable in this view.";
              return (
                <button
                  key={`${ref.entity_type}:${ref.entity_id}`}
                  type="button"
                  disabled={disabled}
                  aria-label={ref.deleted
                    ? `Deleted ${label.toLocaleLowerCase()}`
                    : unavailable ? `Unavailable ${label.toLocaleLowerCase()}`
                      : `Open ${label}: ${ref.navigation!.label}`}
                  title={unavailable ? unavailableReason : undefined}
                  onClick={() => onOpenContext?.(ref)}
                  className="flex w-full flex-col rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <span className="text-sm">{ref.deleted
                    ? `Deleted ${label.toLocaleLowerCase()}`
                    : unavailable ? `Unavailable ${label.toLocaleLowerCase()}`
                      : `${label} · ${ref.navigation!.label}`}</span>
                  {ref.deleted ? <span className="text-xs text-muted-foreground">Deleted</span> : null}
                  {unavailable ? <span className="text-xs text-muted-foreground">{unavailableReason}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </section>

      <ProjectChatThreadHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        threads={threads}
        onSelectThread={onSelectThread}
        onLoadArchived={onLoadArchived}
      />

      <Dialog open={renameTarget !== null} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Project Chat thread</DialogTitle>
            <DialogDescription>Give this conversation a concise project-level title.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="Thread title"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && renameTarget && renameValue.trim()) {
                void onRenameThread(renameTarget.id, renameValue.trim()).then(() => setRenameTarget(null));
              }
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={!renameValue.trim()}
              onClick={() => {
                if (!renameTarget) return;
                void onRenameThread(renameTarget.id, renameValue.trim()).then(() => setRenameTarget(null));
              }}
            >
              Save title
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this Project Chat thread?</AlertDialogTitle>
            <AlertDialogDescription>This permanently removes the thread and its persisted conversation.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!deleteTarget) return;
                void onDeleteThread(deleteTarget.id).then(() => setDeleteTarget(null));
              }}
            >
              Confirm delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this Project Chat thread?</AlertDialogTitle>
            <AlertDialogDescription>The conversation leaves recent selectors but remains available in thread history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!archiveTarget) return;
                void onArchiveThread(archiveTarget.id).then(() => setArchiveTarget(null));
              }}
            >
              Confirm archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
