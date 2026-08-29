import type { EventBus } from "./event-bus.js";
import type {
  Notification,
  NotificationKind,
  NotificationOutboxEvent,
  Storage,
} from "./storage/types.js";

/**
 * Durable notification inbox of the user-facing server.
 *
 * Execution servers only ever write immutable milestone rows to their outbox.
 * This service is the *importer*: it turns those semantic events into
 * user-scoped inbox rows, deriving both the owning user and the presentation
 * copy locally. See
 * docs/plans/2026-07-25-persistent-notification-milestones-design.md.
 *
 * SSE is a latency optimization layered on top — never the reliability
 * mechanism. Correctness comes from the drain being restartable: the cursor is
 * durable, insertion is idempotent on the deterministic milestone id, and both
 * startup and a periodic tick re-run the drain.
 */

/** Stable, semantic titles. Never derived from worker-supplied text. */
const TITLE_BY_KIND: Record<NotificationKind, string> = {
  review_ready: "Review feedback is ready",
  session_result_ready: "Session result is ready",
  session_failed: "Session failed",
  workflow_failed: "Workflow needs attention",
  // "Stop, then send" — NOT "restart": restartSession wipes the conversation
  // history, while stop → dormant → next message respawns with a fresh token
  // and keeps everything.
  cross_remote_token_expired: "Cross-remote access expired — stop the session, then send a message to renew",
};

/**
 * Titles that carry no information — showing one as the notification body would
 * be worse than falling through to the branch or project name.
 */
const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set(["New Session", "Generating title…", "Generating title..."]);

/** Settings key holding the local drain cursor (reserved identity, not a user key). */
const LOCAL_CURSOR_KEY = "notification_local_cursor";

const OUTBOX_PAGE_SIZE = 100;

/** Read history retained per user. Unread rows are NEVER pruned. */
export const READ_HISTORY_PER_USER = 500;

/** Worker outbox retention, past every supported recovery window. */
export const OUTBOX_RETENTION_DAYS = 90;

const DRAIN_INTERVAL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Notification body: the most specific label the FRONT knows, resolved at import
 * time rather than baked into the outbox protocol — so a stale worker-side title
 * can never be frozen into a notification.
 */
export function notificationBody(opts: {
  sessionTitle: string | null | undefined;
  branch: string | null;
  projectName: string | null | undefined;
}): string | null {
  const title = opts.sessionTitle?.trim();
  if (title && !PLACEHOLDER_TITLES.has(title)) return title;
  if (opts.branch) return opts.branch;
  return opts.projectName?.trim() || null;
}

export function notificationTitle(kind: NotificationKind): string {
  return TITLE_BY_KIND[kind] ?? "Update";
}

export class NotificationService {
  private drainTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** Serializes drains so a nudge can't interleave with the periodic tick. */
  private drainChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private storage: Storage,
    private eventBus: EventBus,
  ) {}

  /**
   * Start the background timers. Unref'd: a pending drain must never be the
   * reason a CLI process refuses to exit.
   */
  start(): void {
    if (this.drainTimer || this.stopped) return;
    this.drainTimer = setInterval(() => this.requestDrain(), DRAIN_INTERVAL_MS);
    this.drainTimer.unref?.();
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch((err) => console.warn("[Notifications] cleanup failed:", err));
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  shutdown(): void {
    this.stopped = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.drainTimer = null;
    this.cleanupTimer = null;
  }

  /**
   * Fire-and-forget nudge used right after a milestone lands, so the bell is
   * fast in the common case. Queued behind any in-flight drain.
   */
  requestDrain(): void {
    if (this.stopped) return;
    this.drainChain = this.drainChain
      .then(() => this.drainLocal())
      .catch((err) => console.warn("[Notifications] local drain failed:", err));
  }

  /**
   * Import every local outbox event after the durable cursor.
   *
   * The cursor advances per page AFTER its rows are inserted, so a crash
   * mid-drain replays the page — harmless, because insertion is idempotent on
   * the milestone id and `notification:created` is only emitted for rows this
   * call actually inserted.
   */
  async drainLocal(): Promise<void> {
    for (;;) {
      const cursor = await this.readLocalCursor();
      const events = await this.storage.notificationOutbox.listAfter(cursor, OUTBOX_PAGE_SIZE);
      if (events.length === 0) return;

      for (const event of events) {
        await this.importLocalEvent(event);
      }

      await this.storage.settings.set(LOCAL_CURSOR_KEY, String(events[events.length - 1].seq));
      if (events.length < OUTBOX_PAGE_SIZE) return;
    }
  }

  private async importLocalEvent(event: NotificationOutboxEvent): Promise<void> {
    let projectId = event.project_id;
    let branch = event.branch;
    if (event.session_id) {
      const session = await this.storage.agentSessions.getById(event.session_id);
      if (session?.workspace_checkout_id) {
        const reader = this.storage.agentSessions.getActivityById;
        const projection = typeof reader === "function"
          ? await reader(event.session_id, "notification")
          : undefined;
        if (!projection) {
          console.warn(`[Notifications] dropping outbox event ${event.id}: session checkout binding is unavailable`);
          return;
        }
        projectId = projection.projectId;
        branch = projection.branch;
      }
    }
    // Ownership is DERIVED from the local project, never taken from the event.
    // An event for a project this server doesn't know has no addressable owner —
    // skip it rather than guessing a tenant, and let the cursor move past it so
    // one orphan can't wedge the drain forever.
    const ownerId = await this.storage.projects.getOwnerId(projectId);
    if (ownerId === undefined) {
      console.warn(`[Notifications] dropping outbox event ${event.id}: project ${projectId} not found`);
      return;
    }

    const notification = await this.buildNotification({ ...event, branch }, {
      id: event.id,
      // Legacy blank owners are normalized to "local" when storage opens;
      // keep the fallback for compatibility with injected/custom storage.
      userId: ownerId || "local",
      sessionId: event.session_id,
      projectId,
      workflowRunId: event.workflow_run_id,
    });

    if (await this.storage.notifications.insert(notification)) {
      this.eventBus.emit({ type: "notification:created", projectId: notification.project_id, notification });
    }
  }

  /**
   * Assemble the persisted row. `ids` is separate from the event because remote
   * imports substitute front-local identities (see RemoteNotificationSync) while
   * reusing this exact copy generation.
   *
   * `opts.sessionTitle` covers the remote-import case: the front has a mapping
   * but no local session row, so the worker's query-time title is the only way
   * to label the notification with the session's name.
   */
  async buildNotification(
    event: Pick<NotificationOutboxEvent, "kind" | "branch" | "created_at">,
    ids: {
      id: string;
      userId: string;
      projectId: string;
      sessionId: string | null;
      workflowRunId: string | null;
    },
    opts?: { sessionTitle?: string | null },
  ): Promise<Notification> {
    const session = ids.sessionId ? await this.storage.agentSessions.getById(ids.sessionId) : undefined;
    const project = await this.storage.projects.getById(ids.projectId);
    return {
      id: ids.id,
      user_id: ids.userId,
      kind: event.kind,
      project_id: ids.projectId,
      branch: event.branch,
      session_id: ids.sessionId,
      workflow_run_id: ids.workflowRunId,
      title: notificationTitle(event.kind),
      body: notificationBody({
        sessionTitle: session?.title ?? opts?.sessionTitle,
        branch: event.branch,
        projectName: project?.name,
      }),
      created_at: event.created_at,
      read_at: null,
    };
  }

  /** Emit for a row a remote import just inserted. */
  emitCreated(notification: Notification): void {
    this.eventBus.emit({ type: "notification:created", projectId: notification.project_id, notification });
  }

  /** Retention: cap read history per user, prune aged worker outbox rows. */
  async cleanup(): Promise<void> {
    await this.storage.notifications.cleanup(READ_HISTORY_PER_USER);
    await this.storage.notificationOutbox.pruneOlderThan(Date.now() - OUTBOX_RETENTION_DAYS * 86_400_000);
  }

  private async readLocalCursor(): Promise<number> {
    const raw = await this.storage.settings.get(LOCAL_CURSOR_KEY);
    const parsed = raw === undefined ? 0 : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  /** Simulates a crash between inbox insertion and cursor commit. */
  async resetLocalCursorForTest(): Promise<void> {
    await this.storage.settings.set(LOCAL_CURSOR_KEY, "0");
  }
}
