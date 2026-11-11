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

import taskRoutes from "./task-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import { EventBus, type GlobalEvent } from "../event-bus.js";
import { RetentionHoldSync, scheduleHoldSource, subscribeTaskHoldSync, taskHoldSource } from "../retention-holds.js";
import type { ProxyResult } from "../utils/remote-proxy.js";

/** Confirming an agent's propose_task card: provenance, idempotency, retention holds. */
describe("task create from an agent proposal", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let emitted: GlobalEvent[];
  let pushed: Array<{ path: string; body: unknown }>;
  let workerAnswer: () => ProxyResult | Promise<ProxyResult>;
  let unsubscribe: () => void;

  const REMOTE_SESSION = "remote-srv-1-project-1-abc";

  const body = (over: Record<string, unknown> = {}) => ({
    title: "Cover remote path",
    description: "Add the remote retention test",
    priority: "high",
    source: { session_id: "sess-1", tool_use_id: "toolu_1", item_index: 0 },
    ...over,
  });

  const create = (payload: unknown, projectId = "project-1") =>
    app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks`, payload: payload as object });
  const put = (id: string, payload: object) => app.inject({ method: "PUT", url: `/api/tasks/${id}`, payload });

  /** The hold sync triggered by task:updated is fire-and-forget; let it settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(async () => {
    auth.currentUserId = "user-1";
    emitted = [];
    pushed = [];
    workerAnswer = () => ({ ok: true, status: 200, data: {} });
    dir = mkdtempSync(path.join(tmpdir(), "vdx-task-proposal-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "Mine", path: "/tmp/mine" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Other", path: "/tmp/other" }, "user-1");
    await storage.agentSessions.create({ id: "sess-1", project_id: "project-1", branch: "feature-x" });
    const remote = await storage.remoteServers.create({ name: "worker-a" }, "user-1");
    await storage.projectRemotes.add({
      project_id: "project-1", remote_server_id: remote.id, remote_path: "/srv/mine",
    });
    await storage.remoteSessionMappings.upsert(
      REMOTE_SESSION, "project-1", remote.id, "worker-side-id", "feature-x",
    );

    const eventBus = new EventBus();
    eventBus.subscribe((e) => emitted.push(e));
    const holds = new RetentionHoldSync({
      storage,
      remoteSessionMap: new Map(),
      sources: [scheduleHoldSource(storage), taskHoldSource(storage)],
      proxy: async (_server, method, apiPath, payload) => {
        if (method === "GET") return { ok: true, status: 200, data: { sessionIds: [] } };
        pushed.push({ path: apiPath, body: payload });
        return workerAnswer();
      },
    });
    unsubscribe = subscribeTaskHoldSync(eventBus, holds);

    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    app.decorate("eventBus", eventBus);
    app.decorate("retentionHolds", holds);
    await app.register(taskRoutes);
    await app.ready();
  });

  afterEach(async () => {
    unsubscribe();
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the task with its provenance and announces it", async () => {
    const res = await create(body());
    expect(res.statusCode, res.body).toBe(201);
    const task = res.json().task;
    expect(task).toMatchObject({
      title: "Cover remote path",
      priority: "high",
      status: "todo",
      source_session_id: "sess-1",
      source_tool_use_id: "toolu_1",
      source_item_index: 0,
    });
    expect(emitted.filter((e) => e.type === "task:created")).toHaveLength(1);
  });

  it("never pre-assigns a branch, so turn-end auto-complete can't close it", async () => {
    // §4.1: completeIfAssigned runs at the end of every turn. A follow-up
    // assigned to its source session's branch would be marked done by that
    // session's next turn.
    const res = await create(body({ assigned_branch: "feature-x" }));
    expect(res.json().task.assigned_branch).toBeNull();
    expect(await storage.tasks.completeIfAssigned("project-1", "feature-x")).toBeUndefined();
    expect((await storage.tasks.getById(res.json().task.id))?.status).toBe("todo");
  });

  it("is idempotent per proposal item: a replay returns the first task with 200", async () => {
    const first = await create(body());
    const replay = await create(body({ title: "Edited on the second click" }));
    expect(replay.statusCode).toBe(200);
    expect(replay.json().task.id).toBe(first.json().task.id);
    expect(replay.json().task.title).toBe("Cover remote path");
    expect(emitted.filter((e) => e.type === "task:created")).toHaveLength(1);

    // Another item of the same proposal is its own task.
    const second = await create(body({ source: { session_id: "sess-1", tool_use_id: "toolu_1", item_index: 1 } }));
    expect(second.statusCode).toBe(201);
    expect((await storage.tasks.getByProjectId("project-1")).length).toBe(2);
  });

  it("resolves concurrent confirmations of one item to a single task", async () => {
    const [a, b] = await Promise.all([create(body()), create(body())]);
    expect(a.json().task.id).toBe(b.json().task.id);
    expect((await storage.tasks.getByProjectId("project-1")).length).toBe(1);
  });

  it("rejects a source from another project, a made-up session, or a malformed key", async () => {
    expect((await create(body(), "project-2")).statusCode).toBe(400);
    expect((await create(body({ source: { session_id: "remote-invented", tool_use_id: "t", item_index: 0 } }))).statusCode).toBe(400);
    for (const source of [
      { session_id: "sess-1", tool_use_id: "toolu_1" },
      { session_id: "sess-1", tool_use_id: "toolu_1", item_index: -1 },
      { session_id: "sess-1", tool_use_id: "toolu_1", item_index: 1.5 },
      { session_id: "sess-1", tool_use_id: "toolu_1", item_index: "0" },
      { session_id: "sess-1", tool_use_id: "", item_index: 0 },
    ]) {
      expect((await create(body({ source }))).statusCode, JSON.stringify(source)).toBe(400);
    }
  });

  it("lists tasks with their source session, so a card can recover its state", async () => {
    await create(body());
    const res = await app.inject({ method: "GET", url: "/api/projects/project-1/tasks" });
    expect(res.json().tasks[0]).toMatchObject({
      source_tool_use_id: "toolu_1",
      source_item_index: 0,
      source_session: { id: "sess-1", exists: true, branch: "feature-x" },
    });
  });

  it("still creates ordinary tasks without a source", async () => {
    const res = await create({ title: "Plain", description: "x", assigned_branch: "feature-x" });
    expect(res.statusCode).toBe(201);
    expect(res.json().task).toMatchObject({ source_tool_use_id: null, assigned_branch: "feature-x" });
  });

  describe("batch create (Create all)", () => {
    const batch = (tasks: unknown, projectId = "project-1") =>
      app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/batch`, payload: { tasks } as object });
    const item = (index: number, over: Record<string, unknown> = {}) =>
      body({ title: `Item ${index}`, source: { session_id: "sess-1", tool_use_id: "toolu_1", item_index: index }, ...over });

    it("files every item in list order, holds the session for all, and announces each", async () => {
      const res = await batch([item(0), item(1), item(2)]);
      expect(res.statusCode, res.body).toBe(201);
      const tasks = res.json().tasks as Array<{ id: string; title: string; source_item_index: number }>;
      expect(tasks.map((t) => t.source_item_index)).toEqual([0, 1, 2]);
      const listed = await storage.tasks.getByProjectId("project-1");
      expect(listed.map((t) => t.title)).toEqual(["Item 0", "Item 1", "Item 2"]);
      expect(emitted.filter((e) => e.type === "task:created")).toHaveLength(3);
      expect((await storage.sessionRetentionHolds.list("sess-1")).map((h) => h.id).sort())
        .toEqual(tasks.map((t) => t.id).sort());
    });

    it("returns already-confirmed items as they are and only announces the new ones", async () => {
      const first = (await create(item(0))).json().task;
      emitted = [];
      const res = await batch([item(0, { title: "Edited later" }), item(1)]);
      expect(res.statusCode).toBe(201);
      expect(res.json().tasks[0]).toMatchObject({ id: first.id, title: "Item 0" });
      expect(emitted.filter((e) => e.type === "task:created")).toHaveLength(1);

      const replay = await batch([item(0), item(1)]);
      expect(replay.statusCode).toBe(200);
      expect((await storage.tasks.getByProjectId("project-1")).length).toBe(2);
    });

    it("rejects the whole batch when any item is invalid, creating nothing", async () => {
      const res = await batch([item(0), item(1, { description: "" })]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("Task 2");
      expect(await storage.tasks.getByProjectId("project-1")).toEqual([]);
    });

    it("rejects an empty list, an oversized one, and items from different sessions", async () => {
      expect((await batch([])).statusCode).toBe(400);
      expect((await batch(Array.from({ length: 21 }, (_, i) => item(i)))).statusCode).toBe(400);
      const mixed = await batch([
        item(0),
        item(1, { source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: 1 } }),
      ]);
      expect(mixed.statusCode).toBe(400);
      expect(await storage.tasks.getByProjectId("project-1")).toEqual([]);
    });

    it("rolls back earlier inserts when a later one in the transaction fails", async () => {
      await storage.tasks.create({ id: "taken", project_id: "project-1", title: "Existing", description: "x" });
      await expect(storage.tasks.createMany([
        { id: "new-1", project_id: "project-1", title: "A", description: "x" },
        { id: "taken", project_id: "project-1", title: "B", description: "x" },
      ])).rejects.toThrow();
      expect((await storage.tasks.getByProjectId("project-1")).map((t) => t.id)).toEqual(["taken"]);
    });

    it("keeps an already-confirmed task when a failed hold push rolls back the new ones", async () => {
      const remote = (i: number) => item(i, { source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: i } });
      const existing = (await create(remote(0))).json().task;
      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      expect((await batch([remote(0), remote(1)])).statusCode).toBe(502);
      expect((await storage.tasks.getByProjectId("project-1")).map((t) => t.id)).toEqual([existing.id]);
    });

    it("creates none of them when the remote session's hold can't be pushed", async () => {
      const remote = (i: number) => item(i, { source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: i } });
      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      expect((await batch([remote(0), remote(1)])).statusCode).toBe(502);
      expect(await storage.tasks.getByProjectId("project-1")).toEqual([]);
      expect(emitted.filter((e) => e.type === "task:created")).toHaveLength(0);
    });
  });

  describe("batch update (Apply all)", () => {
    const batchUpdate = (updates: unknown, projectId = "project-1") =>
      app.inject({ method: "PUT", url: `/api/projects/${projectId}/tasks/batch`, payload: { updates } as object });
    const plain = async (id: string, title = id) => {
      await storage.tasks.create({ id, project_id: "project-1", title, description: "x" });
    };

    it("applies every patch in one go and announces each task", async () => {
      await plain("a");
      await plain("b");
      const res = await batchUpdate([
        { id: "a", status: "done", title: "A done" },
        { id: "b", priority: "urgent", parent_id: "a" },
      ]);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().tasks.map((t: { id: string }) => t.id)).toEqual(["a", "b"]);
      expect(await storage.tasks.getById("a")).toMatchObject({ status: "done", title: "A done" });
      expect(await storage.tasks.getById("b")).toMatchObject({ priority: "urgent", parent_id: "a" });
      expect(emitted.filter((e) => e.type === "task:updated")).toHaveLength(2);
    });

    it("rejects the whole batch when any patch is invalid, changing nothing", async () => {
      await plain("a");
      await plain("b");
      for (const bad of [
        [{ id: "a", status: "done" }, { id: "b", status: "bogus" }],
        [{ id: "a", status: "done" }, { id: "missing" }],
        [{ id: "a", status: "done" }, { id: "a", title: "twice" }],
        [{ id: "a", status: "done" }, { id: "b", title: "  " }],
        [{ id: "a", status: "done" }, { id: "b", parent_id: "missing" }],
        [],
        Array.from({ length: 21 }, () => ({ id: "a" })),
      ]) {
        expect((await batchUpdate(bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect(await storage.tasks.getById("a")).toMatchObject({ status: "todo" });
      expect(emitted.filter((e) => e.type === "task:updated")).toHaveLength(0);
    });

    it("refuses tasks from another project", async () => {
      await storage.tasks.create({ id: "elsewhere", project_id: "project-2", title: "E", description: "x" });
      expect((await batchUpdate([{ id: "elsewhere", status: "done" }])).statusCode).toBe(400);
      expect((await batchUpdate([{ id: "elsewhere", status: "done" }], "project-2")).statusCode).toBe(200);
      auth.currentUserId = "user-2";
      expect((await batchUpdate([{ id: "elsewhere", status: "todo" }], "project-2")).statusCode).toBe(404);
    });

    it("refuses moves that only form a cycle together", async () => {
      await plain("a");
      await plain("b");
      const res = await batchUpdate([{ id: "a", parent_id: "b" }, { id: "b", parent_id: "a" }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("nested under itself");
      // Swapping the order of a valid move inside the batch is fine.
      await plain("c");
      await storage.tasks.update("b", { parent_id: "a" });
      const swap = await batchUpdate([{ id: "b", parent_id: null }, { id: "a", parent_id: "b" }]);
      expect(swap.statusCode, swap.body).toBe(200);
    });

    it("rolls back every patch when one fails inside the transaction", async () => {
      await plain("a");
      await expect(storage.tasks.updateMany([
        { id: "a", opts: { title: "changed" } },
        { id: "missing", opts: { title: "x" } },
      ])).rejects.toThrow();
      expect((await storage.tasks.getById("a"))?.title).toBe("a");
    });

    it("reverts the whole batch when a reopen's remote hold can't be pushed", async () => {
      const remote = (i: number) => body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: i } });
      const task = (await create(remote(0))).json().task;
      await put(task.id, { status: "done" });
      await settle();
      await plain("local");

      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      const res = await batchUpdate([{ id: "local", title: "Renamed" }, { id: task.id, status: "todo" }]);
      expect(res.statusCode).toBe(502);
      expect((await storage.tasks.getById("local"))?.title).toBe("local");
      expect((await storage.tasks.getById(task.id))?.status).toBe("done");

      workerAnswer = () => ({ ok: true, status: 200, data: {} });
      expect((await batchUpdate([{ id: "local", title: "Renamed" }, { id: task.id, status: "todo" }])).statusCode).toBe(200);
      expect(pushed.at(-1)?.body).toEqual({ holds: [{ kind: "task", id: task.id }] });
    });

    /** A reopened remote task + a plain task, batched while the hold push hangs and then fails. */
    const hangingReopen = async () => {
      const remote = body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: 0 } });
      const task = (await create(remote)).json().task;
      await put(task.id, { status: "done" });
      await settle();
      await plain("local");
      await plain("other");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      workerAnswer = () => gate.then(() => ({ ok: false, status: 0, data: {} }));
      const res = batchUpdate([
        { id: "local", title: "Batch title", priority: "high" },
        { id: "other", title: "Batch other" },
        { id: task.id, status: "todo" },
      ]);
      await settle();
      return { task, res, release };
    };

    it("keeps an edit that landed on a batch member while the failed hold sync was pending", async () => {
      const { task, res, release } = await hangingReopen();
      expect((await put("local", { title: "Edited in another tab" })).statusCode).toBe(200);
      release();
      expect((await res).statusCode).toBe(502);
      // The newer title stays; the batch's untouched-since priority is undone.
      expect(await storage.tasks.getById("local")).toMatchObject({ title: "Edited in another tab", priority: "medium" });
      expect((await storage.tasks.getById("other"))?.title).toBe("other");
      expect((await storage.tasks.getById(task.id))?.status).toBe("done");
    });

    /** A starts under B; the batch moves A to the top level while reopening a remote task. */
    const hangingMoveToRoot = async () => {
      const remote = body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: 0 } });
      const task = (await create(remote)).json().task;
      await put(task.id, { status: "done" });
      await settle();
      await plain("B");
      await storage.tasks.create({ id: "A", project_id: "project-1", title: "A", description: "x", parent_id: "B" });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      workerAnswer = () => gate.then(() => ({ ok: false, status: 0, data: {} }));
      const res = batchUpdate([{ id: "A", parent_id: null, title: "Batch A" }, { id: task.id, status: "todo" }]);
      await settle();
      return { task, res, release };
    };

    it("doesn't restore a parent that was deleted during the pending hold sync", async () => {
      const { task, res, release } = await hangingMoveToRoot();
      expect((await app.inject({ method: "DELETE", url: "/api/tasks/B" })).statusCode).toBe(200);
      release();
      expect((await res).statusCode).toBe(502);
      expect(await storage.tasks.getById("A")).toMatchObject({ parent_id: null, title: "A" });
      expect((await storage.tasks.getById(task.id))?.status).toBe("done");
    });

    it("doesn't restore a parent that would now form a cycle", async () => {
      const { task, res, release } = await hangingMoveToRoot();
      // Valid at this moment: A is top-level.
      expect((await put("B", { parent_id: "A" })).statusCode).toBe(200);
      release();
      expect((await res).statusCode).toBe(502);
      expect(await storage.tasks.getById("A")).toMatchObject({ parent_id: null, title: "A" });
      expect((await storage.tasks.getById("B"))?.parent_id).toBe("A");
      expect((await storage.tasks.getById(task.id))?.status).toBe("done");
    });

    it("undoes a whole parent reversal when the hold can't be pushed, in either order", async () => {
      const remote = body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: 0 } });
      const task = (await create(remote)).json().task;
      await put(task.id, { status: "done" });
      await settle();
      await plain("B");
      await storage.tasks.create({ id: "A", project_id: "project-1", title: "A", description: "x", parent_id: "B" });
      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      for (const moves of [
        [{ id: "A", parent_id: null }, { id: "B", parent_id: "A" }],
        [{ id: "B", parent_id: "A" }, { id: "A", parent_id: null }],
      ]) {
        const res = await batchUpdate([...moves, { id: task.id, status: "todo" }]);
        expect(res.statusCode, JSON.stringify(moves)).toBe(502);
        expect((await storage.tasks.getById("A"))?.parent_id, JSON.stringify(moves)).toBe("B");
        expect((await storage.tasks.getById("B"))?.parent_id, JSON.stringify(moves)).toBeNull();
        expect((await storage.tasks.getById(task.id))?.status).toBe("done");
      }
    });

    it("still reverts the rest when a batch member was deleted during the pending hold sync", async () => {
      const { task, res, release } = await hangingReopen();
      expect((await app.inject({ method: "DELETE", url: "/api/tasks/local" })).statusCode).toBe(200);
      release();
      expect((await res).statusCode).toBe(502);
      expect(await storage.tasks.getById("local")).toBeUndefined();
      expect((await storage.tasks.getById("other"))?.title).toBe("other");
      expect((await storage.tasks.getById(task.id))?.status).toBe("done");
    });
  });

  describe("retention hold on the source session", () => {
    it("holds the session while the task is open and releases it when done", async () => {
      const task = (await create(body())).json().task;
      expect(await storage.sessionRetentionHolds.list("sess-1")).toEqual([{ kind: "task", id: task.id }]);

      await put(task.id, { status: "in_progress" });
      await settle();
      expect(await storage.sessionRetentionHolds.list("sess-1")).toEqual([{ kind: "task", id: task.id }]);

      await put(task.id, { status: "done" });
      await settle();
      expect(await storage.sessionRetentionHolds.list("sess-1")).toEqual([]);

      // Reopened: held again.
      await put(task.id, { status: "todo" });
      await settle();
      expect(await storage.sessionRetentionHolds.list("sess-1")).toEqual([{ kind: "task", id: task.id }]);
    });

    it("releases on archive and on delete", async () => {
      const a = (await create(body())).json().task;
      const b = (await create(body({ source: { session_id: "sess-1", tool_use_id: "toolu_2", item_index: 0 } }))).json().task;

      await app.inject({ method: "POST", url: `/api/tasks/${a.id}/archive` });
      await settle();
      expect(await storage.sessionRetentionHolds.list("sess-1")).toEqual([{ kind: "task", id: b.id }]);

      await app.inject({ method: "DELETE", url: `/api/tasks/${b.id}` });
      expect(await storage.sessionRetentionHolds.list("sess-1")).toEqual([]);
    });

    it("releases when turn-end auto-complete closes a task the user later assigned", async () => {
      const task = (await create(body())).json().task;
      await put(task.id, { assigned_branch: "feature-x" });
      // What agent-session-manager does at turn end.
      const completed = await storage.tasks.completeIfAssigned("project-1", "feature-x");
      app.eventBus.emit({ type: "task:updated", projectId: "project-1", task: { ...completed! } });
      await settle();
      expect(await storage.sessionRetentionHolds.list("sess-1")).toEqual([]);
    });

    it("refuses to reopen or unarchive a remote task whose hold can't be re-acquired", async () => {
      // Once released, the session has no holds, so releaseStale would never
      // revisit it: a reopen that lost its hold would stay unprotected for good.
      const remoteBody = body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: 0 } });
      const task = (await create(remoteBody)).json().task;
      await put(task.id, { status: "done" });
      await settle();
      expect(pushed.at(-1)?.body).toEqual({ holds: [] });

      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      const reopen = await put(task.id, { status: "todo", title: "Renamed" });
      expect(reopen.statusCode).toBe(502);
      expect(await storage.tasks.getById(task.id)).toMatchObject({ status: "done", title: "Cover remote path" });

      workerAnswer = () => ({ ok: true, status: 200, data: {} });
      await app.inject({ method: "POST", url: `/api/tasks/${task.id}/archive` });
      await settle();
      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      await put(task.id, { status: "todo" }); // archived: acquires nothing, so allowed
      const unarchive = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/unarchive` });
      expect(unarchive.statusCode).toBe(502);
      expect((await storage.tasks.getById(task.id))?.archived_at).not.toBeNull();

      workerAnswer = () => ({ ok: true, status: 200, data: {} });
      expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/unarchive` })).statusCode).toBe(200);
      expect(pushed.at(-1)?.body).toEqual({ holds: [{ kind: "task", id: task.id }] });
    });

    it("never lets a failed reopen roll back an edit that landed while its hold sync was pending", async () => {
      const remoteBody = body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: 0 } });
      const task = (await create(remoteBody)).json().task;
      await put(task.id, { status: "done" });
      await settle();

      // The reopen's hold push hangs, then fails.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      workerAnswer = () => gate.then(() => ({ ok: false, status: 0, data: {} }));
      const reopen = put(task.id, { status: "todo" });
      await settle();
      const edit = put(task.id, { title: "Edited in another tab" });
      await settle();
      release();

      expect((await reopen).statusCode).toBe(502);
      expect((await edit).statusCode).toBe(200);
      expect(await storage.tasks.getById(task.id)).toMatchObject({ status: "done", title: "Edited in another tab" });
    });

    it("pushes a remote session's holds to its worker, and refuses to create when it can't", async () => {
      const remoteBody = body({ source: { session_id: REMOTE_SESSION, tool_use_id: "toolu_r", item_index: 0 } });
      workerAnswer = () => ({ ok: false, status: 0, data: {} });
      expect((await create(remoteBody)).statusCode).toBe(502);
      expect(await storage.tasks.getByProjectId("project-1")).toEqual([]);

      workerAnswer = () => ({ ok: true, status: 200, data: {} });
      const res = await create(remoteBody);
      expect(res.statusCode).toBe(201);
      expect(pushed.at(-1)).toEqual({
        path: "/api/path/retention-holds/worker-side-id",
        body: { holds: [{ kind: "task", id: res.json().task.id }] },
      });
    });
  });
});
