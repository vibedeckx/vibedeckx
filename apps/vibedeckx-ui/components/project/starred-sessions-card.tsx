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
  /** The server capped the list — the count reads "50+" rather than claiming 50 is all of them. */
  hasMore: boolean;
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
 *
 * A long list scrolls in place instead of opening elsewhere: starred sessions
 * are a springboard, not a workspace, so pushing the user through a dialog to
 * reach the eleventh one costs more than it gives. The cap below only binds
 * when the list is long, so a three-star project still renders at its natural
 * height.
 */
export function StarredSessionsCard({ sessions, hasMore, remoteNames, onOpenSession }: StarredSessionsCardProps) {
  return (
    <ActivityCard>
      <ActivityCardTitle
        icon={<Star className="size-3 fill-current text-amber-500" aria-hidden="true" />}
        trailing={<ActivityCardCount>{sessions.length}{hasMore ? "+" : ""}</ActivityCardCount>}
      >
        Starred Sessions
      </ActivityCardTitle>

      {sessions.length === 0 ? (
        <ActivityCardEmpty>No starred sessions — star one to keep it here</ActivityCardEmpty>
      ) : (
        // max-h-96 is the height the session-history dropdown (where the star
        // is toggled) already uses, and it lands mid-row here: a half-visible
        // row is the cue that the list continues. overscroll-contain stops a
        // wheel that reaches the end from scrolling the project page behind it.
        <div
          data-testid="starred-scroller"
          className="max-h-96 overflow-y-auto overscroll-contain"
        >
          {sessions.map((session) => {
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
          })}
        </div>
      )}
    </ActivityCard>
  );
}
