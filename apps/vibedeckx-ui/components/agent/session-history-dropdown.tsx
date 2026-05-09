"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronDown, Pencil, Trash2, Check, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  listBranchSessions,
  renameSession,
  deleteSession,
  type BranchSessionSummary,
} from "@/lib/api";

interface SessionHistoryDropdownProps {
  projectId: string;
  branch: string | null;
  currentSessionId: string | null;
  currentEntryCount?: number;
  /** Bumping this value forces a session-list refresh (used after the
   *  backend writes an AI-generated title). */
  refreshKey?: number;
  /** When set, the matching session renders a "Generating title…" loader
   *  instead of its persisted title. Cleared once the AI title arrives. */
  pendingTitleSessionId?: string | null;
  /** WS-delivered AI title for a session whose row in `sessions` may still
   *  hold the older snippet title. Used as an optimistic display value to
   *  bridge the gap between WS arrival and the async list refresh — without
   *  it the snippet briefly flashes before the AI title settles in. */
  aiTitleOverride?: { sessionId: string; title: string } | null;
  onSwitch: (sessionId: string) => void;
  onDelete?: (sessionId: string, remaining: BranchSessionSummary[]) => void;
}

export function SessionHistoryDropdown({
  projectId,
  branch,
  currentSessionId,
  currentEntryCount,
  refreshKey,
  pendingTitleSessionId,
  aiTitleOverride,
  onSwitch,
  onDelete,
}: SessionHistoryDropdownProps) {
  const [sessions, setSessions] = useState<BranchSessionSummary[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await listBranchSessions(projectId, branch);
      setSessions(data.sessions);
    } catch (e) {
      console.error("[SessionHistoryDropdown] refresh failed:", e);
    }
  }, [projectId, branch]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Also fetch on mount / whenever the workspace or current session changes, so
  // the trigger button can show the current session's label (not just "History").
  useEffect(() => {
    void refresh();
  }, [refresh, currentSessionId]);

  // Refresh once when the current session receives its first entry — the server
  // auto-sets the session title from the first user message, but the dropdown
  // state was fetched when the session was still untitled, so the button would
  // keep showing the created-at timestamp until reopened.
  const prevEntryRef = useRef<{ sessionId: string | null; count: number }>({
    sessionId: null,
    count: 0,
  });
  useEffect(() => {
    const prev = prevEntryRef.current;
    const count = currentEntryCount ?? 0;
    if (prev.sessionId === currentSessionId && prev.count === 0 && count > 0) {
      void refresh();
    }
    prevEntryRef.current = { sessionId: currentSessionId, count };
  }, [currentSessionId, currentEntryCount, refresh]);

  // Refresh when an external trigger (e.g. an AI-generated title arriving over
  // the agent WebSocket) signals that the persisted title may have changed.
  useEffect(() => {
    if (refreshKey === undefined) return;
    void refresh();
  }, [refreshKey, refresh]);

  const handleRename = async (id: string, next: string) => {
    const title = next.trim().length > 0 ? next.trim() : null;
    try {
      await renameSession(id, title);
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
      setEditingId(null);
      toast.success("Renamed");
    } catch (e) {
      toast.error("Rename failed");
      console.error(e);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await deleteSession(id);
      const remaining = sessions.filter((s) => s.id !== id);
      setSessions(remaining);
      onDelete?.(id, remaining);
      toast.success("Deleted");
    } catch (e) {
      toast.error("Delete failed");
      console.error(e);
    }
  };

  const label = (s: BranchSessionSummary): string => {
    if (aiTitleOverride && aiTitleOverride.sessionId === s.id) {
      return aiTitleOverride.title;
    }
    if (s.title && s.title.trim().length > 0) return s.title;
    return s.updated_at
      ? new Date(s.updated_at).toLocaleString()
      : new Date(s.created_at).toLocaleString();
  };

  const isTitlePending = (sessionId: string) =>
    pendingTitleSessionId !== null && pendingTitleSessionId === sessionId;

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  // Treat "we have a session id but the local list hasn't caught up" as
  // pending — covers the brief window after a freshly created or freshly
  // switched-to session, where currentSession would otherwise be undefined
  // and the trigger would fall through to "History".
  const triggerPending =
    currentSessionId !== null &&
    (isTitlePending(currentSessionId) || !currentSession);
  // No currentSessionId → user is in the placeholder state after clicking
  // New Conversation; show "New Session" rather than "History".
  const triggerLabel = currentSession
    ? label(currentSession)
    : currentSessionId === null
      ? "New Session"
      : "History";
  const triggerTitle = triggerPending ? "Generating title…" : triggerLabel;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1 w-[200px] justify-start"
          title={triggerTitle}
        >
          {triggerPending ? (
            <span
              className="block h-3 flex-1 rounded-sm bg-accent animate-pulse"
              role="status"
              aria-label="Generating title"
            />
          ) : (
            <span className="truncate flex-1 text-left">{triggerLabel}</span>
          )}
          <ChevronDown className="h-3 w-3 flex-shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 max-h-96 overflow-y-auto">
        {sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-muted-foreground">No history yet.</div>
        )}
        {sessions.map((s) => {
          const isCurrent = s.id === currentSessionId;
          const editing = editingId === s.id;
          return (
            <DropdownMenuItem
              key={s.id}
              onSelect={(e) => {
                if (editing) e.preventDefault();
                else if (!isCurrent) onSwitch(s.id);
              }}
              className={`flex items-center gap-2 group ${
                isCurrent ? "bg-accent text-accent-foreground" : ""
              }`}
            >
              <div className="flex-1 min-w-0">
                {editing ? (
                  <div className="flex items-center gap-1">
                    <Input
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleRename(s.id, editingValue);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      autoFocus
                      className="h-6 text-xs"
                    />
                    <button
                      type="button"
                      aria-label="Save rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRename(s.id, editingValue);
                      }}
                    >
                      <Check className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label="Cancel rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(null);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : isTitlePending(s.id) ? (
                  <div className="py-0.5" title="Generating title…">
                    <span
                      className="block h-3 w-40 rounded-sm bg-accent animate-pulse"
                      role="status"
                      aria-label="Generating title"
                    />
                  </div>
                ) : (
                  <div
                    className="truncate text-xs"
                    title={`${
                      s.updated_at
                        ? new Date(s.updated_at).toLocaleString()
                        : new Date(s.created_at).toLocaleString()
                    } • ${s.entry_count ?? 0} messages • status: ${s.status}`}
                  >
                    {label(s)}
                  </div>
                )}
              </div>
              {!editing && (
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1">
                  <button
                    type="button"
                    aria-label="Rename conversation"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(s.id);
                      setEditingValue(s.title ?? "");
                    }}
                    className="p-1 hover:bg-muted rounded"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(s.id);
                    }}
                    className="p-1 hover:bg-muted rounded text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </DropdownMenuItem>
          );
        })}
        {sessions.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => void refresh()} className="text-xs text-muted-foreground">
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
