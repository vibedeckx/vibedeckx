"use client";

import { GitBranch, Star } from "lucide-react";
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

interface StarredSessionsCardProps {
  sessions: ProjectAgentSessionActivity[];
  /** Remote server id → name, so a session's workspace reads as "gpu-01 · main". */
  remoteNames: Map<string, string>;
  onOpenSession: (sessionId: string, target: string, branch: string | null) => void;
}

// Same tones as Recent Agent Sessions: a session must not change colour just
// because it is also starred.
const statusTone: Record<ProjectAgentSessionActivity["status"], DotTone> = {
  running: "blue",
  stopped: "lime",
  error: "rose",
  unknown: "neutral",
};

function sessionTitle(session: ProjectAgentSessionActivity): string {
  return session.title?.trim() || session.branch || "Main workspace session";
}

/**
 * The starred sessions of one project, newest star first (the server owns that
 * order). Sits above Attention Required because it is the list the user curated
 * themselves — they should find it in the same place every time, whether or not
 * anything is currently broken.
 */
export function StarredSessionsCard({ sessions, remoteNames, onOpenSession }: StarredSessionsCardProps) {
  return (
    <ActivityCard>
      <ActivityCardTitle
        icon={<Star className="size-3 fill-current text-amber-500" aria-hidden="true" />}
        trailing={<ActivityCardCount>{sessions.length}</ActivityCardCount>}
      >
        Starred Sessions
      </ActivityCardTitle>

      {sessions.length === 0 ? (
        <ActivityCardEmpty>No starred sessions — star one to keep it here</ActivityCardEmpty>
      ) : (
        sessions.map((session) => {
          const title = sessionTitle(session);
          return (
            <ActivityRow
              key={`${session.target}:${session.id}`}
              data-testid="starred-session"
              aria-label={`Open starred session: ${title}`}
              onClick={() => onOpenSession(session.id, session.workspace.target, session.workspace.branch)}
            >
              <StatusDot
                tone={statusTone[session.status]}
                pulse={session.status === "running"}
                className="mt-[5px]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{title}</span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
                  <GitBranch className="size-2.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                  <span className="truncate">{workspaceLabel(session.workspace, remoteNames)}</span>
                </span>
              </span>
            </ActivityRow>
          );
        })
      )}
    </ActivityCard>
  );
}
