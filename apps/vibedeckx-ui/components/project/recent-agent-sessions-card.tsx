"use client";

import { Bot, Circle, GitBranch } from "lucide-react";
import type { ProjectAgentSessionActivity } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface RecentAgentSessionsCardProps {
  sessions: ProjectAgentSessionActivity[];
  onOpenSession: (sessionId: string, target: string, branch: string | null) => void;
}

const statusClass: Record<ProjectAgentSessionActivity["status"], string> = {
  running: "text-blue-500 fill-blue-500",
  stopped: "text-amber-500 fill-amber-500",
  error: "text-destructive fill-destructive",
  unknown: "text-muted-foreground fill-muted-foreground",
};

function relativeTime(value: number | null): string {
  if (!value) return "No activity time";
  const delta = Math.max(0, Date.now() - value);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function sessionTitle(session: ProjectAgentSessionActivity): string {
  return session.title?.trim() || session.branch || "Main workspace session";
}

function workspaceLabel(session: ProjectAgentSessionActivity): string {
  const branch = session.workspace.branch || "main";
  return session.workspace.target === "local" ? branch : `${session.workspace.target} · ${branch}`;
}

export function RecentAgentSessionsCard({ sessions, onOpenSession }: RecentAgentSessionsCardProps) {
  const visible = sessions.slice(0, 8);
  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
            Recent Agent Sessions
          </span>
          <span className="font-normal text-muted-foreground">{visible.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent sessions yet</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {visible.map((session) => {
              const title = sessionTitle(session);
              return (
                <li key={`${session.target}:${session.id}`} data-testid="recent-session">
                  <button
                    type="button"
                    aria-label={`Open agent session: ${title}`}
                    onClick={() => onOpenSession(session.id, session.workspace.target, session.workspace.branch)}
                    className="group flex w-full items-start gap-2 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Circle className={cn("mt-1 size-2.5 shrink-0", statusClass[session.status])} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                          <span className="truncate">{workspaceLabel(session)}</span>
                        </span>
                        {session.model ? <span>{session.model}</span> : null}
                        <span>{relativeTime(session.lastActiveAt)}</span>
                      </span>
                    </span>
                    <span className="text-[11px] capitalize text-muted-foreground">{session.status}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
