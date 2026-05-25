"use client";

import { useEffect, useState, useCallback } from "react";
import { ChevronDown, Pencil, Trash2, Check, X, Star } from "lucide-react";
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
  setSessionFavorited,
  type BranchSessionSummary,
} from "@/lib/api";

interface SessionHistoryDropdownProps {
  projectId: string;
  branch: string | null;
  currentSessionId: string | null;
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

  // `reloadToken` is the explicit "re-fetch the list now" signal, bumped only
  // from user events (opening the menu, the Refresh item). Funnelling event
  // refetches through one token — rather than each event/effect calling
  // listBranchSessions() itself — means several bumps in a single commit batch
  // into one token change, i.e. one fetch.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  // The single data-fetching Effect: keep `sessions` synchronized with the
  // server for the current (projectId, branch). Re-runs on a workspace switch,
  // when an AI title arrives (refreshKey), or on an explicit reload(). The
  // `ignore` cleanup discards stale responses, so a rapid A→B→A switch can't
  // render the wrong branch's list out of order — the data-fetch race condition
  // from https://react.dev/learn/you-might-not-need-an-effect#fetching-data.
  //
  // Note it deliberately does NOT depend on `currentSessionId`: switching to a
  // session already in the list doesn't change the list, and that dependency
  // was what fanned a single workspace switch into ~4 identical requests. A
  // brand-new session's row arrives via `refreshKey` once its title is written;
  // until then the parent shows a "Generating title…" loader, so the row's
  // absence is already covered without a refetch here.
  useEffect(() => {
    let ignore = false;
    listBranchSessions(projectId, branch)
      .then((data) => {
        if (!ignore) setSessions(data.sessions);
      })
      .catch((e) => {
        if (!ignore) console.error("[SessionHistoryDropdown] refresh failed:", e);
      });
    return () => {
      ignore = true;
    };
  }, [projectId, branch, refreshKey, reloadToken]);

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

  const handleToggleFavorite = async (id: string, prevTs: number | null) => {
    const next = prevTs == null;
    const nextTs = next ? Date.now() : null;
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, favorited_at: nextTs } : s))
    );
    try {
      await setSessionFavorited(id, next);
    } catch (e) {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, favorited_at: prevTs } : s))
      );
      toast.error(next ? "Favorite failed" : "Unfavorite failed");
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
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Refetch because the user opened the menu — an event, not a render
        // side-effect, so it belongs in the handler rather than an Effect.
        if (next) reload();
      }}
    >
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
                <div className="flex items-center gap-1">
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
                  <button
                    type="button"
                    aria-label={s.favorited_at != null ? "Unfavorite conversation" : "Favorite conversation"}
                    title={s.favorited_at != null ? "Unfavorite" : "Favorite"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleToggleFavorite(s.id, s.favorited_at ?? null);
                    }}
                    className={`p-1 hover:bg-muted rounded ${
                      s.favorited_at != null
                        ? "opacity-100 text-yellow-500"
                        : "opacity-0 group-hover:opacity-100 text-muted-foreground"
                    }`}
                  >
                    <Star
                      className={`h-3 w-3 ${s.favorited_at != null ? "fill-current" : ""}`}
                    />
                  </button>
                </div>
              )}
            </DropdownMenuItem>
          );
        })}
        {sessions.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => reload()} className="text-xs text-muted-foreground">
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
