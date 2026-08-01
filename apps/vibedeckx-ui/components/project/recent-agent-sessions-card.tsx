"use client";

import { Bot, GitBranch } from "lucide-react";
import type { ProjectAgentSessionActivity } from "@/lib/api";
import { workspaceLabel } from "@/lib/workspace-label";
import {
  ActivityCard,
  ActivityCardCount,
  ActivityCardEmpty,
  ActivityCardTitle,
  ActivityRow,
  StatusDot,
  type DotTone,
} from "./activity-card";

interface RecentAgentSessionsCardProps {
  sessions: ProjectAgentSessionActivity[];
  /** Remote server id → name, so a session's workspace reads as "gpu-01 · main". */
  remoteNames: Map<string, string>;
  onOpenSession: (sessionId: string, target: string, branch: string | null) => void;
}

const statusTone: Record<ProjectAgentSessionActivity["status"], DotTone> = {
  running: "blue",
  stopped: "amber",
  error: "rose",
  unknown: "neutral",
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

export function RecentAgentSessionsCard({ sessions, remoteNames, onOpenSession }: RecentAgentSessionsCardProps) {
  const visible = sessions.slice(0, 8);
  return (
    <ActivityCard>
      <ActivityCardTitle
        icon={<Bot className="size-3" aria-hidden="true" />}
        trailing={<ActivityCardCount>{visible.length}</ActivityCardCount>}
      >
        Recent Agent Sessions
      </ActivityCardTitle>

      {visible.length === 0 ? (
        <ActivityCardEmpty>No agent sessions yet</ActivityCardEmpty>
      ) : (
        visible.map((session) => {
          const title = sessionTitle(session);
          return (
            <ActivityRow
              key={`${session.target}:${session.id}`}
              data-testid="recent-session"
              aria-label={`Open agent session: ${title}`}
              onClick={() => onOpenSession(session.id, session.workspace.target, session.workspace.branch)}
            >
              <StatusDot
                tone={statusTone[session.status]}
                pulse={session.status === "running"}
                className="mt-[5px]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{title}</span>
                <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
                  <span className="inline-flex min-w-0 max-w-50 items-center gap-1">
                    <GitBranch className="size-2.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                    <span className="truncate">{workspaceLabel(session.workspace, remoteNames)}</span>
                  </span>
                  {session.model ? <span className="truncate">{session.model}</span> : null}
                  <span>{relativeTime(session.lastActiveAt)}</span>
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10.5px] capitalize text-muted-foreground">
                {session.status}
              </span>
            </ActivityRow>
          );
        })
      )}
    </ActivityCard>
  );
}
