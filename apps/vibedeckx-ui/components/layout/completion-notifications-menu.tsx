"use client";

import { useEffect, useState } from "react";
import { Bell, CheckCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { NotificationKind, Project, ServerNotification } from "@/lib/api";
import { groupNotifications } from "@/hooks/use-completion-notifications";

interface CompletionNotificationsMenuProps {
  notifications: ServerNotification[];
  unreadCount: number;
  projects: Project[];
  /**
   * Switch to the workspace the notification points at. `sessionId` is the exact
   * target session for the `?session=` deep link — null falls back to the
   * branch's latest session.
   */
  onNavigate: (projectId: string, branch: string | null, sessionId: string | null) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
}

/**
 * Kind → label + dot color. Labels mirror the server's semantic titles; the two
 * success colors match the sidebar's `StatusDot`, and both failure kinds use the
 * destructive color so "needs attention" is visually distinct at a glance.
 */
export const KIND_META: Record<NotificationKind, { label: string; dot: string }> = {
  session_result_ready: { label: "Session result is ready", dot: "bg-lime-400" },
  review_ready: { label: "Review feedback is ready", dot: "bg-emerald-500" },
  session_failed: { label: "Session failed", dot: "bg-destructive" },
  workflow_failed: { label: "Workflow needs attention", dot: "bg-destructive" },
};

function formatRelativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function CompletionNotificationsMenu({
  notifications,
  unreadCount,
  projects,
  onNavigate,
  markRead,
  markAllRead,
  remove,
  clear,
}: CompletionNotificationsMenuProps) {
  const projectName = (projectId: string) =>
    projects.find((p) => p.id === projectId)?.name ?? "Unknown project";

  const [open, setOpen] = useState(false);

  // Cmd/Ctrl+J toggles the menu (same family as Cmd+K switcher / Cmd+B
  // sidebar). preventDefault keeps Chrome's downloads panel from opening.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "j" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          title="Notifications (⌘J)"
          aria-label={
            unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"
          }
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-[12.5px] font-semibold text-foreground">
            Notifications
          </span>
          {notifications.length > 0 && (
            <div className="flex items-center gap-1">
              <button
                onClick={markAllRead}
                disabled={unreadCount === 0}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                title="Mark all read"
              >
                <CheckCheck className="h-3 w-3" />
                Mark all read
              </button>
              <button
                onClick={clear}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Dismiss all (marks them read)"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto border-t border-border">
          {notifications.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-muted-foreground/70">
              Nothing needs your attention.
            </div>
          ) : (
            // One entry per attention target: repeated completions of a session
            // collapse onto the newest milestone, with the rest counted in ×N.
            groupNotifications(notifications).map((group) => {
              const n = group.latest;
              const meta = KIND_META[n.kind];
              const unread = group.unread;
              return (
                <DropdownMenuItem
                  key={n.id}
                  onSelect={() => {
                    for (const id of group.ids) markRead(id);
                    onNavigate(n.project_id, n.branch, n.session_id);
                  }}
                  className={cn(
                    "group flex flex-col items-start gap-0.5 rounded-none px-3 py-2",
                    unread && "bg-primary/[0.08]",
                  )}
                >
                  <div className="flex w-full items-center gap-2">
                    <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", meta?.dot)} />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-[12.5px]",
                        unread ? "font-medium text-foreground" : "text-foreground/70",
                      )}
                    >
                      {/* The server's `body` is the most specific label it knows
                          (session title → branch → project); fall back to the
                          project name when it produced none. */}
                      {n.body ?? projectName(n.project_id)}
                    </span>
                    {/* The badge answers "how many since you last looked", so it
                        counts UNREAD members only — read rows stay in the inbox
                        forever, and totalling them would just count history. A
                        single new item needs no number: the unread highlight
                        already says "something new here". */}
                    {group.unreadCount > 1 && (
                      <span
                        className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium leading-4 text-muted-foreground"
                        title={`${group.unreadCount} new notifications, showing the latest`}
                      >
                        ×{group.unreadCount}
                      </span>
                    )}
                    <span className="shrink-0 text-[10.5px] text-muted-foreground/70">
                      {formatRelativeTime(n.created_at)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        for (const id of group.ids) remove(id);
                      }}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100"
                      title="Dismiss (marks it read)"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex w-full items-center gap-1.5 pl-[15px] text-[11px] text-muted-foreground">
                    <span className="font-mono truncate">{n.branch ?? "main"}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="shrink-0">{meta?.label ?? n.title}</span>
                  </div>
                </DropdownMenuItem>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
