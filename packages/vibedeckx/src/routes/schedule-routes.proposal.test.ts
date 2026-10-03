import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const auth = vi.hoisted(() => ({ currentUserId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.currentUserId }),
  clerkClient: {},
}));

import scheduleRoutes from "./schedule-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import type { SchedulerService } from "../scheduler.js";
import type { GlobalEvent } from "../event-bus.js";
import { RetentionHoldSync, scheduleHoldSource } from "../retention-holds.js";
import type { ProxyResult } from "../utils/remote-proxy.js";

/** Confirming an agent's propose_schedule card (see docs/schedule-proposal-tool-design.md §3.2). */
describe("schedule create from an agent proposal", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  const reschedule = vi.fn(async () => {});
  let emitted: GlobalEvent[];
  /** What the hub pushed to the worker, and how the worker answers. */
  let pushed: Array<{ path: string; body: unknown }>;
  let workerAnswer: () => ProxyResult;
  /** Worker-side session ids the fake worker reports as holding. */
  let heldOnWorker: string[];

  const body = (over: Record<string, unknown> = {}) => ({
    name: "Watch flakiness",
    cron_expr: "0 9 * * *",
    timezone: "Asia/Shanghai",
    run_type: "prompt",
    prompt_provider: "codex",
    content: "Re-run the flaky suite and report regressions",
    cwd_mode: "branch",
    branch: "feature-x",
    source: { session_id: "sess-1", tool_use_id: "toolu_1" },
    ...over,
  });

  /** Hub-side local id of a remote session — no agent_sessions row, only a mapping. */
  const REMOTE_SESSION = "remote-srv-1-project-1-abc";
  let remoteServerId: string;

  const create = (payload: unknown, projectId = "project-1") =>
    app.inject({ method: "POST", url: `/api/projects/${projectId}/schedules`, payload: payload as object });

  beforeEach(async () => {
    auth.currentUserId = "user-1";
    reschedule.mockClear();
    emitted = [];
    pushed = [];
    workerAnswer = () => ({ ok: true, status: 200, data: {} });
    heldOnWorker = [];
    dir = mkdtempSync(path.join(tmpdir(), "vdx-schedule-proposal-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "Mine", path: "/tmp/mine" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Other", path: "/tmp/other" }, "user-1");
    await storage.agentSessions.create({ id: "sess-1", project_id: "project-1", branch: "feature-x" });
    // A remote session is a mapping plus the project→remote association that
    // authorizes it; both are needed for the source to resolve.
    const remote = await storage.remoteServers.create({ name: "worker-a" }, "user-1");
    remoteServerId = remote.id;
    await storage.projectRemotes.add({
      project_id: "project-1", remote_server_id: remoteServerId, remote_path: "/srv/mine",
    });
    await storage.remoteSessionMappings.upsert(
      REMOTE_SESSION, "project-1", remoteServerId, "worker-side-id", "feature-x",
    );

    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    app.decorate("scheduler", { reschedule, unschedule: () => {}, nextRunAt: () => null, isRunning: () => false } as unknown as SchedulerService);
    app.decorate("eventBus", { emit: (e: GlobalEvent) => emitted.push(e) } as never);
    app.decorate("retentionHolds", new RetentionHoldSync({
      storage,
      remoteSessionMap: new Map(),
      sources: [scheduleHoldSource(storage)],
      proxy: async (_server, method, apiPath, payload) => {
        if (method === "GET") return { ok: true, status: 200, data: { sessionIds: heldOnWorker } };
        pushed.push({ path: apiPath, body: payload });
        return workerAnswer();
      },
    }));
    await app.register(scheduleRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the schedule and records its provenance", async () => {
    const res = await create(body());
    expect(res.statusCode, res.body).toBe(201);
    const schedule = res.json().schedule;
    expect(schedule).toMatchObject({
      run_type: "prompt",
      prompt_provider: "codex",
      branch: "feature-x",
      target: "local",
      source_session_id: "sess-1",
      source_tool_use_id: "toolu_1",
    });
    expect(reschedule).toHaveBeenCalledWith(schedule.id);
  });

  it("is idempotent: a replayed confirmation returns the first schedule with 200", async () => {
    const first = await create(body());
    const replay = await create(body({ name: "Edited on the second click" }));

    expect(replay.statusCode).toBe(200);
    expect(replay.json().schedule.id).toBe(first.json().schedule.id);
    expect(replay.json().schedule.name).toBe("Watch flakiness");
    expect((await storage.scheduledTasks.getByProjectId("project-1")).length).toBe(1);
  });

  it("surfaces the created schedule in the project list, so a reloaded card can recover its state", async () => {
    await create(body());
    const list = await app.inject({ method: "GET", url: "/api/projects/project-1/schedules" });
    expect(list.json().schedules[0]).toMatchObject({ source_session_id: "sess-1", source_tool_use_id: "toolu_1" });
  });

  it("announces the creation, so schedule lists it didn't come from refresh themselves", async () => {
    // The card creates the schedule from the agent window, which doesn't own
    // the sidebar's list — without this event that list stays stale until a
    // page reload. A replay changed nothing, so it announces nothing.
    const first = await create(body());
    expect(emitted).toEqual([{
      type: "schedule:changed",
      projectId: "project-1",
      scheduleId: first.json().schedule.id,
      change: "created",
    }]);

    await create(body());
    expect(emitted).toHaveLength(1);
  });

  it("rejects a source naming a session from another project", async () => {
    // Otherwise one project could squat the idempotency key another project's
    // confirmation needs — and be handed back a foreign row.
    const res = await create(body(), "project-2");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid source");
  });

  it("accepts a remote session, which lives in the mappings table rather than agent_sessions", async () => {
    const res = await create(body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r" } }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().schedule.source_session_id).toBe(REMOTE_SESSION);
  });

  it("rejects a remote session mapped to another project", async () => {
    const res = await create(
      body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r" } }), "project-2",
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects a source that names no session at all, and lets the real one through afterwards", async () => {
    const squat = { session_id: "remote-invented-session", tool_use_id: "toolu_r" };
    const rejected = await create(body({ source: squat }), "project-2");
    expect(rejected.statusCode).toBe(400);

    // The rejected attempt must not have occupied the global key.
    const real = await create(body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r" } }));
    expect(real.statusCode, real.body).toBe(201);
  });

  it("rejects a malformed source", async () => {
    for (const source of [
      { session_id: "sess-1" },
      { session_id: "sess-1", tool_use_id: "" },
      { session_id: "", tool_use_id: "toolu_1" },
      { session_id: "sess-1", tool_use_id: "x".repeat(201) },
      { session_id: 5, tool_use_id: "toolu_1" },
    ]) {
      const res = await create(body({ source }));
      expect(res.statusCode, JSON.stringify(source)).toBe(400);
    }
  });

  it("still creates ordinary schedules with no source at all", async () => {
    const res = await create(body({ source: undefined }));
    expect(res.statusCode).toBe(201);
    expect(res.json().schedule.source_tool_use_id).toBeNull();
  });

  it("keeps rejecting an invalid cron even when it comes from a proposal", async () => {
    const res = await create(body({ cron_expr: "not a cron" }));
    expect(res.statusCode).toBe(400);
  });

  describe("retention hold on the source session", () => {
    const remoteBody = (toolUseId = "toolu_r") => body({ source: { session_id: REMOTE_SESSION, tool_use_id: toolUseId } });
    const del = (id: string) => app.inject({ method: "DELETE", url: `/api/schedules/${id}` });

    it("holds a local source session for as long as a schedule points at it", async () => {
      const a = (await create(body())).json().schedule;
      const b = (await create(body({ source: { session_id: "sess-1", tool_use_id: "toolu_2" } }))).json().schedule;
      expect((await storage.sessionRetentionHolds.list("sess-1")).map((h) => h.id).sort())
        .toEqual([a.id, b.id].sort());

      expect((await del(a.id)).statusCode).toBe(204);
      expect(await storage.sessionRetentionHolds.list("sess-1")).toEqual([{ kind: "schedule", id: b.id }]);
      expect((await del(b.id)).statusCode).toBe(204);
      expect(await storage.sessionRetentionHolds.list("sess-1")).toEqual([]);
    });

    it("pushes a remote source session's whole hold set to its worker", async () => {
      const res = await create(remoteBody());
      expect(res.statusCode).toBe(201);
      expect(pushed).toEqual([{
        path: "/api/path/retention-holds/worker-side-id",
        body: { holds: [{ kind: "schedule", id: res.json().schedule.id }] },
      }]);
    });

    it("does not create the schedule when the worker can't be reached, and allows a retry", async () => {
      workerAnswer = () => ({ ok: false, status: 0, data: { error: "Remote server is not connected" } });
      const failed = await create(remoteBody());
      expect(failed.statusCode).toBe(502);
      expect(await storage.scheduledTasks.getBySource("project-1", REMOTE_SESSION, "toolu_r")).toBeUndefined();
      expect(reschedule).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);

      workerAnswer = () => ({ ok: true, status: 200, data: {} });
      const retried = await create(remoteBody());
      expect(retried.statusCode).toBe(201);
      expect(pushed.at(-1)?.body).toMatchObject({ holds: [{ kind: "schedule", id: retried.json().schedule.id }] });
    });

    it("never deletes an existing schedule when a replayed confirmation fails to sync", async () => {
      const first = (await create(remoteBody())).json().schedule;
      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      const replay = await create(remoteBody());
      expect(replay.statusCode).toBe(502);
      expect(await storage.scheduledTasks.getById(first.id)).toBeDefined();
    });

    it("never answers a concurrent replay with a row the first confirmation rolls back", async () => {
      // First push fails; everything after it succeeds.
      let calls = 0;
      workerAnswer = () => (++calls === 1
        ? { ok: false, status: 0, data: {} }
        : { ok: true, status: 200, data: {} });
      const [a, b] = await Promise.all([create(remoteBody()), create(remoteBody())]);
      expect(a.statusCode).toBe(502);
      expect([200, 201]).toContain(b.statusCode);
      expect(await storage.scheduledTasks.getById(b.json().schedule.id)).toBeDefined();
      expect(pushed.at(-1)?.body).toMatchObject({ holds: [{ kind: "schedule", id: b.json().schedule.id }] });
    });

    it("deletes the schedule even when the hold can't be released", async () => {
      const created = (await create(remoteBody())).json().schedule;
      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      const res = await del(created.id);
      expect(res.statusCode).toBe(204);
      expect(await storage.scheduledTasks.getById(created.id)).toBeUndefined();
    });

    it("releases a hold that outlived its schedule once the worker reconnects", async () => {
      const kept = (await create(remoteBody("toolu_keep"))).json().schedule;
      const gone = (await create(remoteBody("toolu_gone"))).json().schedule;
      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      await del(gone.id);
      workerAnswer = () => ({ ok: true, status: 200, data: {} });
      heldOnWorker = ["worker-side-id", "orphan-on-worker"];
      pushed = [];
      expect(await app.retentionHolds.releaseStale(remoteServerId)).toBe(0);
      expect(pushed).toEqual([
        { path: "/api/path/retention-holds/worker-side-id", body: { holds: [{ kind: "schedule", id: kept.id }] } },
        // Unknown to the hub, so nothing can be holding it.
        { path: "/api/path/retention-holds/orphan-on-worker", body: { holds: [] } },
      ]);
    });

    it("links the source to its workspace's current branch, not the stale snapshot", async () => {
      const registered = await storage.workspaceRegistry.registerReadyCheckout({
        projectId: "project-1", branch: "feature-renamed", targetId: remoteServerId,
        worktreePath: "/srv/mine-renamed", expectedBranch: "feature-renamed",
      });
      await storage.remoteSessionMappings.upsertBound({
        localSessionId: REMOTE_SESSION, projectId: "project-1", remoteServerId,
        remoteSessionId: "worker-side-id", branch: "feature-renamed", checkoutId: registered.checkout.id,
      });
      // A later unbound upsert rewrites the snapshot column but keeps the checkout.
      await storage.remoteSessionMappings.upsert(
        REMOTE_SESSION, "project-1", remoteServerId, "worker-side-id", "feature-x",
      );
      await create(remoteBody());
      const res = await app.inject({ method: "GET", url: "/api/projects/project-1/schedules" });
      expect(res.json().schedules[0].source_session).toMatchObject({ branch: "feature-renamed", exists: true });
    });

    it("lists each schedule's source session, including one that is gone", async () => {
      await create(body());
      await create(remoteBody());
      await storage.agentSessions.delete("sess-1");
      const res = await app.inject({ method: "GET", url: "/api/projects/project-1/schedules" });
      const bySource = Object.fromEntries(
        res.json().schedules.map((s: { source_session_id: string; source_session: unknown }) => [s.source_session_id, s.source_session]),
      );
      expect(bySource["sess-1"]).toEqual({ id: "sess-1", exists: false, branch: null, title: null });
      expect(bySource[REMOTE_SESSION]).toMatchObject({ id: REMOTE_SESSION, exists: true, branch: "feature-x" });
    });
  });
});
