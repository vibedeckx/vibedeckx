import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { NotificationOutboxEvent, Storage } from "./storage/types.js";
import { EventBus, type GlobalEvent } from "./event-bus.js";
import { NotificationService } from "./notification-service.js";
import { RemoteNotificationSync } from "./remote-notification-sync.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import { validateOutboxQuery } from "./routes/notification-outbox-routes.js";
import type { ProxyResult } from "./utils/remote-proxy.js";
import type { AgentMessage } from "./agent-types.js";

/**
 * End-to-end durability, with REAL SQLite on both sides.
 *
 * Only the transport is mocked (at `proxyToRemoteAuto`) — and even that runs the
 * worker route's real request validator against the real worker storage, so the
 * cursor protocol is exercised rather than simulated. Everything else (storage,
 * NotificationService, RemoteNotificationSync, crash repair) is the production
 * code path.
 *
 * See docs/plans/2026-07-25-persistent-notification-milestones-design.md §Testing.
 */

const FRONT_PROJECT = "p-front";
const OWNER = "u1";

interface Harness {
  dir: string;
  worker: Storage;
  front: Storage;
  bus: EventBus;
  events: GlobalEvent[];
  notifications: NotificationService;
  sync: RemoteNotificationSync;
  serverId: string;
}

describe("notification recovery (front + worker, real storage)", () => {
  let h: Harness;

  /**
   * Stands in for the network by running the WORKER route's real validation and
   * real storage queries — the same code `/api/notification-outbox/query`
   * executes. Anything the front sends that the route would reject is rejected
   * here too.
   */
  async function serveOutboxQuery(worker: Storage, body: unknown): Promise<ProxyResult> {
    const validated = validateOutboxQuery((body ?? {}) as Record<string, unknown>);
    if (!validated.ok) return { ok: false, status: 400, data: { error: validated.error } };

    const sessions = [];
    for (const request of validated.sessions) {
      const headCursor = await worker.notificationOutbox.headBySession(request.sessionId);
      if (request.headOnly) {
        sessions.push({ sessionId: request.sessionId, events: [], headCursor, nextCursor: headCursor, hasMore: false });
        continue;
      }
      const events = await worker.notificationOutbox.listBySessionAfter(
        request.sessionId, request.after, validated.limit,
      );
      const nextCursor = events.length > 0 ? events[events.length - 1].seq : request.after;
      sessions.push({ sessionId: request.sessionId, events, headCursor, nextCursor, hasMore: nextCursor < headCursor });
    }
    return { ok: true, status: 200, data: { sessions } };
  }

  /** Build (or rebuild) the front side against the same on-disk database. */
  async function openFront(dir: string, worker: Storage, offline = { value: false }) {
    const front = await createSqliteStorage(path.join(dir, "front.sqlite"));
    const bus = new EventBus();
    const events: GlobalEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const notifications = new NotificationService(front, bus);
    const sync = new RemoteNotificationSync({
      storage: front,
      notificationService: notifications,
      proxy: (async (_serverId, _method, _path, body) => {
        if (offline.value) return { ok: false, status: 0, data: null, errorCode: "network_error" };
        return serveOutboxQuery(worker, body);
      }) as never,
    });
    return { front, bus, events, notifications, sync };
  }

  const offline = { value: false };

  beforeEach(async () => {
    offline.value = false;
    const dir = mkdtempSync(path.join(tmpdir(), "vdx-notif-recovery-"));
    const worker = await createSqliteStorage(path.join(dir, "worker.sqlite"));
    // Worker-side project + sessions, with worker-local ids the front must map.
    await worker.projects.create({ id: "p-worker", name: "worker proj", path: "/srv/app" });

    const { front, bus, events, notifications, sync } = await openFront(dir, worker, offline);
    await front.projects.create({ id: FRONT_PROJECT, name: "Checkout", path: null }, OWNER);
    const server = await front.remoteServers.create({ name: "w1" }, OWNER);
    await front.projectRemotes.add({
      project_id: FRONT_PROJECT, remote_server_id: server.id, remote_path: "/srv/app",
    });

    h = { dir, worker, front, bus, events, notifications, sync, serverId: server.id };
  });

  afterEach(async () => {
    h.sync.shutdown();
    h.notifications.shutdown();
    await h.front.close();
    await h.worker.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  const workerEvent = (
    overrides: Partial<Omit<NotificationOutboxEvent, "seq">> = {},
  ): Omit<NotificationOutboxEvent, "seq"> => ({
    id: "session:r1:turn:2:result-ready",
    kind: "session_result_ready",
    project_id: "p-worker",
    branch: "dev",
    session_id: "r1",
    workflow_run_id: null,
    created_at: 1000,
    ...overrides,
  });

  const inbox = () => h.front.notifications.listForUser(OWNER, { limit: 100 });
  const created = () => h.events.filter((e) => e.type === "notification:created");

  async function mapSession(
    remoteSessionId: string,
    policy: "from_start" | "from_now",
    localId = `remote-${h.serverId}-${FRONT_PROJECT}-${remoteSessionId}`,
  ) {
    await h.front.remoteSessionMappings.upsert(
      localId, FRONT_PROJECT, h.serverId, remoteSessionId, "dev", policy,
    );
    return localId;
  }

  it("recovers a milestone produced while front sync was stopped, and survives a reopen", async () => {
    const localId = await mapSession("r1", "from_start");

    // 1. The front is not syncing; the worker completes a turn.
    offline.value = true;
    await h.worker.notificationOutbox.insert(workerEvent());
    await h.sync.syncAll({ includeExpired: true });
    expect(await inbox()).toEqual([]);

    // 2. Sync starts (front back online) and imports it.
    offline.value = false;
    await h.sync.syncAll({ includeExpired: true });
    const imported = await inbox();
    expect(imported).toHaveLength(1);
    expect(imported[0].id).toBe(`remote:${h.serverId}:session:r1:turn:2:result-ready`);
    expect(imported[0].session_id).toBe(localId);
    expect(imported[0].project_id).toBe(FRONT_PROJECT); // NOT the worker's project id
    expect(imported[0].read_at).toBeNull();
    expect(created()).toHaveLength(1);

    // 3. Front storage closes and reopens; the notification is still unread.
    h.sync.shutdown();
    h.notifications.shutdown();
    await h.front.close();
    const reopened = await openFront(h.dir, h.worker, offline);
    h = { ...h, ...reopened };

    const afterReopen = await inbox();
    expect(afterReopen).toHaveLength(1);
    expect(afterReopen[0].read_at).toBeNull();

    // 4. Importing the same page again does not duplicate it or re-ding.
    h.events.length = 0;
    await h.sync.syncAll({ includeExpired: true });
    expect(await inbox()).toHaveLength(1);
    expect(created()).toHaveLength(0);
  });

  it("a read persists across another reopen", async () => {
    await mapSession("r1", "from_start");
    await h.worker.notificationOutbox.insert(workerEvent());
    await h.sync.syncAll({ includeExpired: true });

    const [row] = await inbox();
    expect(await h.front.notifications.markRead(row.id, OWNER)).toBe(true);

    h.sync.shutdown();
    await h.front.close();
    const reopened = await openFront(h.dir, h.worker, offline);
    h = { ...h, ...reopened };

    const afterReopen = await inbox();
    expect(afterReopen[0].read_at).not.toBeNull();
    expect(await h.front.notifications.listForUser(OWNER, { limit: 10, unreadOnly: true })).toEqual([]);
  });

  it("two sessions on the same branch keep separate notification ids", async () => {
    const localA = await mapSession("rA", "from_start");
    const localB = await mapSession("rB", "from_start");

    await h.worker.notificationOutbox.insert(
      workerEvent({ id: "session:rA:turn:2:result-ready", session_id: "rA" }),
    );
    await h.worker.notificationOutbox.insert(
      workerEvent({ id: "session:rB:turn:2:result-ready", session_id: "rB" }),
    );
    await h.sync.syncAll({ includeExpired: true });

    const rows = await inbox();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.session_id).sort()).toEqual([localA, localB].sort());
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    // Both unread: the branch-level dedupe that used to swallow the second one
    // has no say here.
    expect(rows.every((r) => r.read_at === null)).toBe(true);
  });

  it("review-ready and the later source result both exist as distinct milestones", async () => {
    const reviewerLocal = await mapSession("r-rev", "from_start");
    const sourceLocal = await mapSession("r-src", "from_start");

    // Worker: the review becomes ready, then the source finishes its fix turn.
    await h.worker.notificationOutbox.insert({
      id: "workflow:run-1:review-ready",
      kind: "review_ready",
      project_id: "p-worker",
      branch: "dev",
      session_id: "r-rev",
      workflow_run_id: "run-1",
      created_at: 1000,
    });
    await h.worker.notificationOutbox.insert({
      id: "session:r-src:turn:9:result-ready",
      kind: "session_result_ready",
      project_id: "p-worker",
      branch: "dev",
      session_id: "r-src",
      workflow_run_id: null,
      created_at: 2000,
    });
    await h.sync.syncAll({ includeExpired: true });

    const rows = await inbox();
    expect(rows.map((r) => r.kind).sort()).toEqual(["review_ready", "session_result_ready"]);

    const review = rows.find((r) => r.kind === "review_ready")!;
    expect(review.session_id).toBe(reviewerLocal);
    expect(review.title).toBe("Review feedback is ready");
    // Remote workflow run id mapped into the front's local id space.
    expect(review.workflow_run_id).toBe(`remote-${h.serverId}-${FRONT_PROJECT}-run-1`);

    const result = rows.find((r) => r.kind === "session_result_ready")!;
    expect(result.session_id).toBe(sourceLocal);
    expect(result.title).toBe("Session result is ready");
  });

  it("a repaired server_restart result turn becomes exactly one durable session_failed", async () => {
    // Worker side, real crash-repair path: a session left "running" mid-turn.
    await h.worker.agentSessions.create({ id: "r-crashed", project_id: "p-worker", branch: "dev" });
    await h.worker.agentSessions.upsertEntry("r-crashed", 0, JSON.stringify({
      type: "user", content: "do the thing", timestamp: 1, notificationDisposition: "result",
    } satisfies AgentMessage));
    await h.worker.agentSessions.upsertEntry("r-crashed", 1, JSON.stringify({
      type: "tool_use", tool: "Bash", input: {}, timestamp: 2,
    } satisfies AgentMessage));

    const manager = new AgentSessionManager(h.worker);
    await manager.restoreSessionsFromDb();
    // Idempotent across a second boot.
    await new AgentSessionManager(h.worker).restoreSessionsFromDb();

    const workerRows = await h.worker.notificationOutbox.listAfter(0, 100);
    expect(workerRows).toHaveLength(1);
    expect(workerRows[0]).toMatchObject({ kind: "session_failed", session_id: "r-crashed" });

    const localId = await mapSession("r-crashed", "from_start");
    await h.sync.syncAll({ includeExpired: true });

    const rows = await inbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("session_failed");
    expect(rows[0].title).toBe("Session failed");
    expect(rows[0].session_id).toBe(localId);
  });

  it("a search-discovered mapping starts at head while a front-created one recovers from zero", async () => {
    // The worker already has history for both sessions.
    for (let i = 0; i < 3; i++) {
      await h.worker.notificationOutbox.insert(
        workerEvent({ id: `session:r-old:turn:${i}:result-ready`, session_id: "r-old", created_at: 100 + i }),
      );
    }
    await h.worker.notificationOutbox.insert(
      workerEvent({ id: "session:r-new:turn:0:result-ready", session_id: "r-new", created_at: 500 }),
    );

    const oldLocal = await mapSession("r-old", "from_now");   // discovered by search
    await mapSession("r-new", "from_start");                  // created by this front

    await h.sync.syncAll({ includeExpired: true });

    // Only the front-created session's milestone is imported. No sound storm.
    const rows = await inbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`remote:${h.serverId}:session:r-new:turn:0:result-ready`);
    expect(created()).toHaveLength(1);

    // The discovered session recorded a baseline at the worker's current head...
    const baseline = await h.front.notificationSyncCursors.get(h.serverId, "r-old");
    expect(baseline).toBe(await h.worker.notificationOutbox.headBySession("r-old"));

    // ...and its NEXT milestone does arrive.
    await h.worker.notificationOutbox.insert(
      workerEvent({ id: "session:r-old:turn:9:result-ready", session_id: "r-old", created_at: 900 }),
    );
    await h.sync.syncAll({ includeExpired: true });
    const after = await inbox();
    expect(after).toHaveLength(2);
    expect(after.some((r) => r.session_id === oldLocal)).toBe(true);
  });

  it("a fresh front database attached to a long-lived worker imports nothing", async () => {
    for (let i = 0; i < 25; i++) {
      await h.worker.notificationOutbox.insert(
        workerEvent({ id: `session:r-hist:turn:${i}:result-ready`, session_id: "r-hist", created_at: i }),
      );
    }
    // Everything a fresh front learns about comes from discovery → from_now.
    await mapSession("r-hist", "from_now");

    await h.sync.syncAll({ includeExpired: true });

    expect(await inbox()).toEqual([]);
    expect(created()).toEqual([]);
  });

  it("a local milestone survives a crash between its commit and the import", async () => {
    // Front-local work: the milestone is committed to the front's own outbox,
    // then the process dies before the drain runs.
    await h.front.agentSessions.create({ id: "s-local", project_id: FRONT_PROJECT, branch: "dev" });
    await h.front.agentSessions.updateTitle("s-local", "Fix the header");
    await h.front.notificationOutbox.insert({
      id: "session:s-local:turn:4:result-ready",
      kind: "session_result_ready",
      project_id: FRONT_PROJECT,
      branch: "dev",
      session_id: "s-local",
      workflow_run_id: null,
      created_at: 4000,
    });

    // Reopen (fresh service, same database) — the startup drain recovers it.
    h.notifications.shutdown();
    await h.front.close();
    const reopened = await openFront(h.dir, h.worker, offline);
    h = { ...h, ...reopened };
    await h.notifications.drainLocal();

    const rows = await inbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Session result is ready");
    expect(rows[0].body).toBe("Fix the header"); // front-known title, not worker text
    expect(created()).toHaveLength(1);
  });

  it("a transport failure mid-sweep leaves cursors untouched and retries cleanly", async () => {
    await mapSession("r1", "from_start");
    await h.worker.notificationOutbox.insert(workerEvent());

    offline.value = true;
    await h.sync.syncAll({ includeExpired: true });
    expect(await h.front.notificationSyncCursors.get(h.serverId, "r1")).toBeUndefined();

    offline.value = false;
    await h.sync.syncAll({ includeExpired: true });
    expect(await inbox()).toHaveLength(1);
    expect(await h.front.notificationSyncCursors.get(h.serverId, "r1")).toBeGreaterThan(0);
  });

  it("prepareForNewTurn baselines a discovered session so its next turn is not suppressed", async () => {
    // Long history the front must not import...
    for (let i = 0; i < 5; i++) {
      await h.worker.notificationOutbox.insert(
        workerEvent({ id: `session:r-open:turn:${i}:result-ready`, session_id: "r-open", created_at: i }),
      );
    }
    const localId = await mapSession("r-open", "from_now");

    expect(await h.sync.prepareForNewTurn(localId)).toBe(true);
    const baseline = await h.front.notificationSyncCursors.get(h.serverId, "r-open");
    expect(baseline).toBe(await h.worker.notificationOutbox.headBySession("r-open"));

    // ...then the turn the user just started completes and IS delivered.
    await h.worker.notificationOutbox.insert(
      workerEvent({ id: "session:r-open:turn:6:result-ready", session_id: "r-open", created_at: 600 }),
    );
    await h.sync.syncAll({ includeExpired: true });

    const rows = await inbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`remote:${h.serverId}:session:r-open:turn:6:result-ready`);
  });

  it("refuses to start a turn when the baseline cannot be recorded", async () => {
    const localId = await mapSession("r-open", "from_now");
    offline.value = true;
    expect(await h.sync.prepareForNewTurn(localId)).toBe(false);
    expect(await h.front.notificationSyncCursors.get(h.serverId, "r-open")).toBeUndefined();
  });

  it("retention keeps unread rows and caps read history, without touching the unread", async () => {
    await mapSession("r1", "from_start");
    await h.worker.notificationOutbox.insert(workerEvent());
    await h.sync.syncAll({ includeExpired: true });

    // Pad read history past the cap.
    for (let i = 0; i < 600; i++) {
      await h.front.notifications.insert({
        id: `read-${i}`, user_id: OWNER, kind: "session_result_ready", project_id: FRONT_PROJECT,
        branch: "dev", session_id: null, workflow_run_id: null,
        title: "t", body: null, created_at: 10_000 + i, read_at: 1,
      });
    }
    await h.notifications.cleanup();

    const remaining = await h.front.notifications.listForUser(OWNER, { limit: 2000 });
    expect(remaining).toHaveLength(501); // 500 read + the 1 unread
    const unread = await h.front.notifications.listForUser(OWNER, { limit: 10, unreadOnly: true });
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe(`remote:${h.serverId}:session:r1:turn:2:result-ready`);
  });

  it("a worker event for an unknown front project is skipped, not attributed to a guessed tenant", async () => {
    // Mapping points at a project this front does not have.
    await h.front.remoteSessionMappings.upsert(
      "remote-ghost", "p-nonexistent", h.serverId, "r1", "dev", "from_start",
    );
    await h.worker.notificationOutbox.insert(workerEvent());

    await h.sync.syncAll({ includeExpired: true });

    expect(await inbox()).toEqual([]);
    expect(await h.front.notifications.listForUser("local", { limit: 10 })).toEqual([]);
  });

  it("mock transport sanity: the worker route rejects a malformed front request", async () => {
    // Guards the harness itself — if this passed, the tests above would be
    // validating nothing about the real protocol.
    const bad = await serveOutboxQuery(h.worker, { sessions: [{ sessionId: "", after: -1 }] });
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(400);
  });
});

// Keep vitest from treating the unused import as dead weight in coverage runs.
void vi;
