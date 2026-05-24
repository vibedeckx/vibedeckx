"use client";

import { Bell, CheckCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Project } from "@/lib/api";
import type { CompletionNotification } from "@/hooks/use-completion-notifications";

interface CompletionNotificationsMenuProps {
  notifications: CompletionNotification[];
  unreadCount: number;
  projects: Project[];
  /** Switch to the workspace the notification points at. */
  onNavigate: (projectId: string, branch: string | null) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
}

// Completion-type → label + dot color. Colors match the sidebar's `StatusDot`:
// agent completion is lime, chat/main completion is emerald.
const TYPE_META: Record<
  CompletionNotification["type"],
  { label: string; dot: string }
> = {
  completed: { label: "Agent finished", dot: "bg-lime-400" },
  "main-completed": { label: "Chat finished", dot: "bg-emerald-500" },
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={
            unreadCount > 0
              ? `${unreadCount} unread completion notifications`
              : "Completion notifications"
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
                title="Clear all"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto border-t border-border">
          {notifications.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-muted-foreground/70">
              No completions yet.
            </div>
          ) : (
            notifications.map((n) => {
              const meta = TYPE_META[n.type];
              return (
                <DropdownMenuItem
                  key={n.id}
                  onSelect={() => {
                    markRead(n.id);
                    onNavigate(n.projectId, n.branch);
                  }}
                  className={cn(
                    "group relative flex flex-col items-start gap-0.5 rounded-none px-3 py-2 pl-4",
                    !n.read && "bg-primary/[0.04]",
                  )}
                >
                  {!n.read && (
                    <span className="absolute left-1 top-2.5 h-2 w-2 rounded-full bg-primary" />
                  )}
                  <div className="flex w-full items-center gap-2">
                    <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", meta.dot)} />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-[12.5px]",
                        n.read ? "text-foreground/70" : "font-medium text-foreground",
                      )}
                    >
                      {projectName(n.projectId)}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground/70">
                      {formatRelativeTime(n.at)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(n.id);
                      }}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100"
                      title="Dismiss"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex w-full items-center gap-1.5 pl-[15px] text-[11px] text-muted-foreground">
                    <span className="font-mono truncate">{n.branch ?? "main"}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="shrink-0">{meta.label}</span>
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
