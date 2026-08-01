"use client";

import { useEffect, useRef, useState } from "react";
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
  newThreadPending?: boolean;
  className?: string;
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
  newThreadPending = false,
  className,
}: ProjectChatAuxiliaryRailProps) {
  const [threadsOpen, setThreadsOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectChatThread | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<ProjectChatThread | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectChatThread | null>(null);
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingActionsRef = useRef<Set<string>>(new Set());
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const activeThreads = threads.filter((thread) => thread.archived_at === null);
  const renamePending = renameTarget ? pendingActions.has(`rename:${renameTarget.id}`) : false;
  const deletePending = deleteTarget ? pendingActions.has(`delete:${deleteTarget.id}`) : false;
  const archivePending = archiveTarget ? pendingActions.has(`archive:${archiveTarget.id}`) : false;

  useEffect(() => {
    if (!actionsFor) return;
    actionsMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsFor(null);
    };
    const closeOutside = (event: PointerEvent) => {
      if (!actionsMenuRef.current?.contains(event.target as Node)) setActionsFor(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [actionsFor]);

  const runAction = async (key: string, action: () => Promise<void>, onSuccess: () => void) => {
    if (pendingActionsRef.current.has(key)) return;
    pendingActionsRef.current.add(key);
    setPendingActions((current) => new Set(current).add(key));
    setActionError(null);
    try {
      await action();
      onSuccess();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Project Chat action failed");
    } finally {
      pendingActionsRef.current.delete(key);
      setPendingActions((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <aside
      data-testid="project-chat-rail"
      data-project-chat-column
      className={cn("flex h-full w-[300px] shrink-0 flex-col overflow-hidden border-l border-border bg-muted/10", className)}
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
          <Button type="button" variant="ghost" size="icon-sm" aria-label="New thread" disabled={newThreadPending} onClick={() => void onNewThread()}>
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
                    aria-haspopup="menu"
                    aria-controls={actionsFor === thread.id ? `thread-actions-${thread.id}` : undefined}
                    onClick={() => setActionsFor((value) => value === thread.id ? null : thread.id)}
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                  {actionsFor === thread.id ? (
                    <div ref={actionsMenuRef} id={`thread-actions-${thread.id}`} role="menu" aria-label={`Actions for ${title}`} className="absolute right-1 top-9 z-20 w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                        onClick={() => {
                          setActionsFor(null);
                          setActionError(null);
                          setRenameTarget(thread);
                          setRenameValue(title);
                        }}
                      >
                        <Pencil className="size-3.5" /> Rename thread
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                        onClick={() => {
                          setActionsFor(null);
                          setActionError(null);
                          setArchiveTarget(thread);
                        }}
                      >
                        <Archive className="size-3.5" /> Archive thread
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setActionsFor(null);
                          setActionError(null);
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

      <Dialog open={renameTarget !== null} onOpenChange={(open) => {
        if (!open && !renamePending) {
          setRenameTarget(null);
          setActionError(null);
        }
      }}>
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
                void runAction(
                  `rename:${renameTarget.id}`,
                  () => onRenameThread(renameTarget.id, renameValue.trim()),
                  () => setRenameTarget(null),
                );
              }
            }}
          />
          {actionError ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={renamePending} onClick={() => { setRenameTarget(null); setActionError(null); }}>Cancel</Button>
            <Button
              type="button"
              disabled={!renameValue.trim() || renamePending}
              onClick={() => {
                if (!renameTarget) return;
                void runAction(
                  `rename:${renameTarget.id}`,
                  () => onRenameThread(renameTarget.id, renameValue.trim()),
                  () => setRenameTarget(null),
                );
              }}
            >
              Save title
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => {
        if (!open && !deletePending) {
          setDeleteTarget(null);
          setActionError(null);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this Project Chat thread?</AlertDialogTitle>
            <AlertDialogDescription>This permanently removes the thread and its persisted conversation.</AlertDialogDescription>
          </AlertDialogHeader>
          {actionError ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deletePending}
              onClick={(event) => {
                event.preventDefault();
                if (!deleteTarget) return;
                void runAction(
                  `delete:${deleteTarget.id}`,
                  () => onDeleteThread(deleteTarget.id),
                  () => setDeleteTarget(null),
                );
              }}
            >
              Confirm delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => {
        if (!open && !archivePending) {
          setArchiveTarget(null);
          setActionError(null);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this Project Chat thread?</AlertDialogTitle>
            <AlertDialogDescription>The conversation leaves recent selectors but remains available in thread history.</AlertDialogDescription>
          </AlertDialogHeader>
          {actionError ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archivePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={archivePending}
              onClick={(event) => {
                event.preventDefault();
                if (!archiveTarget) return;
                void runAction(
                  `archive:${archiveTarget.id}`,
                  () => onArchiveThread(archiveTarget.id),
                  () => setArchiveTarget(null),
                );
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
