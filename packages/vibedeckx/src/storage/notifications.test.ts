import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Notification, NotificationOutboxEvent, Storage } from "./types.js";

const outboxEvent = (
  overrides: Partial<Omit<NotificationOutboxEvent, "seq">> = {},
): Omit<NotificationOutboxEvent, "seq"> => ({
  id: "session:s1:turn:3:result-ready",
  kind: "session_result_ready",
  project_id: "p1",
  branch: "dev",
  session_id: "s1",
  workflow_run_id: null,
  created_at: 1000,
  ...overrides,
});

const notification = (overrides: Partial<Notification> = {}): Notification => ({
  id: "remote:srv1:session:r1:turn:3:result-ready",
  user_id: "u1",
  kind: "session_result_ready",
  project_id: "p1",
  branch: "dev",
  session_id: "remote-srv1-p1-r1",
  workflow_run_id: null,
  title: "Session result is ready",
  body: "Fix login",
  created_at: 10,
  read_at: null,
  ...overrides,
});

describe("notification storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-notif-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" }, "u1");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("notificationOutbox", () => {
    it("assigns increasing seq values and dedupes on the deterministic id", async () => {
      const first = await storage.notificationOutbox.insert(outboxEvent());
      const second = await storage.notificationOutbox.insert(
        outboxEvent({ id: "session:s1:turn:5:result-ready" }),
      );
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(true);
      expect(second.seq!).toBeGreaterThan(first.seq!);

      const dupe = await storage.notificationOutbox.insert(outboxEvent());
      expect(dupe.inserted).toBe(false);

      const rows = await storage.notificationOutbox.listAfter(0, 100);
      expect(rows.map((r) => r.id)).toEqual([
        "session:s1:turn:3:result-ready",
        "session:s1:turn:5:result-ready",
      ]);
    });

    it("returns rows in seq order for one requested session only", async () => {
      await storage.notificationOutbox.insert(outboxEvent({ id: "a", session_id: "s1" }));
      await storage.notificationOutbox.insert(outboxEvent({ id: "b", session_id: "s2" }));
      await storage.notificationOutbox.insert(outboxEvent({ id: "c", session_id: "s1" }));

      const rows = await storage.notificationOutbox.listBySessionAfter("s1", 0, 100);
      expect(rows.map((r) => r.id)).toEqual(["a", "c"]);
      expect(rows[0].seq).toBeLessThan(rows[1].seq);
    });

    it("honors the after cursor and per-session head", async () => {
      const a = await storage.notificationOutbox.insert(outboxEvent({ id: "a", session_id: "s1" }));
      const c = await storage.notificationOutbox.insert(outboxEvent({ id: "c", session_id: "s1" }));
      await storage.notificationOutbox.insert(outboxEvent({ id: "b", session_id: "s2" }));

      expect(await storage.notificationOutbox.headBySession("s1")).toBe(c.seq);
      expect(await storage.notificationOutbox.headBySession("nope")).toBe(0);

      const rows = await storage.notificationOutbox.listBySessionAfter("s1", a.seq!, 100);
      expect(rows.map((r) => r.id)).toEqual(["c"]);
    });

    it("prunes rows older than a cutoff", async () => {
      await storage.notificationOutbox.insert(outboxEvent({ id: "old", created_at: 100 }));
      await storage.notificationOutbox.insert(outboxEvent({ id: "new", created_at: 5000 }));
      await storage.notificationOutbox.pruneOlderThan(1000);
      const rows = await storage.notificationOutbox.listAfter(0, 100);
      expect(rows.map((r) => r.id)).toEqual(["new"]);
    });
  });

  describe("notifications inbox", () => {
    it("inserts idempotently on the notification id", async () => {
      expect(await storage.notifications.insert(notification())).toBe(true);
      expect(await storage.notifications.insert(notification({ title: "other" }))).toBe(false);
      const rows = await storage.notifications.listForUser("u1", { limit: 100 });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Session result is ready");
    });

    it("lists and mutates only for the supplied userId", async () => {
      await storage.notifications.insert(notification({ id: "n-mine", user_id: "u1" }));
      await storage.notifications.insert(notification({ id: "n-theirs", user_id: "u2" }));

      expect((await storage.notifications.listForUser("u1", { limit: 100 })).map((n) => n.id)).toEqual([
        "n-mine",
      ]);

      // Cannot mark another user's notification read.
      expect(await storage.notifications.markRead("n-theirs", "u1")).toBe(false);
      expect((await storage.notifications.listForUser("u2", { limit: 100 }))[0].read_at).toBeNull();

      expect(await storage.notifications.markRead("n-mine", "u1")).toBe(true);
      expect((await storage.notifications.listForUser("u1", { limit: 100 }))[0].read_at).not.toBeNull();
    });

    it("markAllRead is user-scoped and unread filtering works", async () => {
      await storage.notifications.insert(notification({ id: "n1", user_id: "u1", created_at: 1 }));
      await storage.notifications.insert(notification({ id: "n2", user_id: "u1", created_at: 2 }));
      await storage.notifications.insert(notification({ id: "n3", user_id: "u2", created_at: 3 }));

      await storage.notifications.markAllRead("u1");
      expect(await storage.notifications.listForUser("u1", { limit: 100, unreadOnly: true })).toEqual([]);
      expect(
        (await storage.notifications.listForUser("u2", { limit: 100, unreadOnly: true })).map((n) => n.id),
      ).toEqual(["n3"]);
    });

    it("lists newest first", async () => {
      await storage.notifications.insert(notification({ id: "old", created_at: 1 }));
      await storage.notifications.insert(notification({ id: "new", created_at: 9 }));
      expect((await storage.notifications.listForUser("u1", { limit: 100 })).map((n) => n.id)).toEqual([
        "new",
        "old",
      ]);
    });

    it("cleanup keeps every unread row and only the newest N read rows per user", async () => {
      for (let i = 0; i < 5; i++) {
        await storage.notifications.insert(
          notification({ id: `read-${i}`, created_at: i, read_at: 100 + i }),
        );
      }
      await storage.notifications.insert(notification({ id: "unread-old", created_at: 0, read_at: null }));

      await storage.notifications.cleanup(2);

      const rows = await storage.notifications.listForUser("u1", { limit: 100 });
      expect(rows.map((n) => n.id).sort()).toEqual(["read-3", "read-4", "unread-old"]);
    });
  });

  describe("importRemote", () => {
    it("imports a remote event and advances the session cursor atomically", async () => {
      const result = await storage.notifications.importRemote({
        notification: notification(),
        remoteServerId: "srv1",
        remoteSessionId: "r1",
        seq: 7,
      });

      expect(result.inserted).toBe(true);
      expect(await storage.notificationSyncCursors.get("srv1", "r1")).toBe(7);
    });

    it("replaying the same page does not duplicate but keeps the cursor", async () => {
      await storage.notifications.importRemote({
        notification: notification(),
        remoteServerId: "srv1",
        remoteSessionId: "r1",
        seq: 7,
      });
      const again = await storage.notifications.importRemote({
        notification: notification(),
        remoteServerId: "srv1",
        remoteSessionId: "r1",
        seq: 7,
      });
      expect(again.inserted).toBe(false);
      expect((await storage.notifications.listForUser("u1", { limit: 100 })).length).toBe(1);
      expect(await storage.notificationSyncCursors.get("srv1", "r1")).toBe(7);
    });

    it("never moves a cursor backward", async () => {
      await storage.notificationSyncCursors.set("srv1", "r1", 42);
      await storage.notifications.importRemote({
        notification: notification({ id: "n-late" }),
        remoteServerId: "srv1",
        remoteSessionId: "r1",
        seq: 7,
      });
      expect(await storage.notificationSyncCursors.get("srv1", "r1")).toBe(42);
    });

    it("cursors are scoped per (remoteServerId, remoteSessionId)", async () => {
      await storage.notificationSyncCursors.set("srv1", "r1", 5);
      await storage.notificationSyncCursors.set("srv2", "r1", 9);
      expect(await storage.notificationSyncCursors.get("srv1", "r1")).toBe(5);
      expect(await storage.notificationSyncCursors.get("srv2", "r1")).toBe(9);
      expect(await storage.notificationSyncCursors.get("srv1", "unknown")).toBeUndefined();
    });

    it("getMany returns cursors for the requested sessions of one server", async () => {
      await storage.notificationSyncCursors.set("srv1", "r1", 5);
      await storage.notificationSyncCursors.set("srv1", "r2", 6);
      await storage.notificationSyncCursors.set("srv2", "r3", 7);
      const map = await storage.notificationSyncCursors.getMany("srv1", ["r1", "r2", "r3"]);
      expect(map.get("r1")).toBe(5);
      expect(map.get("r2")).toBe(6);
      expect(map.has("r3")).toBe(false);
    });
  });

  describe("remoteSessionMappings notification sync policy", () => {
    it("resolves a persisted mapping by (remoteServerId, remoteSessionId)", async () => {
      await storage.remoteSessionMappings.upsert("local-1", "p1", "srv1", "r1", "dev");
      const mapping = await storage.remoteSessionMappings.getByRemote("srv1", "r1");
      expect(mapping?.local_session_id).toBe("local-1");
      expect(mapping?.project_id).toBe("p1");
      expect(await storage.remoteSessionMappings.getByRemote("srv1", "nope")).toBeUndefined();
    });

    it("defaults to from_now and records an explicit from_start on insert", async () => {
      await storage.remoteSessionMappings.upsert("local-1", "p1", "srv1", "r1", "dev");
      await storage.remoteSessionMappings.upsert("local-2", "p1", "srv1", "r2", "dev", "from_start");

      expect((await storage.remoteSessionMappings.getByRemote("srv1", "r1"))?.notification_sync_start).toBe(
        "from_now",
      );
      expect((await storage.remoteSessionMappings.getByRemote("srv1", "r2"))?.notification_sync_start).toBe(
        "from_start",
      );
    });

    it("re-upsert never resets an existing policy, watch window, or cursor", async () => {
      await storage.remoteSessionMappings.upsert("local-1", "p1", "srv1", "r1", "dev", "from_start");
      await storage.remoteSessionMappings.extendNotificationWatch("local-1", 5_000);
      await storage.notificationSyncCursors.set("srv1", "r1", 11);

      // A re-upsert that asks for from_now must not downgrade the policy.
      await storage.remoteSessionMappings.upsert("local-1", "p1", "srv1", "r1", "dev", "from_now");

      const mapping = await storage.remoteSessionMappings.getByRemote("srv1", "r1");
      expect(mapping?.notification_sync_start).toBe("from_start");
      expect(mapping?.notification_watch_until).toBe(5_000);
      expect(await storage.notificationSyncCursors.get("srv1", "r1")).toBe(11);
    });

    it("extendNotificationWatch only moves the boundary forward", async () => {
      await storage.remoteSessionMappings.upsert("local-1", "p1", "srv1", "r1", "dev");
      await storage.remoteSessionMappings.extendNotificationWatch("local-1", 5_000);
      await storage.remoteSessionMappings.extendNotificationWatch("local-1", 1_000);
      expect((await storage.remoteSessionMappings.getByRemote("srv1", "r1"))?.notification_watch_until).toBe(
        5_000,
      );
    });

    it("watched-mapping queries exclude expired historical mappings", async () => {
      await storage.remoteSessionMappings.upsert("watched", "p1", "srv1", "r1", "dev");
      await storage.remoteSessionMappings.extendNotificationWatch("watched", 10_000);
      await storage.remoteSessionMappings.upsert("expired", "p1", "srv1", "r2", "dev");
      await storage.remoteSessionMappings.extendNotificationWatch("expired", 1_000);
      await storage.remoteSessionMappings.upsert("never-watched", "p1", "srv1", "r3", "dev");

      const watched = await storage.remoteSessionMappings.getNotificationSyncCandidates({
        now: 5_000,
        includeExpired: false,
      });
      expect(watched.map((m) => m.local_session_id)).toEqual(["watched"]);

      const all = await storage.remoteSessionMappings.getNotificationSyncCandidates({
        now: 5_000,
        includeExpired: true,
      });
      expect(all.map((m) => m.local_session_id).sort()).toEqual(["expired", "never-watched", "watched"]);
    });

    it("deleting a mapping deletes its cursor", async () => {
      await storage.remoteSessionMappings.upsert("local-1", "p1", "srv1", "r1", "dev");
      await storage.notificationSyncCursors.set("srv1", "r1", 4);
      await storage.remoteSessionMappings.delete("local-1");
      expect(await storage.notificationSyncCursors.get("srv1", "r1")).toBeUndefined();
    });
  });

  describe("projects.getOwnerId", () => {
    it("returns the stored owner without a user scope", async () => {
      expect(await storage.projects.getOwnerId("p1")).toBe("u1");
      expect(await storage.projects.getOwnerId("nope")).toBeUndefined();
    });

    it("returns the empty-string sentinel for solo-mode projects", async () => {
      await storage.projects.create({ id: "p2", name: "solo", path: "/tmp/solo" });
      expect(await storage.projects.getOwnerId("p2")).toBe("");
    });
  });
});
