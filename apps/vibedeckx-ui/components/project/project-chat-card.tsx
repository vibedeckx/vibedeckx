"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowRight, MessageSquare, Send } from "lucide-react";
import type { ProjectChatThread } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

interface ProjectChatCardProps {
  scopeKey: string;
  threads: ProjectChatThread[];
  onCreateThread: (message: string) => Promise<ProjectChatThread>;
  onOpenThread: (threadId: string) => void;
}

function threadTitle(thread: ProjectChatThread): string {
  return thread.title?.trim() || "Untitled conversation";
}

export function ProjectChatCard({ scopeKey, threads, onCreateThread, onOpenThread }: ProjectChatCardProps) {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  }, [scopeKey]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || submittingRef.current) return;
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
    <Card className="border-primary/20 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
            <MessageSquare className="size-4 text-primary" aria-hidden="true" />
          </span>
          Project Chat
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={(event) => void submit(event)} className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Discuss project progress, plans, or work across workspaces…"
              aria-label="Message for a new Project Chat thread"
              rows={2}
              className="min-h-20 resize-none"
              disabled={submitting}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <Button type="submit" disabled={submitting || message.trim().length === 0} className="sm:mb-0.5">
              <Send className="size-4" aria-hidden="true" />
              {submitting ? "Starting…" : "Start conversation"}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}. Your message is still here; try again.
            </p>
          ) : null}
        </form>

        <div className="border-t border-border/60 pt-3">
          {threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conversations yet</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Recent
              </span>
              {threads.slice(0, 3).map((thread) => {
                const title = threadTitle(thread);
                return (
                  <Button
                    key={thread.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="recent-thread"
                    aria-label={`Open Project Chat thread: ${title}`}
                    onClick={() => onOpenThread(thread.id)}
                    className="max-w-full"
                  >
                    <span className="max-w-52 truncate">{title}</span>
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
