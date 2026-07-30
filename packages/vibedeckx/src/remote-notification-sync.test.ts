import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { NotificationOutboxEvent, Storage } from "./storage/types.js";
import { EventBus, type GlobalEvent } from "./event-bus.js";
import { NotificationService } from "./notification-service.js";
import { MAX_SESSIONS_PER_REQUEST } from "./routes/notification-outbox-routes.js";
import { RemoteNotificationSync, WATCH_WINDOW_MS } from "./remote-notification-sync.js";
import type { ProxyResult } from "./utils/remote-proxy.js";

interface SessionRequest { sessionId: string; after: number; headOnly?: boolean }
interface QueryBody { sessions: SessionRequest[]; limitPerSession?: number }

/** One worker-side event, as the outbox route would return it. */
const workerEvent = (
  seq: number,
  overrides: Partial<NotificationOutboxEvent> = {},
): NotificationOutboxEvent => ({
  seq,
  id: `session:r1:turn:${seq}:result-ready`,
  kind: "session_result_ready",
  project_id: "worker-project-id",  // worker-local — must never be trusted
  branch: "dev",
  session_id: "r1",
  workflow_run_id: null,
  created_at: 1000 + seq,
  ...overrides,
});

describe("RemoteNotificationSync", () => {
  let dir: string;
  let storage: Storage;
  let bus: EventBus;
  let seen: GlobalEvent[];
  let notifications: NotificationService;
  let sync: RemoteNotificationSync;
  /** Recorded (serverId, method, path, body) tuples. */
  let calls: Array<{ serverId: string; method: string; path: string; body: QueryBody; opts: unknown }>;
  let respond: (body: QueryBody) => ProxyResult;

  const ok = (sessions: unknown[]): ProxyResult => ({ ok: true, status: 200, data: { sessions } });

  /**
   * Default transport: record the call, answer via the per-test `respond`.
   * Re-installed in beforeEach — a test that swaps in its own
   * `mockImplementation` (the concurrency tests do) would otherwise leak it
   * into every later test, since `mockClear` clears calls but NOT the
   * implementation.
   */
  const defaultProxyImpl = async (
    serverId: string, method: string, apiPath: string,
    body?: unknown, opts?: unknown,
  ): Promise<ProxyResult> => {
    calls.push({ serverId, method, path: apiPath, body: body as QueryBody, opts });
    return respond(body as QueryBody);
  };

  const proxy = vi.fn(defaultProxyImpl);

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-remote-sync-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "Checkout", path: null }, "u1");
    bus = new EventBus();
    seen = [];
    bus.subscribe((e) => seen.push(e));
    notifications = new NotificationService(storage, bus);
    calls = [];
    proxy.mockReset();
    proxy.mockImplementation(defaultProxyImpl);
    respond = () => ok([]);
    sync = new RemoteNotificationSync({
      storage,
      notificationService: notifications,
      reverseConnectManager: { marker: "rcm" } as never,
      proxy: proxy as never,
      // Real debounce is a few hundred ms; tests only need the coalescing
      // behavior, not the wall time.
      nudgeDebounceMs: 1,
    });
  });

  afterEach(async () => {
    sync.shutdown();
    notifications.shutdown();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Register a project_remotes row so server resolution succeeds. */
  async function linkRemote(name = "srv1") {
    const server = await storage.remoteServers.create({ name }, "u1");
    await storage.projectRemotes.add({
      project_id: "p1", remote_server_id: server.id, remote_path: "/srv/app",
    });
    return server.id;
  }

  const created = () => seen.filter((e) => e.type === "notification:created");
  const inbox = () => storage.notifications.listForUser("u1", { limit: 100 });

  describe("cursor requests", () => {
    it("groups mappings by remote server and sends each session's own persisted cursor", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("local-1", "p1", srv, "r1", "dev", "from_start");
      await storage.remoteSessionMappings.upsert("local-2", "p1", srv, "r2", "dev", "from_start");
      await storage.notificationSyncCursors.set(srv, "r2", 17);

      await sync.syncAll({ includeExpired: true });

      expect(calls).toHaveLength(1);
      expect(calls[0].serverId).toBe(srv);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].path).toBe("/api/notification-outbox/query");
      const requested = new Map(calls[0].body.sessions.map((s) => [s.sessionId, s]));
      expect(requested.get("r1")).toMatchObject({ after: 0 });
      expect(requested.get("r2")).toMatchObject({ after: 17 });
    });

    it("passes reverseConnectManager through so reverse-connect workers use the same path", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("local-1", "p1", srv, "r1", "dev", "from_start");
      await sync.syncAll({ includeExpired: true });
      expect(calls[0].opts).toMatchObject({ reverseConnectManager: { marker: "rcm" } });
    });

    it("chunks a large mapping set into bounded requests", async () => {
      const srv = await linkRemote();
      const total = MAX_SESSIONS_PER_REQUEST + 7;
      for (let i = 0; i < total; i++) {
        await storage.remoteSessionMappings.upsert(`local-${i}`, "p1", srv, `r${i}`, "dev", "from_start");
      }
      await sync.syncAll({ includeExpired: true });

      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.body.sessions.length).toBeLessThanOrEqual(MAX_SESSIONS_PER_REQUEST);
      }
      expect(calls.flatMap((c) => c.body.sessions).length).toBe(total);
    });

  });

  describe("import and ID mapping", () => {
    beforeEach(async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");
      await storage.agentSessions.create({ id: "s-local-title", project_id: "p1", branch: "dev" });
    });

    async function serverId() {
      return (await storage.remoteSessionMappings.getByRemote(
        (await storage.remoteServers.getAll("u1"))[0].id, "r1",
      ))?.remote_server_id ?? "";
    }

    it("maps remote session and workflow ids into front-local ids and namespaces the notification id", async () => {
      const srv = await serverId();
      respond = () => ok([{
        sessionId: "r1",
        events: [workerEvent(3, { workflow_run_id: "wf-9" })],
        headCursor: 3, nextCursor: 3, hasMore: false,
      }]);

      await sync.syncAll({ includeExpired: true });

      const rows = await inbox();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(`remote:${srv}:session:r1:turn:3:result-ready`);
      // Local identities everywhere — the worker's own project id is discarded.
      expect(rows[0].project_id).toBe("p1");
      expect(rows[0].session_id).toBe("remote-srv-p1-r1");
      expect(rows[0].workflow_run_id).toBe(`remote-${srv}-p1-wf-9`);
      expect(rows[0].user_id).toBe("u1");
      // Copy is generated locally from the stable kind.
      expect(rows[0].title).toBe("Session result is ready");
    });

    it("labels the notification body with the worker's query-time session title", async () => {
      respond = () => ok([{
        sessionId: "r1",
        events: [workerEvent(1)],
        headCursor: 1, nextCursor: 1, hasMore: false,
        sessionTitle: "Fix checkout flow",
      }]);

      await sync.syncAll({ includeExpired: true });

      const rows = await inbox();
      // The front has no agent_sessions row for "remote-srv-p1-r1", so without
      // the worker-supplied title the body would fall back to the branch.
      expect(rows[0].body).toBe("Fix checkout flow");
    });

    it("falls back to the branch when a pre-title worker omits sessionTitle", async () => {
      respond = () => ok([{ sessionId: "r1", events: [workerEvent(1)], headCursor: 1, nextCursor: 1, hasMore: false }]);
      await sync.syncAll({ includeExpired: true });
      expect((await inbox())[0].body).toBe("dev");
    });

    it("treats a placeholder title as absent and caps an oversized one", async () => {
      respond = () => ok([
        {
          sessionId: "r1",
          events: [workerEvent(1)],
          headCursor: 1, nextCursor: 1, hasMore: false,
          // Placeholder titles carry no information — branch is the better label.
          sessionTitle: "New Session",
        },
      ]);
      await sync.syncAll({ includeExpired: true });
      expect((await inbox())[0].body).toBe("dev");

      respond = () => ok([{
        sessionId: "r1",
        events: [workerEvent(2)],
        headCursor: 2, nextCursor: 2, hasMore: false,
        sessionTitle: "x".repeat(10_000),
      }]);
      await sync.syncAll({ includeExpired: true });
      const long = (await inbox()).find((n) => n.id.endsWith("turn:2:result-ready"))!;
      expect(long.body).toBe("x".repeat(200));
    });

    it("derives userId from the local project owner, not from the worker", async () => {
      // A second tenant owns nothing here; the row must land on p1's owner.
      respond = () => ok([{ sessionId: "r1", events: [workerEvent(1)], headCursor: 1, nextCursor: 1, hasMore: false }]);
      await sync.syncAll({ includeExpired: true });
      expect(await storage.notifications.listForUser("u2", { limit: 10 })).toEqual([]);
      expect(await inbox()).toHaveLength(1);
    });

    it("insert and cursor advance are atomic, and replay after a crash does not duplicate", async () => {
      const srv = await serverId();
      respond = () => ok([{ sessionId: "r1", events: [workerEvent(5)], headCursor: 5, nextCursor: 5, hasMore: false }]);

      await sync.syncAll({ includeExpired: true });
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(5);
      expect(created()).toHaveLength(1);

      // The cursor is monotonic by construction — set() takes MAX(existing,
      // incoming), so it cannot be rewound even deliberately. That IS the
      // guarantee: a replayed page (the mock re-serves seq 5 regardless of
      // `after`) is absorbed by the notification id's unique constraint rather
      // than re-inserting and re-dinging.
      await storage.notificationSyncCursors.set(srv, "r1", 0);
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(5);
      seen.length = 0;
      await sync.syncAll({ includeExpired: true });
      expect(await inbox()).toHaveLength(1);
      expect(created()).toHaveLength(0);
    });

    it("emits notification:created only for newly inserted rows", async () => {
      respond = () => ok([{ sessionId: "r1", events: [workerEvent(2)], headCursor: 2, nextCursor: 2, hasMore: false }]);
      await sync.syncAll({ includeExpired: true });
      expect(created()).toHaveLength(1);
      const evt = created()[0] as Extract<GlobalEvent, { type: "notification:created" }>;
      expect(evt.projectId).toBe("p1");
      expect(evt.notification.session_id).toBe("remote-srv-p1-r1");
    });

    it("rejects the session batch and leaves its cursor unchanged when an event's session id mismatches", async () => {
      const srv = await serverId();
      respond = () => ok([{
        sessionId: "r1",
        // A worker that returns someone else's event under our session key.
        events: [workerEvent(1), workerEvent(2, { session_id: "r-other", id: "smuggled" })],
        headCursor: 2, nextCursor: 2, hasMore: false,
      }]);

      await sync.syncAll({ includeExpired: true });

      expect(await inbox()).toEqual([]);
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBeUndefined();
    });

    it("ignores a session the request never asked for", async () => {
      respond = () => ok([
        { sessionId: "r1", events: [], headCursor: 0, nextCursor: 0, hasMore: false },
        { sessionId: "r-unrequested", events: [workerEvent(1, { session_id: "r-unrequested", id: "sneaky" })], headCursor: 1, nextCursor: 1, hasMore: false },
      ]);
      await sync.syncAll({ includeExpired: true });
      expect(await inbox()).toEqual([]);
    });

    it("follows hasMore until the page is not full", async () => {
      let round = 0;
      respond = () => {
        round++;
        return round === 1
          ? ok([{ sessionId: "r1", events: [workerEvent(1), workerEvent(2)], headCursor: 4, nextCursor: 2, hasMore: true }])
          : ok([{ sessionId: "r1", events: [workerEvent(3), workerEvent(4)], headCursor: 4, nextCursor: 4, hasMore: false }]);
      };
      await sync.syncAll({ includeExpired: true });
      expect((await inbox()).map((n) => n.id.split(":turn:")[1])).toEqual(
        ["4:result-ready", "3:result-ready", "2:result-ready", "1:result-ready"],
      );
      expect(calls).toHaveLength(2);
      expect(calls[1].body.sessions[0].after).toBe(2);
    });

    it("a transport error leaves every affected cursor unchanged", async () => {
      const srv = await serverId();
      await storage.notificationSyncCursors.set(srv, "r1", 4);
      respond = () => ({ ok: false, status: 502, data: null, errorCode: "network_error" });

      await sync.syncAll({ includeExpired: true });

      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(4);
      expect(await inbox()).toEqual([]);
    });
  });

  describe("provenance initialization", () => {
    it("a from_now mapping with no cursor records the head without importing or dinging", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_now");
      respond = (body) => {
        expect(body.sessions[0]).toMatchObject({ sessionId: "r1", headOnly: true });
        return ok([{ sessionId: "r1", events: [], headCursor: 42, nextCursor: 42, hasMore: false }]);
      };

      await sync.syncAll({ includeExpired: true });

      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(42);
      expect(await inbox()).toEqual([]);
      expect(created()).toHaveLength(0);
    });

    it("an initialized from_now mapping then imports normally from its baseline", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_now");
      respond = () => ok([{ sessionId: "r1", events: [], headCursor: 42, nextCursor: 42, hasMore: false }]);
      await sync.syncAll({ includeExpired: true });

      respond = (body) => {
        expect(body.sessions[0]).toMatchObject({ sessionId: "r1", after: 42 });
        expect(body.sessions[0].headOnly).toBeUndefined();
        return ok([{ sessionId: "r1", events: [workerEvent(43)], headCursor: 43, nextCursor: 43, hasMore: false }]);
      };
      await sync.syncAll({ includeExpired: true });
      expect(await inbox()).toHaveLength(1);
    });

    it("a from_start mapping recovers a completion that raced its own mapping setup", async () => {
      const srv = await linkRemote();
      // The worker finished (and wrote seq 1) before this row landed.
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");
      respond = (body) => {
        expect(body.sessions[0]).toMatchObject({ sessionId: "r1", after: 0 });
        expect(body.sessions[0].headOnly).toBeUndefined();
        return ok([{ sessionId: "r1", events: [workerEvent(1)], headCursor: 1, nextCursor: 1, hasMore: false }]);
      };

      await sync.syncAll({ includeExpired: true });
      expect(await inbox()).toHaveLength(1);
    });

    it("re-upserting a reused reviewer preserves its cursor (no history replay)", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_now");
      await storage.notificationSyncCursors.set(srv, "r1", 30);

      // Second review reuses the reviewer; the registration path re-upserts.
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");

      respond = (body) => {
        expect(body.sessions[0]).toMatchObject({ sessionId: "r1", after: 30 });
        return ok([{ sessionId: "r1", events: [], headCursor: 30, nextCursor: 30, hasMore: false }]);
      };
      await sync.syncAll({ includeExpired: true });
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(30);
    });
  });

  describe("prepareForNewTurn", () => {
    it("records the head before dispatch for an uninitialized from_now mapping", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_now");
      respond = (body) => {
        expect(body.sessions[0]).toMatchObject({ sessionId: "r1", headOnly: true });
        return ok([{ sessionId: "r1", events: [], headCursor: 11, nextCursor: 11, hasMore: false }]);
      };

      expect(await sync.prepareForNewTurn("remote-srv-p1-r1")).toBe(true);
      // Baseline recorded, so the turn that follows is NOT mistaken for history.
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(11);
    });

    it("refuses the turn when baseline initialization fails", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_now");
      respond = () => ({ ok: false, status: 502, data: null, errorCode: "network_error" });

      expect(await sync.prepareForNewTurn("remote-srv-p1-r1")).toBe(false);
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBeUndefined();
    });

    it("is a no-op for a from_start mapping and for an unmapped (local) session", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");
      expect(await sync.prepareForNewTurn("remote-srv-p1-r1")).toBe(true);
      expect(await sync.prepareForNewTurn("plain-local-session")).toBe(true);
      expect(proxy).not.toHaveBeenCalled();
    });

    it("is a no-op once a from_now mapping has a baseline", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_now");
      await storage.notificationSyncCursors.set(srv, "r1", 8);
      expect(await sync.prepareForNewTurn("remote-srv-p1-r1")).toBe(true);
      expect(proxy).not.toHaveBeenCalled();
    });

    /**
     * The race: a sweep reads "cursor unset", issues its headOnly query, and the
     * response is computed by the worker only AFTER the user's new turn has
     * already started AND completed. That stale head therefore sits *past* the
     * new milestone. Because event-import cursor advancement is MAX-guarded, a
     * cursor pushed forward here can never be walked back — the notification
     * would be swallowed permanently.
     *
     * A baseline is a ONE-TIME INITIALIZATION, so whichever caller establishes it
     * first wins and every later baseline write is discarded.
     */
    it("a slow sweep baseline cannot clobber a baseline prepareForNewTurn already recorded", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_now");
      await sync.extendWatch("remote-srv-p1-r1");

      // Hold the sweep's headOnly response open.
      let releaseSweep!: () => void;
      const sweepGate = new Promise<void>((resolve) => { releaseSweep = resolve; });
      let sweepQueryStarted!: () => void;
      const sweepStarted = new Promise<void>((resolve) => { sweepQueryStarted = resolve; });

      let firstCall = true;
      respond = () => ok([]); // replaced below
      proxy.mockImplementation(async (
        serverId: string, method: string, apiPath: string,
        body?: unknown, opts?: unknown,
      ) => {
        calls.push({ serverId, method, path: apiPath, body: body as QueryBody, opts });
        if (firstCall) {
          firstCall = false;
          sweepQueryStarted();
          await sweepGate;
          // By the time the worker answers, the user's new turn has finished and
          // written seq 6 — so this head is already PAST the new milestone.
          return ok([{ sessionId: "r1", events: [], headCursor: 6, nextCursor: 6, hasMore: false }]);
        }
        // prepareForNewTurn's own baseline: the head before the new turn ran.
        return ok([{ sessionId: "r1", events: [], headCursor: 5, nextCursor: 5, hasMore: false }]);
      });

      const sweep = sync.syncAll({ includeExpired: false });
      await sweepStarted;

      // User starts a turn while the sweep is still in flight.
      expect(await sync.prepareForNewTurn("remote-srv-p1-r1")).toBe(true);
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(5);

      releaseSweep();
      await sweep;

      // The stale head is discarded — the cursor still sits before the new turn.
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(5);

      // ...so the new turn's milestone is still delivered.
      proxy.mockImplementation(async (
        serverId: string, method: string, apiPath: string,
        body?: unknown, opts?: unknown,
      ) => {
        calls.push({ serverId, method, path: apiPath, body: body as QueryBody, opts });
        return ok([{
          sessionId: "r1",
          events: [workerEvent(6, { id: "session:r1:turn:6:result-ready" })],
          headCursor: 6, nextCursor: 6, hasMore: false,
        }]);
      });
      await sync.syncAll({ includeExpired: false });
      expect((await inbox()).map((n) => n.id)).toEqual([
        `remote:${srv}:session:r1:turn:6:result-ready`,
      ]);
    });

    it("the reverse order is equally safe: a sweep baseline blocks a later stale one", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_now");

      respond = () => ok([{ sessionId: "r1", events: [], headCursor: 3, nextCursor: 3, hasMore: false }]);
      await sync.syncAll({ includeExpired: true });
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(3);

      // A late baseline attempt carrying a further-advanced head must not apply.
      respond = () => ok([{ sessionId: "r1", events: [], headCursor: 99, nextCursor: 99, hasMore: false }]);
      await sync.prepareForNewTurn("remote-srv-p1-r1");
      expect(await storage.notificationSyncCursors.get(srv, "r1")).toBe(3);
    });

    it("extends the watch window so the new turn's completion is polled for", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");
      const before = Date.now();
      await sync.prepareForNewTurn("remote-srv-p1-r1");
      const mapping = await storage.remoteSessionMappings.getByRemote(srv, "r1");
      expect(mapping!.notification_watch_until!).toBeGreaterThanOrEqual(before + WATCH_WINDOW_MS - 5_000);
    });
  });

  describe("polling scope", () => {
    it("periodic sync only queries mappings whose watch window is still open", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("watched", "p1", srv, "r-watched", "dev", "from_start");
      await sync.extendWatch("watched");
      await storage.remoteSessionMappings.upsert("cold", "p1", srv, "r-cold", "dev", "from_start");

      await sync.syncAll({ includeExpired: false });

      expect(calls).toHaveLength(1);
      expect(calls[0].body.sessions.map((s) => s.sessionId)).toEqual(["r-watched"]);
    });

    it("a full sweep queries historical mappings too, still chunked", async () => {
      const srv = await linkRemote();
      for (let i = 0; i < MAX_SESSIONS_PER_REQUEST + 3; i++) {
        await storage.remoteSessionMappings.upsert(`cold-${i}`, "p1", srv, `r${i}`, "dev", "from_start");
      }
      await sync.syncAll({ includeExpired: true });
      expect(calls).toHaveLength(2);
    });

    it("syncServer scopes a remote-came-online sweep to that server", async () => {
      const srvA = await linkRemote("a");
      const srvB = await linkRemote("b");
      await storage.remoteSessionMappings.upsert("la", "p1", srvA, "ra", "dev", "from_start");
      await storage.remoteSessionMappings.upsert("lb", "p1", srvB, "rb", "dev", "from_start");

      await sync.syncServer(srvA, { includeExpired: true });

      expect(calls).toHaveLength(1);
      expect(calls[0].serverId).toBe(srvA);
    });

    /**
     * The 30-minute watch window is an idle timeout, not a work deadline. An
     * agent turn routinely outlives it while the bus sees nothing between
     * "running" and "completed", so a mapping that lapsed mid-turn would stop
     * being polled exactly when its milestone is about to appear.
     */
    /**
     * Only `Date` is faked: promises and the storage layer keep working, but
     * both the persisted watch window and the candidate query see the advanced
     * clock — which is what lets a turn genuinely outlive its window with no
     * intervening bus traffic to re-extend it.
     */
    async function startLongRunningTurn() {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");
      sync.setEventBus(bus);

      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      // The remote stream bridges the turn's start onto the bus.
      bus.emit({
        type: "session:status", projectId: "p1", branch: "dev",
        sessionId: "remote-srv-p1-r1", status: "running",
      });
      await vi.waitFor(async () => {
        const m = await storage.remoteSessionMappings.getByRemote(srv, "r1");
        expect(m!.notification_watch_until).not.toBeNull();
      });

      // The turn runs for hours, silently: no frames, so nothing re-extends.
      vi.setSystemTime(t0 + WATCH_WINDOW_MS + 60 * 60 * 1000);

      // Precondition: the persisted window really has lapsed.
      const lapsed = await storage.remoteSessionMappings.getNotificationSyncCandidates({
        now: Date.now(), includeExpired: false,
      });
      expect(lapsed).toEqual([]);
      return srv;
    }

    it("keeps polling a session whose turn outlives the watch window", async () => {
      await startLongRunningTurn();
      try {
        await sync.syncAll({ includeExpired: false });
        // Reached ONLY through the liveness union — the persisted window is gone.
        expect(calls).toHaveLength(1);
        expect(calls[0].body.sessions.map((s) => s.sessionId)).toEqual(["r1"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("delivers the milestone of a long turn that finishes after the window lapsed", async () => {
      const srv = await startLongRunningTurn();
      try {
        respond = () => ok([{ sessionId: "r1", events: [workerEvent(1)], headCursor: 1, nextCursor: 1, hasMore: false }]);
        await sync.syncAll({ includeExpired: false });
        expect((await inbox()).map((n) => n.id)).toEqual([
          `remote:${srv}:session:r1:turn:1:result-ready`,
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("releases liveness when the session stops, falling back to the watch window", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");
      sync.setEventBus(bus);

      const running = {
        type: "session:status" as const, projectId: "p1", branch: "dev",
        sessionId: "remote-srv-p1-r1",
      };
      bus.emit({ ...running, status: "running" });
      bus.emit({ ...running, status: "stopped" });

      // The stop's own activity extended the window, so it IS still polled —
      // but via the persisted window, not the liveness set.
      const mapping = await storage.remoteSessionMappings.getByRemote(srv, "r1");
      expect(mapping!.notification_watch_until!).toBeGreaterThan(Date.now());

      // Prove the liveness set released it: with the window forced expired the
      // session is no longer a candidate.
      await storage.notificationSyncCursors.set(srv, "r1", 0);
      const expiredOnly = await storage.remoteSessionMappings.getNotificationSyncCandidates({
        now: mapping!.notification_watch_until! + 1,
        includeExpired: false,
      });
      expect(expiredOnly).toEqual([]);
    });

    it("extends the watch window on observed remote activity, throttled", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");
      sync.setEventBus(bus);

      const before = Date.now();
      bus.emit({
        type: "session:taskCompleted", projectId: "p1", branch: "dev",
        sessionId: "remote-srv-p1-r1",
      });
      await vi.waitFor(async () => {
        const m = await storage.remoteSessionMappings.getByRemote(srv, "r1");
        expect(m!.notification_watch_until!).toBeGreaterThanOrEqual(before + WATCH_WINDOW_MS - 5_000);
      });

      // A burst of further frames must not become a DB write each.
      const spy = vi.spyOn(storage.remoteSessionMappings, "extendNotificationWatch");
      for (let i = 0; i < 25; i++) {
        bus.emit({
          type: "session:process", projectId: "p1", branch: "dev",
          sessionId: "remote-srv-p1-r1", alive: true,
        });
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("ignores bus activity for local (non-remote) sessions", async () => {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");
      sync.setEventBus(bus);

      bus.emit({
        type: "session:status", projectId: "p1", branch: "dev",
        sessionId: "plain-local-session", status: "running",
      });
      await sync.syncAll({ includeExpired: false });
      // The local session has no mapping, and the remote one is unwatched.
      expect(proxy).not.toHaveBeenCalled();
    });

    it("does nothing (and makes no request) when there are no mappings", async () => {
      await sync.syncAll({ includeExpired: true });
      expect(proxy).not.toHaveBeenCalled();
    });

    it("skips a mapping whose project_remotes link is gone rather than throwing", async () => {
      await storage.remoteSessionMappings.upsert("orphan", "p1", "srv-unlinked", "r1", "dev", "from_start");
      await expect(sync.syncAll({ includeExpired: true })).resolves.toBeUndefined();
      expect(proxy).not.toHaveBeenCalled();
    });
  });

  /**
   * A worker milestone used to sit in the outbox until the next periodic tick —
   * measured at 23.7s end-to-end on a live front server, with the tick's phase
   * (not the work) deciding the number. These cover the completion-triggered
   * pull that replaces that wait; the tick remains the recovery backstop.
   */
  describe("completion-triggered sync", () => {
    const milestone = () =>
      ok([{ sessionId: "r1", events: [workerEvent(1)], headCursor: 1, nextCursor: 1, hasMore: false }]);

    const terminal = { projectId: "p1", branch: "dev", sessionId: "remote-srv-p1-r1" } as const;

    /** Mapped but NOT watched: only an explicit signal can reach it. */
    async function mappedSession() {
      const srv = await linkRemote();
      await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", srv, "r1", "dev", "from_start");
      sync.setEventBus(bus);
      return srv;
    }

    it("imports a finished turn's milestone without waiting for the periodic tick", async () => {
      const srv = await mappedSession();
      respond = milestone;
      // `start()` is deliberately never called: the completion event is the
      // only thing that can produce this import.
      bus.emit({ type: "session:taskCompleted", ...terminal });

      await vi.waitFor(async () => {
        expect((await inbox()).map((n) => n.id)).toEqual([`remote:${srv}:session:r1:turn:1:result-ready`]);
      });
    });

    /**
     * The turn's own `running` frame arrives minutes earlier and consumes the
     * 5-minute watch-extension throttle. A nudge sharing that throttle's state
     * would therefore be dropped for essentially every real completion.
     */
    it("fires even though the turn's own `running` frame already consumed the watch throttle", async () => {
      const srv = await mappedSession();
      bus.emit({ type: "session:status", ...terminal, status: "running" });
      await vi.waitFor(async () => {
        const m = await storage.remoteSessionMappings.getByRemote(srv, "r1");
        expect(m!.notification_watch_until).not.toBeNull();
      });

      respond = milestone;
      bus.emit({ type: "session:taskCompleted", ...terminal });
      await vi.waitFor(async () => {
        expect(await inbox()).toHaveLength(1);
      });
    });

    /**
     * A failed turn writes `session_failed` to the outbox but never emits
     * `taskCompleted`, and the remote `finished` frame is not bridged onto the
     * bus at all — the terminal status patch is the only signal there is.
     */
    it("accelerates a FAILED turn, whose only bridged signal is the terminal status", async () => {
      await mappedSession();
      respond = () => ok([{
        sessionId: "r1",
        events: [workerEvent(1, { kind: "session_failed", id: "session:r1:turn:1:failed" })],
        headCursor: 1, nextCursor: 1, hasMore: false,
      }]);

      bus.emit({ type: "session:status", ...terminal, status: "error" });
      await vi.waitFor(async () => {
        expect((await inbox()).map((n) => n.kind)).toEqual(["session_failed"]);
      });
    });

    it("coalesces a burst of terminal frames for one session into a single query", async () => {
      await mappedSession();
      respond = milestone;
      bus.emit({ type: "session:taskCompleted", ...terminal });
      bus.emit({ type: "session:status", ...terminal, status: "stopped" });
      bus.emit({ type: "session:taskCompleted", ...terminal });

      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toHaveLength(1);
    });

    it("is not blocked by an in-flight sweep stuck on a different server", async () => {
      const srvA = await linkRemote("a");
      const srvB = await linkRemote("b");
      await storage.remoteSessionMappings.upsert("remote-a-p1-r1", "p1", srvA, "r1", "dev", "from_start");
      await storage.remoteSessionMappings.upsert("remote-b-p1-rb", "p1", srvB, "rb", "dev", "from_start");
      await sync.extendWatch("remote-b-p1-rb");   // only B is in the periodic set
      sync.setEventBus(bus);

      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      proxy.mockImplementation(async (
        serverId: string, method: string, apiPath: string,
        body?: unknown, opts?: unknown,
      ): Promise<ProxyResult> => {
        calls.push({ serverId, method, path: apiPath, body: body as QueryBody, opts });
        if (serverId === srvB) await gate;   // B hangs, as an unreachable worker does
        return respond(body as QueryBody);
      });

      const sweep = sync.syncAll({ includeExpired: false });
      await vi.waitFor(() => expect(calls.some((c) => c.serverId === srvB)).toBe(true));

      respond = milestone;
      bus.emit({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "remote-a-p1-r1" });
      await vi.waitFor(async () => {
        expect((await inbox()).map((n) => n.id)).toEqual([`remote:${srvA}:session:r1:turn:1:result-ready`]);
      });

      release();
      await sweep;
    });

    it("sweeps servers concurrently instead of head-of-line serially", async () => {
      const srvA = await linkRemote("a");
      const srvB = await linkRemote("b");
      await storage.remoteSessionMappings.upsert("la", "p1", srvA, "ra", "dev", "from_start");
      await storage.remoteSessionMappings.upsert("lb", "p1", srvB, "rb", "dev", "from_start");

      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      proxy.mockImplementation(async (
        serverId: string, method: string, apiPath: string,
        body?: unknown, opts?: unknown,
      ): Promise<ProxyResult> => {
        calls.push({ serverId, method, path: apiPath, body: body as QueryBody, opts });
        await gate;
        return respond(body as QueryBody);
      });

      const sweep = sync.syncAll({ includeExpired: true });
      // Serial sweeping can only ever hold ONE query open behind the gate.
      await vi.waitFor(() => {
        expect(new Set(calls.map((c) => c.serverId))).toEqual(new Set([srvA, srvB]));
      });

      release();
      await sweep;
    });
  });
});
