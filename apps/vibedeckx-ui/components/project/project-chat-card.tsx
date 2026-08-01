"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Archive, History, MessageSquare, Send } from "lucide-react";
import type { ProjectChatThread } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ProjectChatThreadHistory } from "@/components/project-chat/project-chat-thread-history";
import { ActivityCard } from "./activity-card";

interface ProjectChatCardProps {
  scopeKey: string;
  projectId: string;
  threads: ProjectChatThread[];
  onCreateThread?: (message: string) => Promise<ProjectChatThread>;
  onOpenThread?: (threadId: string) => void;
}

function threadTitle(thread: ProjectChatThread): string {
  return thread.title?.trim() || "Untitled conversation";
}

/** SQLite timestamps arrive zone-less; they are UTC. */
function threadAge(thread: ProjectChatThread): string | null {
  const raw = thread.updated_at;
  if (!raw) return null;
  const hasZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(raw);
  const timestamp = Date.parse(hasZone ? raw : `${raw.replace(" ", "T")}Z`);
  if (Number.isNaN(timestamp)) return null;
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Keycap hint, borrowed from the topbar's search trigger. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[4px] border border-b-2 bg-secondary px-[5px] font-mono text-[10px] leading-[1.4] text-muted-foreground">
      {children}
    </span>
  );
}

export function ProjectChatCard({ scopeKey, projectId, threads, onCreateThread, onOpenThread }: ProjectChatCardProps) {
  const available = Boolean(onCreateThread && onOpenThread);
  const unavailableDescriptionId = `project-chat-unavailable-${scopeKey}`;
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Which footer button opened the dialog. Also keys the dialog, so reopening
  // with the other intent starts from a clean search/archived state.
  const [historyArchived, setHistoryArchived] = useState(false);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const scopeGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    scopeGenerationRef.current += 1;
    submittingRef.current = false;
    setSubmitting(false);
    setMessage("");
    setError(null);
    setHistoryOpen(false);
  }, [scopeKey]);

  const openHistory = (includeArchived: boolean) => {
    setHistoryArchived(includeArchived);
    setHistoryOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!available || !onCreateThread || !onOpenThread || !trimmed || submittingRef.current) return;
    submittingRef.current = true;
    const scopeGeneration = scopeGenerationRef.current;
    setSubmitting(true);
    setError(null);
    try {
      const created = await onCreateThread(trimmed);
      if (!mountedRef.current || scopeGenerationRef.current !== scopeGeneration) return;
      setMessage("");
      onOpenThread(created.id);
    } catch (reason) {
      if (!mountedRef.current || scopeGenerationRef.current !== scopeGeneration) return;
      setError(reason instanceof Error ? reason.message : "Failed to start conversation");
    } finally {
      if (scopeGenerationRef.current === scopeGeneration) {
        submittingRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    }
  };

  return (
    <ActivityCard>
      <div className="flex items-center gap-2.5 border-b border-border/60 bg-secondary px-3 py-2.5">
        <span className="grid size-5.5 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
          <MessageSquare className="size-3.5" aria-hidden="true" />
        </span>
        <h2 className="whitespace-nowrap text-[11.5px] font-semibold">Project Chat</h2>
        <span className="flex-1" />
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
          Spans every workspace in this project
        </span>
      </div>

      <form onSubmit={(event) => void submit(event)} className="px-3 pt-2.5">
        <div className="flex items-start gap-2">
          {/* One-line composer that grows only when the message needs it. */}
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border bg-secondary py-0 pl-2.5 pr-1 transition-[color,background-color,border-color,box-shadow] focus-within:border-primary focus-within:bg-card focus-within:ring-[3px] focus-within:ring-accent">
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Discuss project progress, plans, or work across workspaces…"
              aria-label="Message for a new Project Chat thread"
              rows={1}
              className="max-h-32 min-h-0 resize-none border-0 bg-transparent p-0 py-[7px] text-[12.5px] shadow-none focus-visible:ring-0 dark:bg-transparent"
              disabled={!available || submitting}
              aria-describedby={!available ? unavailableDescriptionId : undefined}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <span className="shrink-0" aria-hidden="true"><Kbd>⏎</Kbd></span>
          </div>
          <Button type="submit" size="sm" disabled={!available || submitting || message.trim().length === 0}>
            <Send className="size-3" aria-hidden="true" />
            {submitting ? "Starting…" : "Start conversation"}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-[11.5px] text-destructive">
            {error}. Your message is still here; try again.
          </p>
        ) : null}
        {!available ? (
          <p id={unavailableDescriptionId} className="mt-2 text-[11.5px] text-muted-foreground">
            Project Chat workbench is not available yet.
          </p>
        ) : null}
      </form>

      {/* Threads are a flush list, not chips: one line each, so the newest five
          read as a scannable history rather than a row of tags. */}
      <div className="mt-2.5 border-t border-border/60">
        {threads.length === 0 ? (
          <p className="px-3.5 py-4 text-xs text-muted-foreground">No conversations yet</p>
        ) : (
          threads.map((thread) => {
            const title = threadTitle(thread);
            const age = threadAge(thread);
            return (
              <button
                key={thread.id}
                type="button"
                data-testid="recent-thread"
                aria-label={`Open Project Chat thread: ${title}`}
                aria-disabled={!available}
                disabled={!available}
                onClick={onOpenThread ? () => onOpenThread(thread.id) : undefined}
                className="flex w-full items-baseline gap-2.5 border-b border-border/60 px-3.5 py-2 text-left transition-colors last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="min-w-0 shrink truncate text-[12.5px] text-secondary-foreground">{title}</span>
                {age ? (
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">{age}</span>
                ) : null}
              </button>
            );
          })
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-secondary px-3.5 py-2">
          <span className="font-mono text-[10.5px] text-muted-foreground/70">
            {threads.length === 0
              ? "No threads yet"
              : `${threads.length} most recent thread${threads.length === 1 ? "" : "s"}`}
          </span>
          <span className="flex-1" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11.5px]"
            disabled={!available}
            onClick={() => openHistory(true)}
          >
            <Archive className="size-[11px]" aria-hidden="true" />
            Show archived
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11.5px]"
            disabled={!available}
            onClick={() => openHistory(false)}
          >
            <History className="size-[11px]" aria-hidden="true" />
            All threads
          </Button>
        </div>
      </div>

      {onOpenThread ? (
        <ProjectChatThreadHistory
          key={historyArchived ? "archived" : "recent"}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          projectId={projectId}
          defaultIncludeArchived={historyArchived}
          onSelectThread={onOpenThread}
        />
      ) : null}
    </ActivityCard>
  );
}
