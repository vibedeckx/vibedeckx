import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Mutable Clerk identity: each test sets currentUserId to impersonate a user.
const auth = vi.hoisted(() => ({ currentUserId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.currentUserId }),
  clerkClient: {},
}));

import notificationRoutes from "./notification-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Notification, Storage } from "../storage/types.js";

const row = (overrides: Partial<Notification> = {}): Notification => ({
  id: "n1",
  user_id: "user-1",
  kind: "session_result_ready",
  project_id: "p1",
  branch: "dev",
  session_id: "s1",
  workflow_run_id: null,
  title: "Session result is ready",
  body: "Fix login",
  created_at: 10,
  read_at: null,
  ...overrides,
});

describe("notification routes", () => {
  let dir: string;
  let storage: Storage;
  let app: FastifyInstance;

  async function build(authEnabled: boolean) {
    const instance = Fastify();
    instance.decorate("authEnabled", authEnabled);
    instance.decorate("storage", storage);
    await instance.register(notificationRoutes);
    await instance.ready();
    return instance;
  }

  beforeEach(async () => {
    auth.currentUserId = "user-1";
    dir = mkdtempSync(path.join(tmpdir(), "vdx-notif-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    app = await build(true);
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("GET /api/notifications", () => {
    it("returns only the authenticated user's rows, newest first", async () => {
      await storage.notifications.insert(row({ id: "mine-old", created_at: 1 }));
      await storage.notifications.insert(row({ id: "mine-new", created_at: 9 }));
      await storage.notifications.insert(row({ id: "theirs", user_id: "user-2" }));

      const res = await app.inject({ method: "GET", url: "/api/notifications" });
      expect(res.statusCode).toBe(200);
      expect(res.json().notifications.map((n: Notification) => n.id)).toEqual(["mine-new", "mine-old"]);
    });

    it("filters to unread with ?unread=true", async () => {
      await storage.notifications.insert(row({ id: "unread" }));
      await storage.notifications.insert(row({ id: "read", read_at: 5 }));

      const res = await app.inject({ method: "GET", url: "/api/notifications?unread=true" });
      expect(res.json().notifications.map((n: Notification) => n.id)).toEqual(["unread"]);
    });

    it("clamps an absurd limit instead of accepting it", async () => {
      const res = await app.inject({ method: "GET", url: "/api/notifications?limit=999999" });
      expect(res.statusCode).toBe(200);
    });

    it("401s without a Clerk identity", async () => {
      auth.currentUserId = null;
      const res = await app.inject({ method: "GET", url: "/api/notifications" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("PATCH /api/notifications/:id/read", () => {
    it("marks the caller's own notification read", async () => {
      await storage.notifications.insert(row());
      const res = await app.inject({ method: "PATCH", url: "/api/notifications/n1/read" });
      expect(res.statusCode).toBe(200);
      expect((await storage.notifications.listForUser("user-1", { limit: 1 }))[0].read_at).not.toBeNull();
    });

    it("cannot mutate another user's row, and 404s rather than revealing it exists", async () => {
      await storage.notifications.insert(row({ id: "theirs", user_id: "user-2" }));
      const res = await app.inject({ method: "PATCH", url: "/api/notifications/theirs/read" });
      expect(res.statusCode).toBe(404);
      expect((await storage.notifications.listForUser("user-2", { limit: 1 }))[0].read_at).toBeNull();
    });

    it("404s for an unknown id — indistinguishable from the not-owned case", async () => {
      const res = await app.inject({ method: "PATCH", url: "/api/notifications/nope/read" });
      expect(res.statusCode).toBe(404);
    });

    it("is idempotent for an already-read row", async () => {
      await storage.notifications.insert(row({ read_at: 5 }));
      const res = await app.inject({ method: "PATCH", url: "/api/notifications/n1/read" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /api/notifications/read-all", () => {
    it("is user-scoped", async () => {
      await storage.notifications.insert(row({ id: "mine" }));
      await storage.notifications.insert(row({ id: "theirs", user_id: "user-2" }));

      const res = await app.inject({ method: "POST", url: "/api/notifications/read-all" });
      expect(res.statusCode).toBe(200);
      expect(await storage.notifications.listForUser("user-1", { limit: 10, unreadOnly: true })).toEqual([]);
      expect(await storage.notifications.listForUser("user-2", { limit: 10, unreadOnly: true })).toHaveLength(1);
    });
  });

  describe("solo (no-auth) mode", () => {
    it("uses resolveUserId's local sentinel", async () => {
      const solo = await build(false);
      try {
        await storage.notifications.insert(row({ id: "solo-row", user_id: "local" }));
        await storage.notifications.insert(row({ id: "clerk-row", user_id: "user-1" }));

        const res = await solo.inject({ method: "GET", url: "/api/notifications" });
        expect(res.json().notifications.map((n: Notification) => n.id)).toEqual(["solo-row"]);

        expect((await solo.inject({ method: "PATCH", url: "/api/notifications/solo-row/read" })).statusCode).toBe(200);
        expect((await solo.inject({ method: "PATCH", url: "/api/notifications/clerk-row/read" })).statusCode).toBe(404);
      } finally {
        await solo.close();
      }
    });
  });
});
