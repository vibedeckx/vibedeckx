import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Machine-facing route: an unauthenticated browser caller must be rejected when
// auth is on, so the Clerk seam has to be controllable here too.
const auth = vi.hoisted(() => ({ currentUserId: null as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.currentUserId }),
  clerkClient: {},
}));

import notificationOutboxRoutes, {
  MAX_EVENTS_PER_SESSION,
  MAX_SESSIONS_PER_REQUEST,
} from "./notification-outbox-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { NotificationOutboxEvent, Storage } from "../storage/types.js";

const URL_PATH = "/api/notification-outbox/query";

interface SessionResult {
  sessionId: string;
  events: NotificationOutboxEvent[];
  headCursor: number;
  nextCursor: number;
  hasMore: boolean;
  sessionTitle: string | null;
}

describe("POST /api/notification-outbox/query", () => {
  let dir: string;
  let storage: Storage;
  let app: FastifyInstance;

  async function build(authEnabled: boolean) {
    const instance = Fastify();
    instance.decorate("authEnabled", authEnabled);
    instance.decorate("storage", storage);
    await instance.register(notificationOutboxRoutes);
    await instance.ready();
    return instance;
  }

  const insert = (id: string, sessionId: string) =>
    storage.notificationOutbox.insert({
      id,
      kind: "session_result_ready",
      project_id: "p1",
      branch: "dev",
      session_id: sessionId,
      workflow_run_id: null,
      created_at: 1,
    });

  const query = (instance: FastifyInstance, payload: unknown) =>
    instance.inject({ method: "POST", url: URL_PATH, payload: payload as object });

  beforeEach(async () => {
    auth.currentUserId = null;
    dir = mkdtempSync(path.join(tmpdir(), "vdx-outbox-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    // No auth configured: the direct-HTTP / reverse-connect trust boundary is
    // enforced by the server's own API-key middleware, which is out of scope here.
    app = await build(false);
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns ordered events for each requested session with its own cursor", async () => {
    const a1 = await insert("a1", "r1");
    const a2 = await insert("a2", "r1");
    const b1 = await insert("b1", "r2");

    const res = await query(app, {
      sessions: [{ sessionId: "r1", after: 0 }, { sessionId: "r2", after: b1.seq }],
    });
    expect(res.statusCode).toBe(200);
    const sessions: SessionResult[] = res.json().sessions;

    const r1 = sessions.find((s) => s.sessionId === "r1")!;
    expect(r1.events.map((e) => e.id)).toEqual(["a1", "a2"]);
    expect(r1.events[0].seq).toBe(a1.seq);
    expect(r1.headCursor).toBe(a2.seq);
    expect(r1.nextCursor).toBe(a2.seq);
    expect(r1.hasMore).toBe(false);

    // r2's cursor is already at its head → nothing new.
    const r2 = sessions.find((s) => s.sessionId === "r2")!;
    expect(r2.events).toEqual([]);
    expect(r2.headCursor).toBe(b1.seq);
    expect(r2.nextCursor).toBe(b1.seq);
  });

  it("never returns events for an unrequested session", async () => {
    await insert("a1", "r1");
    await insert("secret", "r-other");

    const res = await query(app, { sessions: [{ sessionId: "r1", after: 0 }] });
    const sessions: SessionResult[] = res.json().sessions;
    expect(sessions.map((s) => s.sessionId)).toEqual(["r1"]);
    expect(JSON.stringify(sessions)).not.toContain("secret");
  });

  it("reports a zero head for a session with no events", async () => {
    const res = await query(app, { sessions: [{ sessionId: "never-ran", after: 0 }] });
    const [only]: SessionResult[] = res.json().sessions;
    expect(only).toMatchObject({ sessionId: "never-ran", events: [], headCursor: 0, nextCursor: 0, hasMore: false });
  });

  it("resolves the session's current title at query time when events are returned", async () => {
    await storage.projects.create({ id: "p1", name: "Proj", path: null });
    await storage.agentSessions.create({ id: "r1", project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateTitle("r1", "Fix checkout flow");
    await insert("a1", "r1");

    const res = await query(app, { sessions: [{ sessionId: "r1", after: 0 }] });
    const [only]: SessionResult[] = res.json().sessions;
    expect(only.sessionTitle).toBe("Fix checkout flow");
  });

  it("returns a null title for an unknown session and for pages with no events", async () => {
    const a1 = await insert("a1", "r1");

    // Events but no local session row (deleted, or never persisted).
    const withEvents = await query(app, { sessions: [{ sessionId: "r1", after: 0 }] });
    expect((withEvents.json().sessions as SessionResult[])[0].sessionTitle).toBeNull();

    // Cursor at head: no events, so there is nothing the title would label.
    await storage.projects.create({ id: "p1", name: "Proj", path: null });
    await storage.agentSessions.create({ id: "r1", project_id: "p1", branch: "dev" });
    await storage.agentSessions.updateTitle("r1", "Fix checkout flow");
    const empty = await query(app, { sessions: [{ sessionId: "r1", after: a1.seq }] });
    expect((empty.json().sessions as SessionResult[])[0].sessionTitle).toBeNull();
  });

  it("headOnly returns the head cursor without event payloads", async () => {
    await insert("a1", "r1");
    const a2 = await insert("a2", "r1");

    const res = await query(app, { sessions: [{ sessionId: "r1", after: 0, headOnly: true }] });
    const [only]: SessionResult[] = res.json().sessions;
    // This is how a search-discovered `from_now` mapping establishes a baseline
    // without replaying (or sounding) historical milestones.
    expect(only.events).toEqual([]);
    expect(only.headCursor).toBe(a2.seq);
    expect(only.nextCursor).toBe(a2.seq);
    expect(only.hasMore).toBe(false);
    expect(only.sessionTitle).toBeNull();
  });

  it("limits events per session and flags hasMore", async () => {
    for (let i = 0; i < 5; i++) await insert(`e${i}`, "r1");

    const res = await query(app, { sessions: [{ sessionId: "r1", after: 0 }], limitPerSession: 2 });
    const [only]: SessionResult[] = res.json().sessions;
    expect(only.events.map((e) => e.id)).toEqual(["e0", "e1"]);
    expect(only.hasMore).toBe(true);
    // nextCursor is the last RETURNED row, so the caller resumes exactly here.
    expect(only.nextCursor).toBe(only.events[1].seq);
    expect(only.headCursor).toBeGreaterThan(only.nextCursor);
  });

  it("exposes no user ids or inbox read state", async () => {
    await insert("a1", "r1");
    const res = await query(app, { sessions: [{ sessionId: "r1", after: 0 }] });
    const body = res.payload;
    expect(body).not.toContain("user_id");
    expect(body).not.toContain("read_at");
    expect(body).not.toContain("title");
  });

  describe("validation", () => {
    it("400s on a missing or non-array sessions field", async () => {
      expect((await query(app, {})).statusCode).toBe(400);
      expect((await query(app, { sessions: "r1" })).statusCode).toBe(400);
    });

    it("400s on an empty sessions array", async () => {
      expect((await query(app, { sessions: [] })).statusCode).toBe(400);
    });

    it("400s on a malformed session entry", async () => {
      expect((await query(app, { sessions: [{ after: 0 }] })).statusCode).toBe(400);
      expect((await query(app, { sessions: [{ sessionId: "", after: 0 }] })).statusCode).toBe(400);
      expect((await query(app, { sessions: [{ sessionId: "r1", after: -1 }] })).statusCode).toBe(400);
      expect((await query(app, { sessions: [{ sessionId: "r1", after: "x" }] })).statusCode).toBe(400);
    });

    it("400s on duplicate session ids", async () => {
      const res = await query(app, {
        sessions: [{ sessionId: "r1", after: 0 }, { sessionId: "r1", after: 5 }],
      });
      expect(res.statusCode).toBe(400);
    });

    it("400s on an excessive session array", async () => {
      const sessions = Array.from({ length: MAX_SESSIONS_PER_REQUEST + 1 }, (_, i) => ({
        sessionId: `r${i}`, after: 0,
      }));
      expect((await query(app, { sessions })).statusCode).toBe(400);
    });

    it("400s on an excessive limitPerSession", async () => {
      const res = await query(app, {
        sessions: [{ sessionId: "r1", after: 0 }],
        limitPerSession: MAX_EVENTS_PER_SESSION + 1,
      });
      expect(res.statusCode).toBe(400);
    });

    it("accepts the maximum session count", async () => {
      const sessions = Array.from({ length: MAX_SESSIONS_PER_REQUEST }, (_, i) => ({
        sessionId: `r${i}`, after: 0,
      }));
      expect((await query(app, { sessions })).statusCode).toBe(200);
    });
  });

  describe("with auth enabled", () => {
    it("rejects an unauthenticated browser caller", async () => {
      const guarded = await build(true);
      try {
        auth.currentUserId = null;
        const res = await query(guarded, { sessions: [{ sessionId: "r1", after: 0 }] });
        expect(res.statusCode).toBe(401);
      } finally {
        await guarded.close();
      }
    });

    it("allows an authenticated caller through", async () => {
      const guarded = await build(true);
      try {
        auth.currentUserId = "user-1";
        const res = await query(guarded, { sessions: [{ sessionId: "r1", after: 0 }] });
        expect(res.statusCode).toBe(200);
      } finally {
        await guarded.close();
      }
    });
  });
});
