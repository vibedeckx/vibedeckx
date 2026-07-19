"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import {
  searchAll, refreshSearchCache,
  type SearchResponse, type SearchResultWorkspace, type SearchResultSession,
} from "@/lib/api";
import {
  beginEmptyQuerySearch, commitEmptyQueryResults, getCachedEmptyResults, overlayRecents,
} from "@/lib/quick-switcher-cache";
import { FolderGit2, GitBranch, Loader2, MessageSquare, Star } from "lucide-react";

export interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigateProject: (projectId: string) => void;
  onNavigateWorkspace: (w: SearchResultWorkspace) => void;
  onNavigateSession: (s: SearchResultSession) => void;
}

function relativeTime(ms: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function QuickSwitcher({
  open, onOpenChange, onNavigateProject, onNavigateWorkspace, onNavigateSession,
}: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryRef = useRef("");
  // Layout effect (not passive effect): it flushes synchronously in the same
  // commit as the query render, so an async consumer (e.g. a fast
  // refreshSearchCache() completion) can never read a one-render-stale query.
  useLayoutEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Reset query/results/error on each open→close→open transition. Adjusted
  // during render (React's documented pattern for "resetting state when a
  // prop changes") rather than in an effect, so it can't trigger a
  // synchronous setState-in-effect cascade. Results seed from the cached
  // empty-query response (matching the reset "" query) so reopen paints
  // instantly; a filtered result set from the previous open never flashes.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery("");
      setResults(getCachedEmptyResults());
      setError(false);
    }
  }

  // Abort in-flight requests on new input so a stale response can never
  // overwrite a newer query's results. Empty-query responses also feed the
  // module cache, generation-guarded against the background refresher.
  const runSearch = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = q === "" ? beginEmptyQuerySearch() : null;
    try {
      const res = await searchAll(q, { signal: controller.signal });
      if (!controller.signal.aborted) {
        if (gen !== null) commitEmptyQueryResults(gen, res);
        setResults(res);
        setError(false);
      }
    } catch {
      if (!controller.signal.aborted) setError(true);
    }
  }, []);

  // Debounced server-side search (cmdk filtering is off). This single effect
  // also handles the on-open initial fetch: on the open transition it fires
  // immediately (0ms) for the reset "" query; subsequent query changes while
  // open debounce at 150ms. Because the render-phase open-reset commits query
  // as "" in the same render that flips `open`, this effect runs exactly once
  // per open — so exactly one initial empty-query search fires per open.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(query), justOpened ? 0 : 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, runSearch]);

  // On open: one background cache refresh, then a re-query with whatever the
  // user has typed by then (queryRef — kept commit-fresh via useLayoutEffect).
  // The initial cached-results fetch is owned by the debounce effect above.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void refreshSearchCache()
      .then(() => { if (!cancelled) void runSearch(queryRef.current); })
      .catch(() => {});
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [open, runSearch]);

  // Filtered results keep server relevance order; the empty-query view gets
  // the MRU-by-open merge (locally opened sessions can outrank — or re-enter —
  // the server's recency window).
  const display = results
    ? query.trim()
      ? { sessions: results.sessions, favorites: results.favorites }
      : overlayRecents(results)
    : null;
  const loading = results === null;
  const empty = !!display && results!.projects.length === 0 && results!.workspaces.length === 0
    && display.sessions.length === 0 && display.favorites.length === 0;
  const syncing = results?.cacheState === "cold";

  const renderSession = (s: SearchResultSession) => (
    <CommandItem key={s.sessionId} value={`session-${s.sessionId}`} onSelect={() => onNavigateSession(s)}>
      <MessageSquare />
      <span className="truncate">{s.title ?? "Untitled session"}</span>
      {s.favoritedAt && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-amber-500" />}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {s.projectName} · {s.branch ?? "main"} · {relativeTime(s.lastActiveAt)}
      </span>
    </CommandItem>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick Switcher"
      description="Search projects, workspaces, and sessions"
      shouldFilter={false}
    >
      <CommandInput
        placeholder="Search projects, workspaces, sessions…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {error && (
          <div className="flex items-center justify-between gap-2 px-4 py-3 text-sm text-destructive">
            <span>Search failed.</span>
            <Button variant="link" size="sm" className="h-auto p-0 text-destructive" onClick={() => void runSearch(queryRef.current)}>
              Retry
            </Button>
          </div>
        )}
        {!error && loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Searching…
          </div>
        )}
        {!error && !loading && empty && syncing && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Syncing history…
          </div>
        )}
        {!error && !loading && empty && !syncing && <CommandEmpty>No results found.</CommandEmpty>}
        {results && results.projects.length > 0 && (
          <CommandGroup heading="Projects">
            {results.projects.map((p) => (
              <CommandItem key={p.id} value={`project-${p.id}`} onSelect={() => onNavigateProject(p.id)}>
                <FolderGit2 />
                <span>{p.name}</span>
                {p.path && <span className="truncate text-xs text-muted-foreground">{p.path}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {results && results.workspaces.length > 0 && (
          <CommandGroup heading="Workspaces">
            {results.workspaces.map((w) => (
              <CommandItem
                key={`${w.projectId}-${w.targetId}-${w.branch ?? ""}`}
                value={`ws-${w.projectId}-${w.targetId}-${w.branch ?? ""}`}
                onSelect={() => onNavigateWorkspace(w)}
              >
                <GitBranch />
                <span>{w.branch ?? "main"}</span>
                <span className="text-xs text-muted-foreground">{w.projectName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {display && display.sessions.length > 0 && (
          <CommandGroup heading={query.trim() ? "Sessions" : "Recent"}>
            {display.sessions.map(renderSession)}
          </CommandGroup>
        )}
        {display && display.favorites.length > 0 && (
          <CommandGroup heading="Favorites">
            {display.favorites.map(renderSession)}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
