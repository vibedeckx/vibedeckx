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

export interface CacheEntry {
  /** Raw serialized WS messages (JsonPatch, taskCompleted, error, etc.) */
  messages: string[];
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
  sessionStatus: "running" | "stopped" | "error" | null;
}

export class RemotePatchCache {
  private cache = new Map<string, CacheEntry>();

  getOrCreate(sessionId: string): CacheEntry {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = {
        messages: [],
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
    this.cache.set(sessionId, {
      messages,
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
    this.getOrCreate(sessionId).historyEpoch = epoch;
  }

  /** Start a fresh entry-index namespace without dropping live connections. */
  resetHistory(sessionId: string, epoch: number): void {
    const entry = this.getOrCreate(sessionId);
    entry.messages = [];
    entry.patchCount = 0;
    entry.finished = false;
    entry.historyEpoch = epoch;
    entry.latestEntryIndex = null;
    entry.lastTurnEndEntryIndex = null;
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
