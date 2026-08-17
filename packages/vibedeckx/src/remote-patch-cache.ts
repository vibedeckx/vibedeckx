/**
 * In-memory cache for remote agent session WebSocket messages.
 *
 * Stores the raw serialized WS messages that flow through the proxy so that
 * returning to a previously-visited remote workspace can replay history from
 * local memory instead of re-fetching everything from the remote server.
 *
 * Also manages persistent remote WebSocket connections and frontend subscriber
 * tracking so that remote output is always cached even when no frontend is
 * connected.
 */

import type WebSocket from "ws";

function patchEntryMetadata(raw: string): { latest: number | null; lastTurnEnd: number | null } {
  let latest: number | null = null;
  let lastTurnEnd: number | null = null;
  try {
    const parsed = JSON.parse(raw) as {
      JsonPatch?: Array<{ path?: string; value?: { type?: string; content?: { type?: string } } }>;
    };
    for (const op of parsed.JsonPatch ?? []) {
      const match = op.path?.match(/^\/entries\/(\d+)$/);
      if (!match) continue;
      const index = Number(match[1]);
      latest = Math.max(latest ?? -1, index);
      if (op.value?.type === "ENTRY" && op.value.content?.type === "turn_end") {
        lastTurnEnd = Math.max(lastTurnEnd ?? -1, index);
      }
    }
  } catch { /* raw frames are best-effort cache metadata */ }
  return { latest, lastTurnEnd };
}

/** Nearest-rank percentile over an ascending array. 0 when empty. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * The interval this cache is authorized to be complete over.
 *
 * Deliberately derived from what was REQUESTED upstream, never inferred from
 * the lowest entry that happened to arrive: a bounded replay (`after=N`) that
 * returns zero entries still means "this cache knows nothing below N+1", and an
 * arrival-derived low-water mark has no data to say so. Caches in exactly that
 * state — a lone `/status` frame, zero entries — are common in production logs.
 *
 * The violation this guards (a subscriber whose cursor predates `start` being
 * told its history is complete) is reachable by construction but has NOT been
 * observed: replaying this rule over 9 days of hub logs found 0 violations in
 * 1075 cached replays. That measurement is why the gate ships observe-only
 * first — see the COVERAGE GAP warning in websocket-routes.
 */
export interface CacheCoverage {
  /** Entry-index namespace this statement belongs to; null when not yet known. */
  epoch: number | null;
  /** Lowest entry index the cache is authorized to be complete from. */
  start: number;
}

/**
 * Whether the cache may answer a subscriber's replay request by itself — i.e.
 * whether a `Ready` after that replay would be a provable claim rather than an
 * assumption. Pure so both the route and its tests can name the rule directly.
 */
export function coverageAdmitsReplay(
  coverage: CacheCoverage | null,
  clientEpoch: number | undefined,
  afterEntryIndex: number | undefined,
): boolean {
  // No statement at all — the cache cannot prove anything about its own head.
  if (!coverage) return false;
  // A cursor from a different namespace names unrelated entries.
  if (clientEpoch !== undefined && coverage.epoch !== null && clientEpoch !== coverage.epoch) return false;
  return (afterEntryIndex ?? -1) + 1 >= coverage.start;
}

export interface RemotePatchCacheStats {
  sessions: number;
  messages: number;
  approx_bytes: number;
  /** Sessions still holding a persistent WS to their worker. */
  with_remote_ws: number;
  with_subscribers: number;
  subscribers: number;
  /** Sessions the worker reported finished — no further frames will arrive. */
  finished_sessions: number;
  finished_approx_bytes: number;
  /** Sessions with no browser attached right now. */
  unwatched_sessions: number;
  unwatched_approx_bytes: number;
  per_session_approx_bytes: { p50: number; p95: number; p99: number; max: number };
}

export interface CacheEntry {
  /** Raw serialized WS messages (JsonPatch, taskCompleted, error, etc.) */
  messages: string[];
  /**
   * Running size of `messages` in UTF-16 code units, kept O(1) to maintain
   * (unlike Buffer.byteLength on every frame). This is NOT a byte count:
   * conversation text is frequently non-ASCII (CJK costs 3 UTF-8 bytes per
   * unit) and it ignores V8's per-string and per-object overhead. Any budget
   * derived from it must be calibrated in this same unit rather than treated
   * as bytes or as heap footprint. Maintained here rather than summed on read
   * because the per-session budget this cache needs next has to consult it on
   * the append path.
   */
  approxBytes: number;
  /** Count of JsonPatch messages only */
  patchCount: number;
  /** Whether the remote sent { finished: true } */
  finished: boolean;
  /** Persistent WebSocket connection to the remote server (null if not connected) */
  remoteWs: WebSocket | null;
  /** Set of frontend WebSocket connections subscribed to this session */
  subscribers: Set<WebSocket>;
  /** Whether a reconnection attempt is in progress / scheduled */
  reconnecting: boolean;
  /** Timer handle for the next reconnection attempt (null if none scheduled) */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Current reconnection attempt count (reset on successful stable connection) */
  reconnectAttempt: number;
  /** Worker-reported entry-index namespace, when supported. */
  historyEpoch: number | null;
  latestEntryIndex: number | null;
  lastTurnEndEntryIndex: number | null;
  /** Authorized completeness interval; null means "unknown, prove nothing". */
  coverage: CacheCoverage | null;
  sessionStatus: "running" | "stopped" | "error" | null;
}

export class RemotePatchCache {
  private cache = new Map<string, CacheEntry>();

  getOrCreate(sessionId: string): CacheEntry {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = {
        messages: [],
        approxBytes: 0,
        patchCount: 0,
        finished: false,
        remoteWs: null,
        subscribers: new Set(),
        reconnecting: false,
        reconnectTimer: null,
        reconnectAttempt: 0,
        historyEpoch: null,
        latestEntryIndex: null,
        lastTurnEndEntryIndex: null,
        coverage: null,
        sessionStatus: null,
      };
      this.cache.set(sessionId, entry);
    }
    return entry;
  }

  get(sessionId: string): CacheEntry | undefined {
    return this.cache.get(sessionId);
  }

  hasData(sessionId: string): boolean {
    const entry = this.cache.get(sessionId);
    return !!entry && entry.messages.length > 0;
  }

  /**
   * Append a raw WS message to the cache.
   * @param raw - The serialized message string
   * @param isJsonPatch - Whether this message is a JsonPatch (increments patchCount)
   */
  appendMessage(sessionId: string, raw: string, isJsonPatch: boolean): void {
    const entry = this.getOrCreate(sessionId);
    entry.messages.push(raw);
    entry.approxBytes += raw.length;
    if (isJsonPatch) {
      entry.patchCount++;
      const metadata = patchEntryMetadata(raw);
      if (metadata.latest !== null) entry.latestEntryIndex = Math.max(entry.latestEntryIndex ?? -1, metadata.latest);
      if (metadata.lastTurnEnd !== null) {
        entry.lastTurnEndEntryIndex = Math.max(entry.lastTurnEndEntryIndex ?? -1, metadata.lastTurnEnd);
      }
    }
  }

  /** Full cache replacement (used when cache is detected as stale). */
  replaceAll(sessionId: string, messages: string[], patchCount: number): void {
    const existing = this.cache.get(sessionId);
    // Preserve persistent WS, subscribers, and reconnection state across cache replacement
    const remoteWs = existing?.remoteWs ?? null;
    const subscribers = existing?.subscribers ?? new Set<WebSocket>();
    const reconnecting = existing?.reconnecting ?? false;
    const reconnectTimer = existing?.reconnectTimer ?? null;
    const reconnectAttempt = existing?.reconnectAttempt ?? 0;
    const historyEpoch = existing?.historyEpoch ?? null;
    let latestEntryIndex: number | null = null;
    let lastTurnEndEntryIndex: number | null = null;
    for (const raw of messages) {
      const metadata = patchEntryMetadata(raw);
      if (metadata.latest !== null) latestEntryIndex = Math.max(latestEntryIndex ?? -1, metadata.latest);
      if (metadata.lastTurnEnd !== null) lastTurnEndEntryIndex = Math.max(lastTurnEndEntryIndex ?? -1, metadata.lastTurnEnd);
    }
    const sessionStatus = existing?.sessionStatus ?? null;
    // Coverage is carried, never recomputed from `messages`. `replaceEntryTail`
    // funnels through here and only ever rewrites entries ABOVE a cursor, so
    // recomputing would silently raise the low-water mark and hand back exactly
    // the unprovable `Ready` this field exists to prevent.
    const coverage = existing?.coverage ?? null;
    this.cache.set(sessionId, {
      messages,
      approxBytes: messages.reduce((sum, raw) => sum + raw.length, 0),
      patchCount,
      finished: false,
      remoteWs,
      subscribers,
      reconnecting,
      reconnectTimer,
      reconnectAttempt,
      historyEpoch,
      latestEntryIndex,
      lastTurnEndEntryIndex,
      coverage,
      sessionStatus,
    });
  }

  /**
   * Replace only the unsealed entry tail. Completed entries at or before the
   * cursor and non-entry lifecycle frames stay cached; replayed tail frames
   * become the authoritative copy after a tunnel reconnect.
   */
  replaceEntryTail(sessionId: string, afterEntryIndex: number, tail: string[]): void {
    const entry = this.getOrCreate(sessionId);
    const kept = entry.messages.filter((raw) => {
      try {
        const parsed = JSON.parse(raw) as { JsonPatch?: Array<{ path?: string }> };
        if (!Array.isArray(parsed.JsonPatch)) return true;
        const indices = parsed.JsonPatch.flatMap((op) => {
          const match = op.path?.match(/^\/entries\/(\d+)$/);
          return match ? [Number(match[1])] : [];
        });
        return indices.length === 0 || indices.some((index) => index <= afterEntryIndex);
      } catch {
        return true;
      }
    });
    const messages = [...kept, ...tail];
    const patchCount = messages.reduce((count, raw) => {
      try {
        const parsed = JSON.parse(raw) as { JsonPatch?: unknown };
        return count + (Array.isArray(parsed.JsonPatch) ? 1 : 0);
      } catch {
        return count;
      }
    }, 0);
    this.replaceAll(sessionId, messages, patchCount);
  }

  setFinished(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (entry) {
      entry.finished = true;
    }
  }

  setHistoryEpoch(sessionId: string, epoch: number): void {
    const entry = this.getOrCreate(sessionId);
    entry.historyEpoch = epoch;
    if (!entry.coverage) return;
    // A REST seed can be declared before any frame names the namespace. Adopting
    // the epoch we now learn is safe precisely because a namespace REPLACEMENT
    // arrives as `HistorySync{reset}` → `resetHistory`, which overwrites
    // coverage outright rather than coming through here.
    if (entry.coverage.epoch === null) entry.coverage.epoch = epoch;
    else if (entry.coverage.epoch !== epoch) entry.coverage = null;
  }

  /**
   * Record the interval this cache was authorized to fetch. Callers pass the
   * lower bound they REQUESTED upstream — 0 for an unbounded replay, N+1 for
   * `after=N`, the window's first index for a REST seed — not what came back.
   */
  declareCoverage(sessionId: string, coverage: CacheCoverage): void {
    this.getOrCreate(sessionId).coverage = { ...coverage };
  }

  /** Start a fresh entry-index namespace without dropping live connections. */
  resetHistory(sessionId: string, epoch: number): void {
    const entry = this.getOrCreate(sessionId);
    entry.messages = [];
    entry.approxBytes = 0;
    entry.patchCount = 0;
    entry.finished = false;
    entry.historyEpoch = epoch;
    entry.latestEntryIndex = null;
    entry.lastTurnEndEntryIndex = null;
    // A fresh namespace holds nothing, so it is complete from its own start —
    // there is no index below 0 that could be missing.
    entry.coverage = { epoch, start: 0 };
  }

  setLastTurnEndEntryIndex(sessionId: string, index: number): void {
    this.getOrCreate(sessionId).lastTurnEndEntryIndex = index;
  }

  setSessionStatus(sessionId: string, status: "running" | "stopped" | "error"): void {
    this.getOrCreate(sessionId).sessionStatus = status;
  }

  /** Store a persistent remote WebSocket connection. */
  setRemoteWs(sessionId: string, ws: WebSocket | null): void {
    const entry = this.getOrCreate(sessionId);
    entry.remoteWs = ws;
  }

  /** Get the persistent remote WS if it exists and is open. */
  getRemoteWs(sessionId: string): WebSocket | null {
    const entry = this.cache.get(sessionId);
    if (!entry?.remoteWs) return null;
    // WebSocket.OPEN === 1
    if (entry.remoteWs.readyState !== 1) {
      entry.remoteWs = null;
      return null;
    }
    return entry.remoteWs;
  }

  /** Add a frontend WebSocket as a subscriber. */
  addSubscriber(sessionId: string, frontendWs: WebSocket): void {
    const entry = this.getOrCreate(sessionId);
    entry.subscribers.add(frontendWs);
  }

  /** Remove a frontend WebSocket subscriber. */
  removeSubscriber(sessionId: string, frontendWs: WebSocket): void {
    const entry = this.cache.get(sessionId);
    if (entry) {
      entry.subscribers.delete(frontendWs);
    }
  }

  // ---- Reconnection state management ----

  setReconnecting(sessionId: string, value: boolean): void {
    const entry = this.getOrCreate(sessionId);
    entry.reconnecting = value;
  }

  isReconnecting(sessionId: string): boolean {
    const entry = this.cache.get(sessionId);
    return !!entry?.reconnecting;
  }

  setReconnectTimer(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
    const entry = this.getOrCreate(sessionId);
    // Clear any existing timer first
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
    }
    entry.reconnectTimer = timer;
  }

  clearReconnectTimer(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (entry?.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
  }

  getReconnectAttempt(sessionId: string): number {
    return this.cache.get(sessionId)?.reconnectAttempt ?? 0;
  }

  incrementReconnectAttempt(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (entry) entry.reconnectAttempt++;
  }

  resetReconnectAttempt(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (entry) entry.reconnectAttempt = 0;
  }

  /**
   * Aggregate capacity snapshot for the operator memory endpoint.
   *
   * Deliberately aggregate-only — no session ids, no server names, no user ids
   * — because the surface that exposes it spans tenants (same constraint as
   * worker-version-stats).
   *
   * The two breakdowns are the ones that decide whether a cap is worth
   * building: `finished_*` is memory held for sessions that will never receive
   * another frame, and `unwatched_*` is memory held with no browser attached.
   * Both are pure retention cost — a large share in either is the signal that
   * per-session budgets and LRU eviction are needed rather than optional.
   */
  stats(): RemotePatchCacheStats {
    let approxBytes = 0;
    let messages = 0;
    let withRemoteWs = 0;
    let subscribers = 0;
    let withSubscribers = 0;
    let finishedSessions = 0;
    let finishedApproxBytes = 0;
    let unwatchedSessions = 0;
    let unwatchedApproxBytes = 0;
    const sizes: number[] = [];

    for (const entry of this.cache.values()) {
      approxBytes += entry.approxBytes;
      messages += entry.messages.length;
      sizes.push(entry.approxBytes);
      if (entry.remoteWs) withRemoteWs++;
      subscribers += entry.subscribers.size;
      if (entry.subscribers.size > 0) {
        withSubscribers++;
      } else {
        unwatchedSessions++;
        unwatchedApproxBytes += entry.approxBytes;
      }
      if (entry.finished) {
        finishedSessions++;
        finishedApproxBytes += entry.approxBytes;
      }
    }

    sizes.sort((a, b) => a - b);
    return {
      sessions: this.cache.size,
      messages,
      approx_bytes: approxBytes,
      with_remote_ws: withRemoteWs,
      with_subscribers: withSubscribers,
      subscribers,
      finished_sessions: finishedSessions,
      finished_approx_bytes: finishedApproxBytes,
      unwatched_sessions: unwatchedSessions,
      unwatched_approx_bytes: unwatchedApproxBytes,
      per_session_approx_bytes: {
        p50: percentile(sizes, 0.5),
        p95: percentile(sizes, 0.95),
        p99: percentile(sizes, 0.99),
        max: sizes.length > 0 ? sizes[sizes.length - 1] : 0,
      },
    };
  }

  /** Broadcast a raw message to all subscribers, auto-removing dead ones. */
  broadcast(sessionId: string, raw: string): void {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    for (const ws of entry.subscribers) {
      try {
        ws.send(raw);
      } catch {
        entry.subscribers.delete(ws);
      }
    }
  }

  /**
   * Close all remote WebSockets and clear all reconnect timers for graceful shutdown
   */
  shutdown(): void {
    for (const [id, entry] of this.cache) {
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
      }
      if (entry.remoteWs) {
        try { entry.remoteWs.close(); } catch { /* ignore */ }
      }
    }
    this.cache.clear();
  }

  delete(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (entry) {
      // Clear reconnect timer first to prevent respawning
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
      }
      // Close persistent remote WS if open
      if (entry.remoteWs) {
        try {
          entry.remoteWs.close();
        } catch { /* ignore */ }
      }
    }
    this.cache.delete(sessionId);
  }
}
