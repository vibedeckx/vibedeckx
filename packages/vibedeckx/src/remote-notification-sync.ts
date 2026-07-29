import type { EventBus, GlobalEvent } from "./event-bus.js";
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

/**
 * Minimum spacing between watch extensions driven by observed activity. Remote
 * streams can emit many frames per turn; without this every one would become a
 * DB write. Far below WATCH_WINDOW_MS, so a steadily-active session never lets
 * its window lapse.
 */
export const WATCH_EXTEND_THROTTLE_MS = 5 * 60 * 1000;

/** Cap on the throttle bookkeeping map so a long-lived server can't leak. */
const MAX_TRACKED_SESSIONS = 5_000;

/**
 * Backstop cadence. Recovery only — a turn's milestone rides the completion
 * nudge below, so this tick exists for what the bus never saw (front offline,
 * dropped stream, crash between milestone and import).
 */
const SYNC_INTERVAL_MS = 60_000;

/**
 * Coalescing window for completion-triggered pulls. Long enough that the
 * several terminal frames one finished turn produces (`taskCompleted`, then
 * the `stopped` status patch) become one query, short enough to stay
 * imperceptible next to the round-trip that follows it.
 */
export const COMPLETION_NUDGE_DEBOUNCE_MS = 250;

/**
 * Servers swept at once. Bounded so a front with many workers can't open an
 * unbounded fan of proxy requests, but never 1 — serial sweeping is what let
 * one unreachable worker delay every other worker's import.
 */
const MAX_CONCURRENT_SERVERS = 4;

/** Bound on hasMore-following so a misbehaving worker can't spin us forever. */
const MAX_PAGES_PER_SYNC = 50;

interface OutboxSessionResult {
  sessionId: string;
  events: NotificationOutboxEvent[];
  headCursor: number;
  nextCursor: number;
  hasMore: boolean;
  /** Worker's query-time session title; absent on pre-title workers. */
  sessionTitle?: string | null;
}

/**
 * Cap on worker-supplied display text. The trust level matches the session
 * titles the UI already renders from this worker's proxied streams; the cap
 * just keeps a misbehaving worker from persisting megabytes into inbox rows.
 */
const MAX_SESSION_TITLE_LENGTH = 200;

type ProxyFn = typeof proxyToRemoteAuto;

export interface RemoteNotificationSyncDeps {
  storage: Storage;
  notificationService: NotificationService;
  reverseConnectManager?: ReverseConnectManager;
  /** Injectable for tests; defaults to the real direct/reverse-connect proxy. */
  proxy?: ProxyFn;
  /** Injectable for tests; defaults to COMPLETION_NUDGE_DEBOUNCE_MS. */
  nudgeDebounceMs?: number;
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
  private readonly nudgeDebounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /**
   * Per-server work queues. Two syncs of the SAME server must not interleave
   * (they share its cursors), but two different servers have nothing in
   * common — serializing them globally only meant an unreachable worker's
   * retry budget delayed every healthy worker's import behind it.
   */
  private serverChains = new Map<string, Promise<void>>();
  /** Local session ids whose completion is waiting for the debounce to fire. */
  private nudgeSessions = new Set<string>();
  private nudgeTimer: NodeJS.Timeout | null = null;
  /**
   * Remote sessions this front currently believes are RUNNING. They are polled
   * regardless of their persisted watch window: an agent turn can easily run
   * longer than WATCH_WINDOW_MS while emitting nothing the bus can see, and a
   * mapping that lapsed mid-turn would not be polled when the turn finally
   * produces its milestone.
   */
  private activeRemoteSessions = new Set<string>();
  /** sessionId → last activity-driven watch extension (see WATCH_EXTEND_THROTTLE_MS). */
  private lastWatchExtend = new Map<string, number>();

  constructor(deps: RemoteNotificationSyncDeps) {
    this.storage = deps.storage;
    this.notificationService = deps.notificationService;
    this.reverseConnectManager = deps.reverseConnectManager;
    this.proxy = deps.proxy ?? proxyToRemoteAuto;
    this.nudgeDebounceMs = deps.nudgeDebounceMs ?? COMPLETION_NUDGE_DEBOUNCE_MS;
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
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = null;
    this.nudgeSessions.clear();
    this.activeRemoteSessions.clear();
    this.lastWatchExtend.clear();
  }

  /**
   * Watch live remote activity (design §Mapping initialization and polling).
   *
   * The bus carries the remote stream's bridged `session:status` /
   * `session:taskCompleted` frames plus this front's own emits for remote
   * sessions, so it is the one place that sees a remote session start and stop
   * without threading a callback through the WebSocket plumbing.
   */
  setEventBus(bus: EventBus): void {
    bus.subscribe((event) => this.observeActivity(event));
  }

  private observeActivity(event: GlobalEvent): void {
    const sessionId = (event as { sessionId?: string }).sessionId;
    // Only remote-prefixed ids can have a mapping; local sessions drain locally.
    if (!sessionId || !sessionId.startsWith("remote-")) return;

    if (event.type === "session:status") {
      if (event.status === "running") this.activeRemoteSessions.add(sessionId);
      else this.activeRemoteSessions.delete(sessionId);
    } else if (event.type === "session:taskCompleted" || event.type === "session:finished") {
      // The turn produced its milestone; the watch window extended below is
      // enough to carry the import, so liveness tracking can release it.
      this.activeRemoteSessions.delete(sessionId);
    }

    // A turn just ended: pull its milestone NOW rather than at the next tick.
    // Deliberately BEFORE the watch-extension throttle below — that throttle
    // is a write-rate limiter for a 30-minute window, and every real
    // completion follows recent `running` activity that already consumed it.
    if (isTurnTerminalEvent(event)) this.scheduleCompletionSync(sessionId);

    const now = Date.now();
    const last = this.lastWatchExtend.get(sessionId) ?? 0;
    if (now - last < WATCH_EXTEND_THROTTLE_MS) return;
    if (this.lastWatchExtend.size >= MAX_TRACKED_SESSIONS) this.pruneWatchBookkeeping(now);
    this.lastWatchExtend.set(sessionId, now);
    void this.extendWatch(sessionId);
  }

  /** Drop throttle entries older than a full window — they can only re-extend. */
  private pruneWatchBookkeeping(now: number): void {
    for (const [sessionId, at] of this.lastWatchExtend) {
      if (now - at > WATCH_WINDOW_MS) this.lastWatchExtend.delete(sessionId);
    }
  }

  /**
   * Fire-and-forget sweep. No longer a global queue: the per-server chains
   * inside syncAll/syncServer own the mutual exclusion that actually matters
   * (one server's cursors), so callers here don't wait on unrelated servers.
   */
  enqueue(work: () => Promise<void>): void {
    if (this.stopped) return;
    void work().catch((err) => console.warn("[RemoteNotifications] sync failed:", err));
  }

  /**
   * Queue `work` behind whatever is already running for this server, and
   * nothing else. Errors are contained so one server's failure can't reject
   * an unrelated caller awaiting the same chain.
   */
  private runOnServer(remoteServerId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.serverChains.get(remoteServerId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((err) => console.warn(`[RemoteNotifications] sync for ${remoteServerId} failed:`, err))
      .finally(() => {
        // Only the tail entry may drop the chain, or a queued follow-up would
        // lose its predecessor and run concurrently with it.
        if (this.serverChains.get(remoteServerId) === next) this.serverChains.delete(remoteServerId);
      });
    this.serverChains.set(remoteServerId, next);
    return next;
  }

  /**
   * Debounced, per-server pull for sessions whose turn just ended.
   *
   * Coalescing state is intentionally separate from `lastWatchExtend`: that
   * map throttles DB writes on a 5-minute scale, which would swallow nearly
   * every completion.
   */
  private scheduleCompletionSync(localSessionId: string): void {
    if (this.stopped) return;
    this.nudgeSessions.add(localSessionId);
    if (this.nudgeTimer) return;   // window already open — this id joins it
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      const batch = [...this.nudgeSessions];
      this.nudgeSessions.clear();
      void this.syncSessions(batch).catch((err) =>
        console.warn("[RemoteNotifications] completion sync failed:", err),
      );
    }, this.nudgeDebounceMs);
    this.nudgeTimer.unref?.();
  }

  /**
   * Pull exactly the mappings named, grouped per server. Deliberately does NOT
   * go through `candidates()`: an explicit completion signal outranks the
   * watch window, which may well have lapsed during a long turn.
   */
  private async syncSessions(localSessionIds: string[]): Promise<void> {
    const byServer = new Map<string, RemoteSessionMapping[]>();
    for (const localSessionId of localSessionIds) {
      const mapping = await this.storage.remoteSessionMappings
        .getByLocal(localSessionId)
        .catch(() => undefined);
      if (!mapping) continue;   // local session, or the mapping is gone
      const group = byServer.get(mapping.remote_server_id);
      if (group) group.push(mapping);
      else byServer.set(mapping.remote_server_id, [mapping]);
    }
    if (byServer.size === 0) return;
    await this.dispatchByServer([...byServer]);
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
    // initializeIfAbsent, not set: a concurrent sweep may have been holding an
    // older (or newer) head for this same session. First writer wins — see the
    // storage contract. Either way a baseline now exists, so the turn is safe to
    // start: the milestone it produces will be strictly after it.
    await this.storage.notificationSyncCursors.initializeIfAbsent(
      mapping.remote_server_id, mapping.remote_session_id, head,
    );
    return true;
  }

  /** Sweep every mapped remote server, up to MAX_CONCURRENT_SERVERS at a time. */
  async syncAll(opts: { includeExpired: boolean }): Promise<void> {
    const mappings = await this.candidates(opts);
    await this.dispatchByServer([...groupByServer(mappings)]);
  }

  /** Sweep one server — used when a reverse connection comes online. */
  async syncServer(remoteServerId: string, opts: { includeExpired: boolean }): Promise<void> {
    const mappings = (await this.candidates(opts)).filter((m) => m.remote_server_id === remoteServerId);
    if (mappings.length > 0) await this.dispatchByServer([[remoteServerId, mappings]]);
  }

  /**
   * Run one group per server, bounded. Each group still queues on its own
   * server chain, so this composes with a nudge that arrives mid-sweep: same
   * server → it waits its turn; different server → it runs immediately.
   */
  private async dispatchByServer(groups: Array<[string, RemoteSessionMapping[]]>): Promise<void> {
    let next = 0;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_SERVERS, groups.length) },
      async () => {
        for (let i = next++; i < groups.length; i = next++) {
          const [serverId, group] = groups[i];
          await this.runOnServer(serverId, () => this.syncMappings(serverId, group));
        }
      },
    );
    await Promise.all(workers);
  }

  /**
   * Mappings this sweep should poll: the persisted watch set, plus any session
   * currently believed to be running.
   *
   * The union is what keeps a turn longer than WATCH_WINDOW_MS covered. Its
   * window is extended when the turn starts, but a long turn can go silent for
   * hours; without this the mapping would lapse out of the periodic set and its
   * eventual milestone would wait for a server restart or a remote reconnect.
   */
  private async candidates(opts: { includeExpired: boolean }): Promise<RemoteSessionMapping[]> {
    const mappings = await this.storage.remoteSessionMappings.getNotificationSyncCandidates({
      now: Date.now(),
      includeExpired: opts.includeExpired,
    });
    // A full sweep already covers everything.
    if (opts.includeExpired || this.activeRemoteSessions.size === 0) return mappings;

    const present = new Set(mappings.map((m) => m.local_session_id));
    for (const localSessionId of this.activeRemoteSessions) {
      if (present.has(localSessionId)) continue;
      const mapping = await this.storage.remoteSessionMappings.getByLocal(localSessionId);
      if (mapping) mappings.push(mapping);
    }
    return mappings;
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
          // One-time initialization only. This head was read before the await
          // above resolved; if a `prepareForNewTurn` established a baseline in
          // the meantime, this value may already sit past a milestone that turn
          // produced, and applying it would lose that notification permanently.
          await this.storage.notificationSyncCursors.initializeIfAbsent(
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

    // The front has no agent_sessions row for a remote session, so the worker's
    // query-time title is the only source for a session-named body.
    const sessionTitle = typeof session.sessionTitle === "string"
      ? session.sessionTitle.slice(0, MAX_SESSION_TITLE_LENGTH)
      : null;

    for (const event of session.events) {
      const notification: Notification = await this.notificationService.buildNotification(event, {
        id: localNotificationId(remoteServerId, event.id),
        userId: ownerId || "local",
        projectId: mapping.project_id,
        sessionId: mapping.local_session_id,
        workflowRunId: event.workflow_run_id
          ? localWorkflowRunId(remoteServerId, mapping.project_id, event.workflow_run_id)
          : null,
      }, { sessionTitle });

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

/**
 * Bus events meaning "a turn on this remote session just ended".
 *
 * `taskCompleted` is the success half. Failure is the subtle one: a failed
 * turn writes a `session_failed` milestone but emits no taskCompleted, and the
 * remote `finished` frame is not bridged onto the front bus at all (see
 * remote-agent-sessions.ts) — its terminal status patch is the only signal
 * that crosses. `session:finished` is matched too, for paths that do emit it.
 */
function isTurnTerminalEvent(event: GlobalEvent): boolean {
  if (event.type === "session:taskCompleted" || event.type === "session:finished") return true;
  return event.type === "session:status" && (event.status === "stopped" || event.status === "error");
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
