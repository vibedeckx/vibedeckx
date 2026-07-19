import type { SearchResponse, SearchResultSession } from "@/lib/api";

// Client-side state behind the quick switcher's instant open:
//
// 1. The last empty-query SearchResponse, seeded into the palette on open
//    (stale-while-revalidate). Persisted to localStorage so even the first
//    open after a page reload paints instantly; a TTL keeps a long-dormant
//    snapshot from seeding (better one "Searching…" than content from last
//    week). Synthesizing the seed from the MRU alone was rejected: server
//    recents contain rows this browser never opened (spawned sessions, other
//    devices, never-clicked favorites) — an MRU-only seed would omit them and
//    they'd insert mid-list when the fetch lands. The snapshot also carries
//    cacheState, which the "Syncing history…" empty state needs.
// 2. An MRU-by-open ledger (VS Code Quick Open semantics): merely *opening*
//    a session surfaces it in Recents. The server only orders by activity
//    (last_user_message_at ?? updated_at) and never learns about opens, so
//    opens are tracked here, per browser, and blended in at render.
//
// Both are scoped to the signed-in user (auth-wrapper calls
// setQuickSwitcherCacheUser). Cache writes go through a monotonic fetch
// generation: it bars an out-of-order response from rolling the cache back,
// and — more importantly — lets a user switch invalidate fetches already in
// flight under the previous user's credentials.
//
// There is deliberately NO background refresh between opens. The ordering
// key (last_user_message_at) only moves on user messages — which the user
// sends *inside* an open session, so openedAt tracks it for free — plus rare
// externals (injected prompts, wakes, sessions created elsewhere). Those are
// corrected by the on-open fetch anyway; pre-absorbing them wasn't worth a
// request per navigation.

// Display cap for the merged Recent/Favorites groups — matches the server's
// default limitPerGroup so merging never makes the palette longer than
// server-only rendering did.
const DISPLAY_LIMIT = 10;
const MRU_MAX = 50;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

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

function snapshotKey(): string {
  return `vibedeckx.quickSwitcher.emptyResults.${scopeKey}`;
}

function loadSnapshot(): SearchResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(snapshotKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; res?: Partial<SearchResponse> } | null;
    if (typeof parsed?.at !== "number" || Date.now() - parsed.at > SNAPSHOT_TTL_MS) return null;
    const res = parsed.res;
    if (!res || ![res.projects, res.workspaces, res.sessions, res.favorites].every(Array.isArray)) {
      return null;
    }
    return res as SearchResponse;
  } catch {
    return null;
  }
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
  try {
    localStorage.setItem(snapshotKey(), JSON.stringify({ at: Date.now(), res }));
  } catch {
    // Quota/private-mode failures degrade to memory-only seeding.
  }
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
  // Memory-miss (first open after reload, or after a user switch) falls back
  // to the persisted snapshot. Called once per palette open, so re-probing
  // storage when both are absent is fine.
  cachedEmptyResults ??= loadSnapshot();
  return cachedEmptyResults;
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
