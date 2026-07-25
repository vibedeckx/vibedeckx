import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Notification, NotificationOutboxEvent, Storage } from "./storage/types.js";
import { EventBus, type GlobalEvent } from "./event-bus.js";
import { NotificationService, READ_HISTORY_PER_USER, notificationBody } from "./notification-service.js";

const event = (
  overrides: Partial<Omit<NotificationOutboxEvent, "seq">> = {},
): Omit<NotificationOutboxEvent, "seq"> => ({
  id: "session:s1:turn:2:result-ready",
  kind: "session_result_ready",
  project_id: "p1",
  branch: "dev",
  session_id: "s1",
  workflow_run_id: null,
  created_at: 1000,
  ...overrides,
});

describe("NotificationService local drain", () => {
  let dir: string;
  let storage: Storage;
  let bus: EventBus;
  let seen: GlobalEvent[];
  let service: NotificationService;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-notif-svc-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "Checkout", path: "/tmp/p" }, "u1");
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "dev" });
    bus = new EventBus();
    seen = [];
    bus.subscribe((e) => seen.push(e));
    service = new NotificationService(storage, bus);
  });

  afterEach(async () => {
    service.shutdown();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const created = () => seen.filter((e) => e.type === "notification:created");

  it("imports each local outbox event exactly once", async () => {
    await storage.notificationOutbox.insert(event());
    await service.drainLocal();
    await service.drainLocal(); // second pass: cursor already past it

    const rows = await storage.notifications.listForUser("u1", { limit: 100 });
    expect(rows).toHaveLength(1);
    expect(created()).toHaveLength(1);
  });

  it("derives the user from the project owner, never from the event", async () => {
    await storage.projects.create({ id: "p2", name: "Other", path: "/tmp/p2" }, "u2");
    await storage.notificationOutbox.insert(event({ id: "a", project_id: "p1", session_id: "s1" }));
    await storage.notificationOutbox.insert(event({ id: "b", project_id: "p2", session_id: "s2" }));
    await service.drainLocal();

    expect((await storage.notifications.listForUser("u1", { limit: 100 })).map((n) => n.id)).toEqual(["a"]);
    expect((await storage.notifications.listForUser("u2", { limit: 100 })).map((n) => n.id)).toEqual(["b"]);
  });

  it("maps a solo-mode empty owner onto the local sentinel", async () => {
    await storage.projects.create({ id: "solo", name: "Solo", path: "/tmp/solo" });
    await storage.notificationOutbox.insert(event({ id: "s", project_id: "solo", session_id: "sx" }));
    await service.drainLocal();
    expect((await storage.notifications.listForUser("local", { limit: 100 })).map((n) => n.id)).toEqual(["s"]);
  });

  it("skips (and does not stall on) an event whose project no longer exists", async () => {
    await storage.notificationOutbox.insert(event({ id: "orphan", project_id: "gone", session_id: "sx" }));
    await storage.notificationOutbox.insert(event({ id: "good" }));
    await service.drainLocal();

    expect((await storage.notifications.listForUser("u1", { limit: 100 })).map((n) => n.id)).toEqual(["good"]);
    // The cursor advanced past the orphan, so a later drain doesn't retry it forever.
    await storage.notificationOutbox.insert(event({ id: "later" }));
    await service.drainLocal();
    expect((await storage.notifications.listForUser("u1", { limit: 100 })).map((n) => n.id).sort())
      .toEqual(["good", "later"]);
  });

  it("emits notification:created only for a newly inserted inbox row", async () => {
    await storage.notificationOutbox.insert(event());
    await service.drainLocal();
    expect(created()).toHaveLength(1);
    const emitted = created()[0] as Extract<GlobalEvent, { type: "notification:created" }>;
    // projectId stays at the event top level so the SSE tenant filter still works.
    expect(emitted.projectId).toBe("p1");
    expect(emitted.notification.id).toBe("session:s1:turn:2:result-ready");

    // Crash/retry window: the row is already in the inbox but the cursor was
    // never committed. Replaying must not double-ding.
    await service.resetLocalCursorForTest();
    seen.length = 0;
    await service.drainLocal();
    expect(created()).toHaveLength(0);
    expect(await storage.notifications.listForUser("u1", { limit: 100 })).toHaveLength(1);
  });

  it("startup drain recovers an event committed before the service existed", async () => {
    await storage.notificationOutbox.insert(event({ id: "pre-boot" }));
    const fresh = new NotificationService(storage, bus);
    await fresh.drainLocal();
    fresh.shutdown();
    expect((await storage.notifications.listForUser("u1", { limit: 100 })).map((n) => n.id)).toEqual(["pre-boot"]);
  });

  it("pages through more events than one batch", async () => {
    for (let i = 0; i < 250; i++) {
      await storage.notificationOutbox.insert(event({ id: `e-${i}`, created_at: i }));
    }
    await service.drainLocal();
    expect(await storage.notifications.listForUser("u1", { limit: 500 })).toHaveLength(250);
  });

  describe("copy generation", () => {
    it("uses the stable semantic title per kind", async () => {
      await storage.notificationOutbox.insert(event({ id: "a", kind: "session_result_ready" }));
      await storage.notificationOutbox.insert(event({ id: "b", kind: "session_failed" }));
      await storage.notificationOutbox.insert(event({ id: "c", kind: "review_ready" }));
      await storage.notificationOutbox.insert(event({ id: "d", kind: "workflow_failed" }));
      await service.drainLocal();

      const byId = new Map(
        (await storage.notifications.listForUser("u1", { limit: 100 })).map((n) => [n.id, n]),
      );
      expect(byId.get("a")!.title).toBe("Session result is ready");
      expect(byId.get("b")!.title).toBe("Session failed");
      expect(byId.get("c")!.title).toBe("Review feedback is ready");
      expect(byId.get("d")!.title).toBe("Workflow needs attention");
    });

    it("prefers the front-known session title as the body", async () => {
      await storage.agentSessions.updateTitle("s1", "Fix login redirect");
      await storage.notificationOutbox.insert(event());
      await service.drainLocal();
      expect((await storage.notifications.listForUser("u1", { limit: 1 }))[0].body).toBe("Fix login redirect");
    });

    it("falls back past a placeholder title to the branch, then the project", async () => {
      expect(notificationBody({ sessionTitle: "New Session", branch: "dev", projectName: "Checkout" })).toBe("dev");
      expect(notificationBody({ sessionTitle: "  ", branch: "dev", projectName: "Checkout" })).toBe("dev");
      expect(notificationBody({ sessionTitle: null, branch: null, projectName: "Checkout" })).toBe("Checkout");
      expect(notificationBody({ sessionTitle: null, branch: null, projectName: null })).toBeNull();
      expect(notificationBody({ sessionTitle: "Real title", branch: "dev", projectName: "Checkout" })).toBe("Real title");
    });

    it("uses the branch when the session has only the placeholder title", async () => {
      await storage.agentSessions.updateTitle("s1", "New Session");
      await storage.notificationOutbox.insert(event());
      await service.drainLocal();
      expect((await storage.notifications.listForUser("u1", { limit: 1 }))[0].body).toBe("dev");
    });
  });

  describe("retention cleanup", () => {
    it("preserves every unread row and only the newest N read rows per user", async () => {
      const total = READ_HISTORY_PER_USER + 5;
      const rows: Notification[] = [];
      for (let i = 0; i < total; i++) {
        rows.push({
          id: `read-${i}`, user_id: "u1", kind: "session_result_ready", project_id: "p1",
          branch: "dev", session_id: "s1", workflow_run_id: null,
          title: "t", body: null, created_at: i, read_at: 1,
        });
      }
      rows.push({
        id: "unread-ancient", user_id: "u1", kind: "session_failed", project_id: "p1",
        branch: "dev", session_id: "s1", workflow_run_id: null,
        title: "t", body: null, created_at: -1, read_at: null,
      });
      for (const row of rows) await storage.notifications.insert(row);

      await service.cleanup();

      const kept = await storage.notifications.listForUser("u1", { limit: 5000 });
      expect(kept).toHaveLength(READ_HISTORY_PER_USER + 1);
      // The oldest unread survives even though it is older than every read row.
      expect(kept.some((n) => n.id === "unread-ancient")).toBe(true);
      expect(kept.some((n) => n.id === "read-0")).toBe(false);
      expect(kept.some((n) => n.id === `read-${total - 1}`)).toBe(true);
    });

    it("prunes worker outbox rows past the retention window", async () => {
      const now = Date.now();
      await storage.notificationOutbox.insert(event({ id: "ancient", created_at: now - 200 * 86_400_000 }));
      await storage.notificationOutbox.insert(event({ id: "recent", created_at: now }));
      await service.cleanup();
      expect((await storage.notificationOutbox.listAfter(0, 100)).map((r) => r.id)).toEqual(["recent"]);
    });
  });
});
