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

/** Confirming an agent's propose_schedule card (see docs/schedule-proposal-tool-design.md §3.2). */
describe("schedule create from an agent proposal", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  const reschedule = vi.fn(async () => {});

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
    app.decorate("scheduler", { reschedule, nextRunAt: () => null, isRunning: () => false } as unknown as SchedulerService);
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
});
