import type { NotificationService } from "./notification-service.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import type {
  Notification,
  NotificationOutboxEvent,
  RemoteSessionMapping,
  Storage,
} from "./storage/types.js";
import { MAX_EVENTS_PER_SESSION, MAX_SESSIONS_PER_REQUEST } from "./routes/notification-outbox-routes.js";
import { proxyToRemoteAuto, type ProxyResult } from "./utils/remote-proxy.js";

/**
 * Pulls worker milestone outboxes into this front server's notification inbox.
 *
 * Works over `proxyToRemoteAuto`, so direct-HTTP and reverse-connect workers use
 * one code path. Recovery is independent of whether any session WebSocket or
 * browser tab is open: the front asks for the sessions it has persisted mappings
 * for, on a cursor, and imports whatever it finds.
 *
 * See docs/plans/2026-07-25-persistent-notification-milestones-design.md
 * §Remote Outbox Synchronization.
 */

const OUTBOX_QUERY_PATH = "/api/notification-outbox/query";
const QUERY_TIMEOUT_MS = 15_000;

/**
 * How long after activity a mapping stays in the periodic-poll set. Ordinary
 * polling only touches watched mappings, so a server with years of history
 * doesn't re-query all of it every tick; startup and remote-came-online sweeps
 * pass `includeExpired` to still recover events produced during downtime.
 */
export const WATCH_WINDOW_MS = 30 * 60 * 1000;

const SYNC_INTERVAL_MS = 60_000;

/** Bound on hasMore-following so a misbehaving worker can't spin us forever. */
const MAX_PAGES_PER_SYNC = 50;

interface OutboxSessionResult {
  sessionId: string;
  events: NotificationOutboxEvent[];
  headCursor: number;
  nextCursor: number;
  hasMore: boolean;
}

type ProxyFn = typeof proxyToRemoteAuto;

export interface RemoteNotificationSyncDeps {
  storage: Storage;
  notificationService: NotificationService;
  reverseConnectManager?: ReverseConnectManager;
  /** Injectable for tests; defaults to the real direct/reverse-connect proxy. */
  proxy?: ProxyFn;
}

/** Front-local id for a remote workflow run — mirrors mapRemoteRun's scheme. */
export function localWorkflowRunId(
  remoteServerId: string,
  projectId: string,
  remoteRunId: string,
): string {
  return `remote-${remoteServerId}-${projectId}-${remoteRunId}`;
}

/**
 * Front-local notification id. Namespaced per remote server so two independent
 * workers that both produce `session:s1:turn:2:result-ready` cannot collide in
 * one inbox.
 */
export function localNotificationId(remoteServerId: string, outboxEventId: string): string {
  return `remote:${remoteServerId}:${outboxEventId}`;
}

export class RemoteNotificationSync {
  private readonly storage: Storage;
  private readonly notificationService: NotificationService;
  private readonly reverseConnectManager?: ReverseConnectManager;
  private readonly proxy: ProxyFn;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Serializes sweeps so a came-online sweep can't interleave with the tick. */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: RemoteNotificationSyncDeps) {
    this.storage = deps.storage;
    this.notificationService = deps.notificationService;
    this.reverseConnectManager = deps.reverseConnectManager;
    this.proxy = deps.proxy ?? proxyToRemoteAuto;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      this.enqueue(() => this.syncAll({ includeExpired: false }));
    }, SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  shutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire-and-forget sweep, queued behind any in-flight one. */
  enqueue(work: () => Promise<void>): void {
    if (this.stopped) return;
    this.chain = this.chain
      .then(work)
      .catch((err) => console.warn("[RemoteNotifications] sync failed:", err));
  }

  /** Extend a mapping's periodic-poll window (create / send / workflow start / live activity). */
  async extendWatch(localSessionId: string): Promise<void> {
    await this.storage.remoteSessionMappings
      .extendNotificationWatch(localSessionId, Date.now() + WATCH_WINDOW_MS)
      .catch((err) => console.warn(`[RemoteNotifications] extendWatch(${localSessionId}) failed:`, err));
  }

  /**
   * Called before this front starts a new turn on a remote session.
   *
   * For a `from_now` mapping that has never been initialized, this records the
   * worker's current head FIRST — otherwise the turn we are about to start could
   * finish, be seen as "at or below the head we later record", and be suppressed
   * as history. Returns false when the baseline could not be recorded, in which
   * case the caller must NOT start the turn.
   */
  async prepareForNewTurn(localSessionId: string): Promise<boolean> {
    const mapping = await this.storage.remoteSessionMappings.getByLocal(localSessionId);
    // Not a remote session (or not mapped yet — a create path establishes the
    // mapping itself, as `from_start`): nothing to baseline.
    if (!mapping) return true;

    await this.extendWatch(localSessionId);

    if (mapping.notification_sync_start !== "from_now") return true;
    const existing = await this.storage.notificationSyncCursors.get(
      mapping.remote_server_id, mapping.remote_session_id,
    );
    if (existing !== undefined) return true;

    const target = await this.resolveTarget(mapping);
    if (!target) {
      // No reachable link for this mapping. Failing the turn over a
      // notification baseline would be worse than the mis-suppression risk.
      console.warn(`[RemoteNotifications] no remote link for ${localSessionId}; skipping baseline`);
      return true;
    }

    const result = await this.query(target, [{ sessionId: mapping.remote_session_id, after: 0, headOnly: true }]);
    if (!result.ok) {
      console.warn(
        `[RemoteNotifications] baseline for ${localSessionId} failed (status ${result.status}); refusing to start the turn`,
      );
      return false;
    }
    const sessions = this.parseSessions(result);
    const head = sessions.find((s) => s.sessionId === mapping.remote_session_id)?.headCursor;
    if (head === undefined) {
      console.warn(`[RemoteNotifications] baseline response for ${localSessionId} omitted the session`);
      return false;
    }
    await this.storage.notificationSyncCursors.set(
      mapping.remote_server_id, mapping.remote_session_id, head,
    );
    return true;
  }

  /** Sweep every mapped remote server. */
  async syncAll(opts: { includeExpired: boolean }): Promise<void> {
    const mappings = await this.storage.remoteSessionMappings.getNotificationSyncCandidates({
      now: Date.now(),
      includeExpired: opts.includeExpired,
    });
    for (const [serverId, group] of groupByServer(mappings)) {
      await this.syncMappings(serverId, group);
    }
  }

  /** Sweep one server — used when a reverse connection comes online. */
  async syncServer(remoteServerId: string, opts: { includeExpired: boolean }): Promise<void> {
    const mappings = (await this.storage.remoteSessionMappings.getNotificationSyncCandidates({
      now: Date.now(),
      includeExpired: opts.includeExpired,
    })).filter((m) => m.remote_server_id === remoteServerId);
    if (mappings.length > 0) await this.syncMappings(remoteServerId, mappings);
  }

  private async syncMappings(remoteServerId: string, mappings: RemoteSessionMapping[]): Promise<void> {
    // Chunked so one request can never exceed the worker route's bound, no
    // matter how many historical mappings a full sweep turns up.
    for (let i = 0; i < mappings.length; i += MAX_SESSIONS_PER_REQUEST) {
      const chunk = mappings.slice(i, i + MAX_SESSIONS_PER_REQUEST);
      await this.syncChunk(remoteServerId, chunk).catch((err) =>
        console.warn(`[RemoteNotifications] chunk sync for ${remoteServerId} failed:`, err),
      );
    }
  }

  private async syncChunk(remoteServerId: string, chunk: RemoteSessionMapping[]): Promise<void> {
    const target = await this.resolveTarget(chunk[0]);
    if (!target) {
      console.warn(`[RemoteNotifications] no remote link for server ${remoteServerId}; skipping ${chunk.length} mapping(s)`);
      return;
    }

    // Only sessions still worth asking about; a session drops out once its
    // batch fails validation or it has nothing more.
    let pending = new Map(chunk.map((m) => [m.remote_session_id, m]));

    for (let page = 0; page < MAX_PAGES_PER_SYNC && pending.size > 0; page++) {
      const cursors = await this.storage.notificationSyncCursors.getMany(
        remoteServerId, [...pending.keys()],
      );

      const requests = [...pending.values()].map((mapping) => {
        const cursor = cursors.get(mapping.remote_session_id);
        // A never-initialized from_now mapping asks for the head only: it must
        // establish "start from here" without importing (or sounding) history.
        if (mapping.notification_sync_start === "from_now" && cursor === undefined) {
          return { sessionId: mapping.remote_session_id, after: 0, headOnly: true as const };
        }
        return { sessionId: mapping.remote_session_id, after: cursor ?? 0 };
      });

      const result = await this.query(target, requests);
      if (!result.ok) {
        // Every cursor in this chunk stays exactly where it was; the next sweep
        // retries from the same point.
        console.warn(`[RemoteNotifications] outbox query to ${remoteServerId} failed (status ${result.status})`);
        return;
      }

      const byId = new Map(this.parseSessions(result).map((s) => [s.sessionId, s]));
      const next = new Map<string, RemoteSessionMapping>();

      for (const request of requests) {
        const mapping = pending.get(request.sessionId)!;
        const session = byId.get(request.sessionId);
        // A response that omits a requested session tells us nothing — leave the
        // cursor alone and stop chasing it this sweep.
        if (!session) continue;

        if ("headOnly" in request && request.headOnly) {
          await this.storage.notificationSyncCursors.set(
            remoteServerId, mapping.remote_session_id, session.headCursor,
          );
          // Fall through to the next sweep for actual events: this page
          // deliberately carries none.
          continue;
        }

        const imported = await this.importSession(remoteServerId, mapping, session);
        if (imported && session.hasMore) next.set(request.sessionId, mapping);
      }

      pending = next;
    }
  }

  /**
   * Import one session's page. Returns false when the batch was rejected, in
   * which case its cursor is untouched.
   */
  private async importSession(
    remoteServerId: string,
    mapping: RemoteSessionMapping,
    session: OutboxSessionResult,
  ): Promise<boolean> {
    // Validate the WHOLE batch before importing any of it: a worker must not be
    // able to smuggle another session's milestone in under a key we requested.
    for (const event of session.events) {
      if (event.session_id !== mapping.remote_session_id) {
        console.warn(
          `[RemoteNotifications] ${remoteServerId}: event ${event.id} claims session ${event.session_id}, expected ${mapping.remote_session_id}; rejecting batch`,
        );
        return false;
      }
    }

    // Ownership is derived from OUR project row. A worker never gets to name the
    // tenant a notification lands in.
    const ownerId = await this.storage.projects.getOwnerId(mapping.project_id);
    if (ownerId === undefined) {
      console.warn(`[RemoteNotifications] project ${mapping.project_id} not found; skipping ${mapping.local_session_id}`);
      return false;
    }

    for (const event of session.events) {
      const notification: Notification = await this.notificationService.buildNotification(event, {
        id: localNotificationId(remoteServerId, event.id),
        userId: ownerId || "local",
        projectId: mapping.project_id,
        sessionId: mapping.local_session_id,
        workflowRunId: event.workflow_run_id
          ? localWorkflowRunId(remoteServerId, mapping.project_id, event.workflow_run_id)
          : null,
      });

      const { inserted } = await this.storage.notifications.importRemote({
        notification,
        remoteServerId,
        remoteSessionId: mapping.remote_session_id,
        seq: event.seq,
      });
      if (inserted) this.notificationService.emitCreated(notification);
    }

    // Real activity on this mapping — keep polling it for a while.
    if (session.events.length > 0) await this.extendWatch(mapping.local_session_id);
    return true;
  }

  private async query(
    target: { serverId: string; url: string; apiKey: string },
    sessions: Array<{ sessionId: string; after: number; headOnly?: boolean }>,
  ): Promise<ProxyResult> {
    return this.proxy(
      target.serverId, target.url, target.apiKey,
      "POST", OUTBOX_QUERY_PATH,
      { sessions, limitPerSession: MAX_EVENTS_PER_SESSION },
      { timeoutMs: QUERY_TIMEOUT_MS, reverseConnectManager: this.reverseConnectManager },
    );
  }

  private parseSessions(result: ProxyResult): OutboxSessionResult[] {
    const sessions = (result.data as { sessions?: unknown })?.sessions;
    return Array.isArray(sessions) ? (sessions as OutboxSessionResult[]) : [];
  }

  /**
   * URL/apiKey come from project_remotes — the authoritative source, same as the
   * remoteSessionMap hydration in shared-services. Reverse-connect rows have an
   * empty URL and are routed by server id instead.
   */
  private async resolveTarget(
    mapping: RemoteSessionMapping,
  ): Promise<{ serverId: string; url: string; apiKey: string } | null> {
    const remote = await this.storage.projectRemotes.getByProjectAndServer(
      mapping.project_id, mapping.remote_server_id,
    );
    if (!remote) return null;
    return {
      serverId: mapping.remote_server_id,
      url: remote.server_url ?? "",
      apiKey: remote.server_api_key || "",
    };
  }
}

function groupByServer(mappings: RemoteSessionMapping[]): Map<string, RemoteSessionMapping[]> {
  const groups = new Map<string, RemoteSessionMapping[]>();
  for (const mapping of mappings) {
    const existing = groups.get(mapping.remote_server_id);
    if (existing) existing.push(mapping);
    else groups.set(mapping.remote_server_id, [mapping]);
  }
  return groups;
}
