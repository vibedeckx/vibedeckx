import type { GlobalEvent } from "./event-bus.js";

/**
 * Routes GlobalEvents to SSE connections by project owner.
 *
 * Events carry a projectId but no userId. Instead of every connection asking
 * the DB "is this project mine?" per event (O(events × connections) queries,
 * resolved concurrently and therefore free to reorder), the fanout resolves
 * the owner once per project, caches it, and writes only to that owner's
 * connections. Trusted connections (solo mode, userId === null) see every event.
 *
 * A project's owner never changes after creation (`projects.user_id` is never
 * updated) and ids are not reused, so cached owners never go stale; a deleted
 * project's entry just ages out of the bounded cache. Missing projects are not
 * cached, so an event racing a project's creation is retried on the next one.
 *
 * Ordering: while a project's owner lookup is in flight, its events queue and
 * flush in emit order once the lookup resolves; after that delivery is
 * synchronous. Per-connection event order therefore matches emit order.
 */

export type EventSink = (event: GlobalEvent) => void;

export interface EventFanoutOptions {
  /** Owner user_id of a project, or undefined if it does not exist. */
  getOwnerId: (projectId: string) => Promise<string | undefined>;
  /** Max cached project owners; oldest-used entries are evicted beyond it. */
  maxCachedOwners?: number;
  onError?: (err: unknown, event: GlobalEvent) => void;
}

export class EventFanout {
  private readonly trusted = new Set<EventSink>();
  private readonly byUser = new Map<string, Set<EventSink>>();
  private readonly owners = new Map<string, string>();
  private readonly pending = new Map<string, GlobalEvent[]>();
  private readonly maxCachedOwners: number;

  constructor(private readonly options: EventFanoutOptions) {
    this.maxCachedOwners = Math.max(1, options.maxCachedOwners ?? 10_000);
  }

  /** Register a connection. `userId === null` receives every event. */
  add(userId: string | null, sink: EventSink): () => void {
    if (userId === null) {
      this.trusted.add(sink);
      return () => { this.trusted.delete(sink); };
    }
    let sinks = this.byUser.get(userId);
    if (!sinks) {
      sinks = new Set();
      this.byUser.set(userId, sinks);
    }
    sinks.add(sink);
    return () => {
      const current = this.byUser.get(userId);
      if (!current) return;
      current.delete(sink);
      if (current.size === 0) this.byUser.delete(userId);
    };
  }

  dispatch(event: GlobalEvent): void {
    for (const sink of this.trusted) this.write(sink, event);

    // No user-scoped connections → nobody needs the owner.
    if (this.byUser.size === 0) return;

    const queued = this.pending.get(event.projectId);
    if (queued) {
      queued.push(event);
      return;
    }

    const owner = this.owners.get(event.projectId);
    if (owner !== undefined) {
      // Refresh recency for LRU eviction.
      this.owners.delete(event.projectId);
      this.owners.set(event.projectId, owner);
      this.deliverToUser(owner, event);
      return;
    }

    this.resolve(event);
  }

  private resolve(first: GlobalEvent): void {
    const projectId = first.projectId;
    const queue = [first];
    this.pending.set(projectId, queue);
    this.options.getOwnerId(projectId).then(
      (owner) => {
        this.pending.delete(projectId);
        if (owner !== undefined) this.remember(projectId, owner);
        if (owner === undefined) return;
        for (const event of queue) this.deliverToUser(owner, event);
      },
      (err: unknown) => {
        this.pending.delete(projectId);
        for (const event of queue) this.options.onError?.(err, event);
      },
    );
  }

  private remember(projectId: string, owner: string): void {
    this.owners.set(projectId, owner);
    while (this.owners.size > this.maxCachedOwners) {
      const oldest = this.owners.keys().next().value;
      if (oldest === undefined) break;
      this.owners.delete(oldest);
    }
  }

  private deliverToUser(owner: string, event: GlobalEvent): void {
    const sinks = this.byUser.get(owner);
    if (!sinks) return;
    for (const sink of sinks) this.write(sink, event);
  }

  private write(sink: EventSink, event: GlobalEvent): void {
    try {
      sink(event);
    } catch (err) {
      this.options.onError?.(err, event);
    }
  }

  /** Test/diagnostic visibility. */
  get cachedOwnerCount(): number {
    return this.owners.size;
  }
}
