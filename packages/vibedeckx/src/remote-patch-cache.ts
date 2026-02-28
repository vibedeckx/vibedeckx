/**
 * In-memory cache for remote agent session WebSocket messages.
 *
 * Stores the raw serialized WS messages that flow through the proxy so that
 * returning to a previously-visited remote workspace can replay history from
 * local memory instead of re-fetching everything from the remote server.
 */

export interface CacheEntry {
  /** Raw serialized WS messages (JsonPatch, taskCompleted, error, etc.) */
  messages: string[];
  /** Count of JsonPatch messages only (used for delta calculations during sync) */
  patchCount: number;
  /** Whether the remote sent { finished: true } */
  finished: boolean;
}

export class RemotePatchCache {
  private cache = new Map<string, CacheEntry>();

  getOrCreate(sessionId: string): CacheEntry {
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = { messages: [], patchCount: 0, finished: false };
      this.cache.set(sessionId, entry);
    }
    return entry;
  }

  get(sessionId: string): CacheEntry | undefined {
    return this.cache.get(sessionId);
  }

  hasData(sessionId: string): boolean {
    const entry = this.cache.get(sessionId);
    return !!entry && entry.patchCount > 0;
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
    }
  }

  /** Full cache replacement (used when cache is detected as stale). */
  replaceAll(sessionId: string, messages: string[], patchCount: number): void {
    this.cache.set(sessionId, { messages, patchCount, finished: false });
  }

  setFinished(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (entry) {
      entry.finished = true;
    }
  }

  delete(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}
