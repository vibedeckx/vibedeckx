import { searchAll, type SearchResponse, type SearchResultSession } from "@/lib/api";

// Client-side state behind the quick switcher's instant open:
//
// 1. The last empty-query SearchResponse, seeded into the palette on open
//    (stale-while-revalidate) so "Searching…" only ever shows once per page
//    lifetime.
// 2. An MRU-by-open ledger (VS Code Quick Open semantics): merely *opening*
//    a session surfaces it in Recents. The server only orders by activity
//    (last_user_message_at ?? updated_at) and never learns about opens, so
//    opens are tracked here, per browser, and blended in at render.
//
// Both are scoped to the signed-in user (auth-wrapper calls
// setQuickSwitcherCacheUser) and both writers of the response cache go
// through a monotonic fetch generation so an out-of-order response can never
// roll the cache back to an older snapshot.

// Display cap for the merged Recent/Favorites groups — matches the server's
// default limitPerGroup so merging never makes the palette longer than
// server-only rendering did.
const DISPLAY_LIMIT = 10;
const MRU_MAX = 50;

interface RecentOpen {
  openedAt: number;
  // Full server row captured at open time; null when the nav source only knew
  // the id (sidebar, notifications). A full copy lets a session absent from
  // the server's recency window still render in Recent; id-only entries
  // participate only when the server response carries the row. Copies are
  // refreshed from every committed response so titles/favorite state don't
  // fossilize.
  session: SearchResultSession | null;
}

let scopeKey = "solo";
let mru: Map<string, RecentOpen> | null = null; // lazy-loaded per scope
let cachedEmptyResults: SearchResponse | null = null;

// Whichever empty-query fetch *started* last wins the cache, regardless of
// arrival order.
let fetchGeneration = 0;
let committedGeneration = 0;

export function setQuickSwitcherCacheUser(userId: string | null): void {
  const next = userId ?? "solo";
  if (next === scopeKey) return;
  scopeKey = next;
  cachedEmptyResults = null;
  mru = null; // reload from the new scope's storage on next access
  // In-flight fetches were issued under the old user's credentials — bar them
  // from ever committing into the new scope.
  fetchGeneration += 1;
  committedGeneration = fetchGeneration;
}

function storageKey(): string {
  return `vibedeckx.quickSwitcher.recentOpens.${scopeKey}`;
}

function getMru(): Map<string, RecentOpen> {
  if (mru) return mru;
  mru = new Map();
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(storageKey());
      const arr: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (!Array.isArray(e) || typeof e[0] !== "string") continue;
          const v = e[1] as Partial<RecentOpen> | null;
          if (!v || typeof v.openedAt !== "number") continue;
          const session = v.session && typeof v.session.sessionId === "string" ? v.session : null;
          mru.set(e[0], { openedAt: v.openedAt, session });
        }
      }
    } catch {
      // Corrupt entry: start over with an empty MRU.
    }
  }
  return mru;
}

function persistMru(): void {
  if (!mru) return;
  try {
    localStorage.setItem(storageKey(), JSON.stringify([...mru.entries()]));
  } catch {
    // Quota/private-mode failures just lose persistence, not the ledger.
  }
}

/** Call when a fetch whose result should feed the cache is about to start. */
export function beginEmptyQuerySearch(): number {
  fetchGeneration += 1;
  return fetchGeneration;
}

/** Commit an empty-query response; ignored if a newer fetch has started. */
export function commitEmptyQueryResults(gen: number, res: SearchResponse): void {
  if (gen <= committedGeneration) return;
  committedGeneration = gen;
  cachedEmptyResults = res;
  // Refresh stored MRU copies from the fresher server rows.
  const opens = getMru();
  let dirty = false;
  for (const s of [...res.sessions, ...res.favorites]) {
    const entry = opens.get(s.sessionId);
    if (entry) {
      entry.session = s;
      dirty = true;
    }
  }
  if (dirty) persistMru();
}

export function getCachedEmptyResults(): SearchResponse | null {
  return cachedEmptyResults;
}

// Fire-and-forget background refresh, called from navigation choke points:
// navigating away is when recents ordering shifts (activity in the session
// just left), so absorbing it now means the next open paints with an
// already-fresh list. Single-flight; errors leave the cache one generation
// older, which the on-open fetch corrects anyway.
let refreshInFlight = false;
export function refreshQuickSwitcherCache(): void {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const gen = beginEmptyQuerySearch();
  searchAll("")
    .then((res) => commitEmptyQueryResults(gen, res))
    .catch(() => {})
    .finally(() => {
      refreshInFlight = false;
    });
}

/**
 * Record that a session was opened. Pass the full row when the nav source has
 * one (quick-switcher selection); id-only calls bump recency but keep any
 * previously stored copy.
 */
export function touchRecentSessionOpen(sessionId: string, session?: SearchResultSession): void {
  const opens = getMru();
  const prev = opens.get(sessionId);
  opens.delete(sessionId); // re-insert so Map order stays oldest→newest
  opens.set(sessionId, { openedAt: Date.now(), session: session ?? prev?.session ?? null });
  while (opens.size > MRU_MAX) {
    opens.delete(opens.keys().next().value as string);
  }
  persistMru();
}

/**
 * Merge a server response's Recents with the local open ledger:
 * union (server rows win over stored copies) → sort by
 * max(lastActiveAt, openedAt) → dedup by sessionId → cap. Favorites keep the
 * server invariant: favorited rows that didn't make the Recent cut. Pure —
 * applied identically to the cached seed and fresh responses, so the overlay
 * itself can never cause a reorder flash between the two.
 */
export function overlayRecents(res: SearchResponse): {
  sessions: SearchResultSession[];
  favorites: SearchResultSession[];
} {
  const opens = getMru();
  const byId = new Map<string, SearchResultSession>();
  for (const s of [...res.sessions, ...res.favorites]) byId.set(s.sessionId, s);
  for (const [id, o] of opens) {
    if (o.session && !byId.has(id)) byId.set(id, o.session);
  }
  const recency = (s: SearchResultSession) =>
    Math.max(s.lastActiveAt ?? 0, opens.get(s.sessionId)?.openedAt ?? 0);
  const all = [...byId.values()].sort((a, b) => recency(b) - recency(a));
  const sessions = all.slice(0, DISPLAY_LIMIT);
  const inSessions = new Set(sessions.map((s) => s.sessionId));
  const favorites = all
    .filter((s) => s.favoritedAt && !inSessions.has(s.sessionId))
    .slice(0, DISPLAY_LIMIT);
  return { sessions, favorites };
}
