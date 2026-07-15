"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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

// How long after creation we assume a session's AI title may still be
// generating. Within this window an untitled session shows the "Generating
// title…" loader; past it, an untitled session is treated as permanently
// untitled and shows its timestamp. Comfortably above the ~1–2s typical
// generation latency and aligned with the parent's pending-title safety net.
const TITLE_GENERATION_WINDOW_MS = 30_000;

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
  // Sessions whose row has landed in the list but is still awaiting its AI
  // title — surfaced via the self-heal refetch below the moment we observe a
  // freshly-appeared, untitled row. Drives the "Generating title…" loader so
  // the trigger doesn't flash the created_at timestamp while generation runs.
  const [awaitingTitleId, setAwaitingTitleId] = useState<string | null>(null);

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

  // Self-heal a stale list: when the displayed session isn't in our fetched
  // list, refetch once so its row appears. This covers a commander-spawned
  // session auto-surfaced into the open window — its one-shot `titleUpdated` WS
  // broadcast (the usual `refreshKey` trigger) isn't replayed to subscribers
  // that attach after it fires, so this window can miss it and the trigger would
  // otherwise sit on a "Generating title…" placeholder (via `!currentSession`)
  // until the user manually opens the menu. A ref guard ensures we only attempt
  // one refetch per missing session id, so a session that genuinely never lands
  // (cross-branch / remote edge cases) can't spin an infinite refetch loop. We
  // fetch inline (rather than via reload()) so setSessions stays inside the
  // async callback — a synchronous setState here would cascade re-renders.
  const missingSessionReloadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentSessionId) return;
    if (sessions.some((s) => s.id === currentSessionId)) {
      missingSessionReloadRef.current = null;
      return;
    }
    if (missingSessionReloadRef.current === currentSessionId) return;
    missingSessionReloadRef.current = currentSessionId;
    const healingId = currentSessionId;
    let ignore = false;
    listBranchSessions(projectId, branch)
      .then((data) => {
        if (ignore) return;
        setSessions(data.sessions);
        // A self-healed row that landed without a title is a freshly
        // created/surfaced session whose AI title generation is still in
        // flight (its one-shot `titleUpdated` either hasn't fired yet or won't
        // be replayed to this late subscriber). Mark it so the trigger keeps
        // showing the loader instead of flashing the created_at timestamp.
        const landed = data.sessions.find((s) => s.id === healingId);
        const titled =
          !!landed &&
          (aiTitleOverride?.sessionId === landed.id ||
            !!(landed.title && landed.title.trim().length > 0));
        if (landed && !titled) setAwaitingTitleId(healingId);
      })
      .catch((e) => {
        if (!ignore)
          console.error("[SessionHistoryDropdown] missing-session refresh failed:", e);
      });
    return () => {
      ignore = true;
    };
  }, [currentSessionId, sessions, projectId, branch, aiTitleOverride]);

  // The marker needs no explicit clear-on-resolve / clear-on-switch effect:
  // `isAwaitingTitle` already returns false once the row has a resolved title
  // (so the loader yields to the real title on the next render), and it only
  // matches its own session id (so a stale marker can't affect a different
  // current session). The one case left is a title that never arrives — handle
  // that with a single safety timeout so the loader can't spin forever.
  useEffect(() => {
    if (!awaitingTitleId) return;
    const captured = awaitingTitleId;
    const timer = setTimeout(() => {
      setAwaitingTitleId((prev) => (prev === captured ? null : prev));
    }, TITLE_GENERATION_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [awaitingTitleId]);
  useEffect(() => {
    if (!awaitingTitleId) return;
    const captured = awaitingTitleId;
    const timer = setTimeout(() => {
      setAwaitingTitleId((prev) => (prev === captured ? null : prev));
    }, TITLE_GENERATION_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [awaitingTitleId]);

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

  // Does this session have a displayable title yet? (Either a persisted title
  // or the optimistic WS-delivered override.)
  const hasResolvedTitle = (s: BranchSessionSummary): boolean =>
    aiTitleOverride?.sessionId === s.id ||
    !!(s.title && s.title.trim().length > 0);

  // Show the "Generating title…" loader (instead of the bare timestamp) while a
  // session has no resolved title yet AND a title is still incoming — either the
  // parent explicitly armed it (first-message send path) or the self-heal
  // refetch flagged it as a freshly-appeared untitled row (`awaitingTitleId`).
  // The latter covers commander-surfaced sessions, which the parent can't arm
  // (session id + messages land in one commit, so its arming effect's
  // prev-session guard never fires). Older untitled sessions fall through to
  // their timestamp.
  const isAwaitingTitle = (s: BranchSessionSummary): boolean =>
    !hasResolvedTitle(s) && (isTitlePending(s.id) || awaitingTitleId === s.id);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  // Treat "we have a session id but the local list hasn't caught up" as
  // pending — covers the brief window after a freshly created or freshly
  // switched-to session, where currentSession would otherwise be undefined
  // and the trigger would fall through to "History". Once the row lands but is
  // still untitled, `isAwaitingTitle` keeps the loader up (rather than flashing
  // the timestamp) until its AI title arrives.
  const triggerPending =
    currentSessionId !== null &&
    (!currentSession || isAwaitingTitle(currentSession));
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
              // While a rename is in progress, keep focus in the <Input>. Radix
              // menu items focus themselves on pointer-move (see react-menu Item
              // onPointerMove), which would blur the input the moment the cursor
              // twitches — over this row or over any other session row. The
              // item's own handler is gated on `!event.defaultPrevented`, so
              // preventing default on every row while `editingId` is set
              // suppresses the focus-steal menu-wide (padding included).
              onPointerMove={
                editingId !== null ? (e) => e.preventDefault() : undefined
              }
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
                        // Stop the keystroke before it bubbles to Radix's menu
                        // Content, whose typeahead search (react-menu
                        // handleTypeaheadSearch) would otherwise move focus to a
                        // matching item and eject the cursor from this input.
                        e.stopPropagation();
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
                ) : isAwaitingTitle(s) ? (
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
