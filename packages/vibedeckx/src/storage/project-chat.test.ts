import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("project chat storage", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-chat-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "p1", name: "one", path: "/tmp/one" });
    await storage.projects.create({ id: "p2", name: "two", path: "/tmp/two" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("isolates malformed operation rows while advancing the reconciliation cursor", async () => {
    await storage.projectChatThreads.create({ id: "thread", project_id: "p1", user_id: "local", title: null });
    const raw = new Database(dbPath);
    raw.prepare(`INSERT INTO project_chat_operations
      (id, thread_id, project_id, user_id, kind, payload_version, status, entity_type, entity_id,
       idempotency_key, payload, error)
      VALUES (?, ?, ?, ?, ?, 1, 'pending', NULL, NULL, ?, ?, NULL)`)
      .run("a-malformed", "thread", "p1", "local", "schedule_run", "bad-key",
        JSON.stringify({ version: 1, kind: "schedule_run" }));
    raw.close();
    await storage.projectChatOperations.create({
      id: "b-valid", thread_id: "thread", project_id: "p1", user_id: "local",
      kind: "schedule_run", status: "pending", entity_type: "schedule_run", entity_id: "run",
      idempotency_key: "valid-key", payload: {
        version: 1, kind: "schedule_run", operationId: "b-valid", status: "pending",
        scheduleId: "schedule", runId: "run",
      }, error: null,
    });

    await expect(storage.projectChatOperations.listNonterminal(null, 50)).resolves.toMatchObject({
      operations: [expect.objectContaining({ id: "b-valid" })],
      nextCursor: "b-valid", hasMore: false, malformed: 1,
    });
    expect(await storage.projectChatOperations.getById("a-malformed", "thread", "p1", "local"))
      .toMatchObject({ status: "failed", error: "Malformed operation data was quarantined" });
    const quarantineMessage = (await storage.projectChatMessages.listByThread("thread", "p1", "local"))
      .find(({ id }) => id === "operation:a-malformed:failed");
    expect(quarantineMessage).toMatchObject({ type: "operation" });
    expect(JSON.parse(quarantineMessage!.content)).toEqual({
      version: 1, kind: "schedule_run", operationId: "a-malformed", status: "failed",
      scheduleId: "a-malformed", runId: "a-malformed", runAvailable: false,
      failure: { code: "failed", message: "Operation failed. Review the target and try again." },
    });
    await expect(storage.projectChatOperations.listNonterminal(null, 50))
      .resolves.toMatchObject({ malformed: 0 });
  });

  it("increments retry attempts atomically and clears consecutive failures", async () => {
    await storage.projectChatThreads.create({ id: "retry-thread", project_id: "p1", user_id: "local", title: null });
    await storage.projectChatOperations.create({ id: "retry-op", thread_id: "retry-thread", project_id: "p1", user_id: "local",
      kind: "task_create", status: "pending", entity_type: "task", entity_id: "task",
      idempotency_key: "retry", payload: { version: 1, kind: "task_create", operationId: "retry-op",
        status: "pending", taskId: "task", title: "Task" }, error: null });
    const attempts = await Promise.all(Array.from({ length: 5 }, () =>
      storage.projectChatOperations.recordRetry("retry-op", "retry-thread", "p1", "local", 100)));
    expect(attempts.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    await storage.projectChatOperations.clearRetry("retry-op", "retry-thread", "p1", "local");
    await expect(storage.projectChatOperations.recordRetry("retry-op", "retry-thread", "p1", "local", 100))
      .resolves.toBe(1);
  });

  it("stores multiple project-scoped threads without a branch property", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatThreads.create({ id: "t2", project_id: "p1", user_id: "u1", title: "Second" });
    await storage.projectChatThreads.create({ id: "t3", project_id: "p2", user_id: "u1", title: null });
    await storage.projectChatThreads.create({ id: "t4", project_id: "p1", user_id: "u2", title: null });

    const threads = await storage.projectChatThreads.listByProject("p1", "u1", 10);
    expect(threads.map((thread) => thread.id)).toEqual(["t2", "t1"]);
    expect(threads.every((thread) => !("branch" in thread))).toBe(true);
  });

  it("pages and searches threads with a stable project/user-scoped cursor", async () => {
    for (const [id, projectId, userId, title] of [
      ["a", "p1", "u1", "Old release audit"],
      ["b", "p1", "u1", "Current work"],
      ["c", "p1", "u1", "Current work two"],
      ["foreign-project", "p2", "u1", "Old release audit secret"],
      ["foreign-user", "p1", "u2", "Old release audit secret"],
    ] as const) {
      await storage.projectChatThreads.create({ id, project_id: projectId, user_id: userId, title });
    }
    const raw = new Database(dbPath);
    raw.prepare("UPDATE project_chat_threads SET updated_at = ? WHERE id = ?").run("2026-01-01 00:00:00.000", "a");
    raw.prepare("UPDATE project_chat_threads SET updated_at = ? WHERE id IN (?, ?)")
      .run("2026-02-01 00:00:00.000", "b", "c");
    raw.close();

    const first = await storage.projectChatThreads.listPageByProject("p1", "u1", 2);
    expect(first.threads.map(({ id }) => id)).toEqual(["c", "b"]);
    expect(first.hasMore).toBe(true);

    const second = await storage.projectChatThreads.listPageByProject("p1", "u1", 2, {
      cursor: { updatedAt: first.threads[1].updated_at, id: first.threads[1].id },
    });
    expect(second).toMatchObject({ hasMore: false });
    expect(second.threads.map(({ id }) => id)).toEqual(["a"]);

    const search = await storage.projectChatThreads.listPageByProject("p1", "u1", 2, {
      query: "RELEASE AUDIT",
    });
    expect(search.threads.map(({ id }) => id)).toEqual(["a"]);
  });

  it("resolves authorized Context targets with typed navigation metadata", async () => {
    await storage.tasks.create({ id: "task-1", project_id: "p1", title: "Fix login" });
    await storage.agentSessions.create({ id: "local-session", project_id: "p1", branch: "feature/auth" });
    const remote = await storage.remoteServers.create({ name: "worker" });
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: remote.id, remote_path: "/repo" });
    await storage.remoteSessionMappings.upsert("remote-session", "p1", remote.id, "worker-session", "remote/dev");
    await storage.searchCache.applyCatalogSnapshot("p1", "local", {
      workspaces: [{ branch: null }, { branch: "feature/auth" }], sessions: [],
    });
    await storage.scheduledTasks.create({
      id: "schedule-1", project_id: "p1", name: "Nightly tests", cron_expr: "0 0 * * *",
      timezone: "UTC", run_type: "command", content: "pnpm test", cwd_mode: "branch",
    });
    await storage.scheduledTaskRuns.create({ id: "run-1", schedule_id: "schedule-1" });
    await storage.tasks.create({ id: "foreign-task", project_id: "p2", title: "Secret" });

    const workspaceId = JSON.stringify(["local", "feature/auth"]);
    const refs = [
      { entity_type: "task" as const, entity_id: "task-1" },
      { entity_type: "workspace" as const, entity_id: workspaceId },
      { entity_type: "agent_session" as const, entity_id: "local-session" },
      { entity_type: "agent_session" as const, entity_id: "remote-session" },
      { entity_type: "schedule" as const, entity_id: "schedule-1" },
      { entity_type: "schedule_run" as const, entity_id: "run-1" },
      { entity_type: "task" as const, entity_id: "foreign-task" },
    ];

    await expect(storage.projectChatContextRefs.resolveExisting("p1", refs)).resolves.toEqual(
      expect.arrayContaining([
        { entity_type: "task", entity_id: "task-1", navigation: { kind: "task", taskId: "task-1", label: "Fix login" } },
        { entity_type: "workspace", entity_id: workspaceId, navigation: { kind: "workspace", target: "local", branch: "feature/auth", label: "feature/auth" } },
        { entity_type: "agent_session", entity_id: "local-session", navigation: { kind: "agent_session", sessionId: "local-session", target: "local", branch: "feature/auth", label: "feature/auth" } },
        { entity_type: "agent_session", entity_id: "remote-session", navigation: { kind: "agent_session", sessionId: "remote-session", target: remote.id, branch: "remote/dev", label: "remote/dev" } },
        { entity_type: "schedule", entity_id: "schedule-1", navigation: { kind: "schedule", scheduleId: "schedule-1", label: "Nightly tests" } },
        { entity_type: "schedule_run", entity_id: "run-1", navigation: { kind: "schedule_run", scheduleId: "schedule-1", runId: "run-1", label: "Nightly tests" } },
      ]),
    );
    const resolved = await storage.projectChatContextRefs.resolveExisting("p1", refs);
    expect(resolved).not.toContainEqual(expect.objectContaining({ entity_id: "foreign-task" }));
  });

  it("atomically creates a thread, its initial user message, and accepted work item", async () => {
    const thread = await storage.projectChatThreads.createWithInitialTurn({
      id: "new-thread",
      project_id: "p1",
      user_id: "u1",
      title: null,
      initialTurn: {
        messageId: "initial-message",
        workItemId: "initial-work",
        content: "start here",
      },
    });

    expect(thread.id).toBe("new-thread");
    expect(await storage.projectChatMessages.listByThread("new-thread", "p1", "u1"))
      .toEqual([expect.objectContaining({
        id: "initial-message", sequence: 1, type: "user", content: "start here",
      })]);
    expect(await storage.projectChatWorkItems.listNonterminal("new-thread", "p1", "u1"))
      .toEqual([expect.objectContaining({
        id: "initial-work", user_message_id: "initial-message", content: "start here", status: "accepted",
      })]);
  });

  it("deduplicates concurrent create requests durably and rejects payload reuse", async () => {
    const input = {
      project_id: "p1", user_id: "u1", title: null,
      create_request_id: "request-1", create_payload_hash: "hash:start here",
      initialTurn: { messageId: "m1", workItemId: "w1", content: "start here" },
    };
    const [first, second] = await Promise.all([
      storage.projectChatThreads.createIdempotent({ ...input, id: "thread-a" }),
      storage.projectChatThreads.createIdempotent({
        ...input, id: "thread-b",
        initialTurn: { messageId: "m2", workItemId: "w2", content: "start here" },
      }),
    ]);

    expect(first.thread.id).toBe(second.thread.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(await storage.projectChatMessages.listByThread(first.thread.id, "p1", "u1"))
      .toHaveLength(1);
    expect(await storage.projectChatWorkItems.listNonterminal(first.thread.id, "p1", "u1"))
      .toHaveLength(1);
    await expect(storage.projectChatThreads.createIdempotent({
      ...input, id: "thread-c", create_payload_hash: "hash:different",
      initialTurn: { messageId: "m3", workItemId: "w3", content: "different" },
    })).rejects.toMatchObject({ code: "PROJECT_CHAT_CREATE_CONFLICT" });

    await storage.close();
    storage = await createSqliteStorage(dbPath);
    await expect(storage.projectChatThreads.createIdempotent({
      ...input, id: "thread-after-restart",
      initialTurn: { messageId: "m4", workItemId: "w4", content: "start here" },
    })).resolves.toMatchObject({ thread: { id: first.thread.id }, created: false });
  });

  it("creates only the thread when no initial turn is supplied", async () => {
    await storage.projectChatThreads.createWithInitialTurn({
      id: "empty-thread", project_id: "p1", user_id: "u1", title: null,
    });

    expect(await storage.projectChatMessages.listByThread("empty-thread", "p1", "u1")).toEqual([]);
    expect(await storage.projectChatWorkItems.listNonterminal("empty-thread", "p1", "u1")).toEqual([]);
  });

  it("pages recoverable work by a stable status-first cursor and exposes ownership validity", async () => {
    for (const id of ["recover-a", "recover-b", "recover-c"]) {
      await storage.projectChatThreads.createWithInitialTurn({
        id, project_id: "p1", user_id: "local", title: null,
        initialTurn: { messageId: `${id}-message`, workItemId: `${id}-work`, content: id },
      });
    }
    const first = await storage.projectChatWorkItems.listRecoveryPage(null, 2);
    const second = await storage.projectChatWorkItems.listRecoveryPage(first.nextCursor, 2);
    expect([...first.candidates, ...second.candidates].map(({ thread }) => thread.id))
      .toEqual(["recover-a", "recover-b", "recover-c"]);
    expect(first).toMatchObject({ hasMore: true });
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(first.candidates.every(({ authorized }) => authorized)).toBe(true);

    const raw = new Database(dbPath);
    raw.prepare("UPDATE project_chat_threads SET user_id = 'foreign' WHERE id = 'recover-c'").run();
    raw.close();
    const invalid = await storage.projectChatWorkItems.listRecoveryPage(null, 10);
    expect(invalid.candidates.find(({ thread }) => thread.id === "recover-c")?.authorized).toBe(false);
  });

  it("uses the status-first recovery index without a temp distinct or sort", () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const index = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_project_chat_work_items_recovery'",
      ).get() as { sql: string } | undefined;
      expect(index?.sql.replace(/\s+/g, " ")).toContain("status, created_at, id, thread_id");
      const plan = db.prepare(`EXPLAIN QUERY PLAN
        SELECT thread.*, work.id
        FROM project_chat_work_items AS work
        JOIN project_chat_threads AS thread ON thread.id = work.thread_id
        LEFT JOIN projects AS project ON project.id = thread.project_id
        WHERE work.status IN ('accepted', 'running')
        ORDER BY work.status ASC, work.created_at ASC, work.id ASC LIMIT 26`
      ).all() as Array<{ detail: string }>;
      expect(plan.some(({ detail }) => /USE TEMP B-TREE|DISTINCT/i.test(detail))).toBe(false);
      expect(plan.some(({ detail }) => detail.includes("idx_project_chat_work_items_recovery"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rolls back thread creation when the initial turn insert violates a constraint", async () => {
    await storage.projectChatThreads.create({ id: "existing", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatMessages.append({
      id: "duplicate-message", thread_id: "existing", project_id: "p1", user_id: "u1",
      sequence: 1, type: "user", content: "existing",
    });

    await expect(storage.projectChatThreads.createWithInitialTurn({
      id: "rolled-back",
      project_id: "p1",
      user_id: "u1",
      title: null,
      initialTurn: {
        messageId: "duplicate-message", workItemId: "initial-work", content: "must fail",
      },
    })).rejects.toThrow();

    expect(await storage.projectChatThreads.getById("rolled-back", "p1", "u1")).toBeUndefined();
    expect(await storage.projectChatMessages.listByThread("rolled-back", "p1", "u1")).toEqual([]);
    expect(await storage.projectChatWorkItems.listNonterminal("rolled-back", "p1", "u1")).toEqual([]);
  });

  it("orders threads deterministically by updated_at DESC then id DESC", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatThreads.create({ id: "t2", project_id: "p1", user_id: "u1", title: null });

    expect((await storage.projectChatThreads.listByProject("p1", "u1", 10)).map((thread) => thread.id))
      .toEqual(["t2", "t1"]);

    await storage.projectChatThreads.touchUpdatedAt("t1", "p1", "u1");
    expect((await storage.projectChatThreads.listByProject("p1", "u1", 10)).map((thread) => thread.id))
      .toEqual(["t1", "t2"]);
  });

  it("looks threads up within a user scope and updates titles", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });

    expect(await storage.projectChatThreads.getById("t1", "p1", "u2")).toBeUndefined();
    expect((await storage.projectChatThreads.getById("t1", "p1", "u1"))?.id).toBe("t1");

    const updated = await storage.projectChatThreads.updateTitle("t1", "p1", "u1", "Project status");
    expect(updated?.title).toBe("Project status");
    expect(await storage.projectChatThreads.updateTitle("t1", "p1", "u2", "Not allowed")).toBeUndefined();
  });

  it("updates title and archive state together within the full thread scope", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });

    const updated = await storage.projectChatThreads.update("t1", "p1", "u1", {
      title: "Project status",
      archived: true,
    });

    expect(updated).toMatchObject({ title: "Project status" });
    expect(updated?.archived_at).not.toBeNull();
    expect(await storage.projectChatThreads.update("t1", "p2", "u1", { archived: false })).toBeUndefined();
  });

  it("discovers an owned thread by id without exposing another user's row", async () => {
    await storage.projectChatThreads.create({ id: "mine", project_id: "p2", user_id: "u1", title: null });
    await storage.projectChatThreads.create({ id: "theirs", project_id: "p1", user_id: "u2", title: null });

    expect(await storage.projectChatThreads.getOwnedById("mine", "u1"))
      .toMatchObject({ id: "mine", project_id: "p2", user_id: "u1" });
    expect(await storage.projectChatThreads.getOwnedById("theirs", "u1")).toBeUndefined();
    expect(await storage.projectChatThreads.getOwnedById("missing", "u1")).toBeUndefined();
  });

  it("does not read or mutate a same-user thread through a different project scope", async () => {
    const original = await storage.projectChatThreads.create({
      id: "t2", project_id: "p2", user_id: "u1", title: "Private to p2",
    });

    // This cast models the legacy API that had no project scope. It must stop
    // granting access once project_id becomes part of every thread identity.
    const legacyGetById = storage.projectChatThreads.getById as unknown as
      (id: string, userId: string) => ReturnType<typeof storage.projectChatThreads.getById>;
    expect(await legacyGetById("t2", "u1")).toBeUndefined();

    expect(await storage.projectChatThreads.getById("t2", "p1", "u1")).toBeUndefined();
    expect(await storage.projectChatThreads.updateTitle("t2", "p1", "u1", "Leaked title")).toBeUndefined();
    expect(await storage.projectChatThreads.archive("t2", "p1", "u1")).toBeUndefined();
    expect(await storage.projectChatThreads.unarchive("t2", "p1", "u1")).toBeUndefined();
    expect(await storage.projectChatThreads.touchUpdatedAt("t2", "p1", "u1")).toBeUndefined();
    await storage.projectChatThreads.delete("t2", "p1", "u1");

    const untouched = await storage.projectChatThreads.getById("t2", "p2", "u1");
    expect(untouched).toEqual(original);
  });

  it("archives and unarchives threads while keeping archived rows out of the default list", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });

    expect((await storage.projectChatThreads.archive("t1", "p1", "u1"))?.archived_at).not.toBeNull();
    expect(await storage.projectChatThreads.listByProject("p1", "u1", 10)).toEqual([]);
    expect(await storage.projectChatThreads.listByProject("p1", "u1", 10, { includeArchived: true })).toHaveLength(1);

    expect((await storage.projectChatThreads.unarchive("t1", "p1", "u1"))?.archived_at).toBeNull();
    expect(await storage.projectChatThreads.listByProject("p1", "u1", 10)).toHaveLength(1);
  });

  it("touches updated_at explicitly", async () => {
    const thread = await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatThreads.touchUpdatedAt("t1", "p1", "u1");

    expect((await storage.projectChatThreads.getById("t1", "p1", "u1"))?.updated_at).not.toBe(thread.updated_at);
  });

  it("orders messages by sequence ASC", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatMessages.append({ id: "m2", thread_id: "t1", project_id: "p1", user_id: "u1", sequence: 2, type: "assistant", content: "Working on it" });
    await storage.projectChatMessages.append({ id: "m1", thread_id: "t1", project_id: "p1", user_id: "u1", sequence: 1, type: "user", content: "status?" });

    expect((await storage.projectChatMessages.listByThread("t1", "p1", "u1")).map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("does not append or list messages through a different project scope for the same user", async () => {
    await storage.projectChatThreads.create({ id: "t2", project_id: "p2", user_id: "u1", title: null });

    expect(await storage.projectChatMessages.append({
      id: "m1",
      thread_id: "t2",
      project_id: "p1",
      user_id: "u1",
      sequence: 1,
      type: "user",
      content: "must not cross projects",
    })).toBeUndefined();
    expect(await storage.projectChatMessages.listByThread("t2", "p1", "u1")).toEqual([]);
    expect(await storage.projectChatMessages.listByThread("t2", "p2", "u1")).toEqual([]);
  });

  it("atomically upserts context reference touches and keeps one row for duplicate touches", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });

    await Promise.all([
      storage.projectChatContextRefs.touch("t1", "p1", "u1", "agent_session", "s1"),
      storage.projectChatContextRefs.touch("t1", "p1", "u1", "agent_session", "s1"),
    ]);

    const refs = await storage.projectChatContextRefs.listByThread("t1", "p1", "u1");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ thread_id: "t1", entity_type: "agent_session", entity_id: "s1" });
  });

  it("touches context references as one scoped all-or-nothing batch", async () => {
    await storage.projectChatThreads.create({ id: "batch-thread", project_id: "p1", user_id: "u1", title: null });

    await expect(storage.projectChatContextRefs.touchMany(
      "batch-thread", "p1", "u1", [
        { entityType: "task", entityId: "task-1" },
        { entityType: "invalid" as never, entityId: "must-roll-back" },
      ],
    )).rejects.toThrow();
    expect(await storage.projectChatContextRefs.listByThread("batch-thread", "p1", "u1")).toEqual([]);

    await expect(storage.projectChatContextRefs.touchMany(
      "batch-thread", "p1", "u1", [
        { entityType: "task", entityId: "task-1" },
        { entityType: "agent_session", entityId: "session-1" },
      ],
    )).resolves.toHaveLength(2);
    await expect(storage.projectChatContextRefs.touchMany(
      "batch-thread", "p2", "u1", [{ entityType: "task", entityId: "foreign" }],
    )).resolves.toBeUndefined();
    expect((await storage.projectChatContextRefs.listByThread("batch-thread", "p1", "u1")).map((ref) => ref.entity_id).sort())
      .toEqual(["session-1", "task-1"]);
  });

  it("touchMany does not read thousands of unrelated historical references", async () => {
    await storage.projectChatThreads.create({ id: "large-thread", project_id: "p1", user_id: "u1", title: null });
    const raw = new Database(dbPath);
    try {
      const insert = raw.prepare(`
        INSERT INTO project_chat_context_refs (thread_id, entity_type, entity_id)
        VALUES ('large-thread', 'task', ?)
      `);
      raw.transaction(() => {
        for (let i = 0; i < 3_000; i++) insert.run(`historical-${i}`);
      })();
    } finally {
      raw.close();
    }

    const prepare = vi.spyOn(Database.prototype, "prepare");
    try {
      const touched = await storage.projectChatContextRefs.touchMany(
        "large-thread", "p1", "u1", [
          { entityType: "task", entityId: "requested-task" },
          { entityType: "agent_session", entityId: "requested-session" },
        ],
      );
      expect(touched?.map((ref) => ref.entity_id).sort())
        .toEqual(["requested-session", "requested-task"]);

      const issuedSql = prepare.mock.calls.map(([statement]) => String(statement)).join("\n");
      expect(issuedSql).not.toMatch(
        /select \* from "project_chat_context_refs" where "thread_id" = \?/i,
      );
    } finally {
      prepare.mockRestore();
    }
  });

  it("does not touch or list context references through a different project scope for the same user", async () => {
    await storage.projectChatThreads.create({ id: "t2", project_id: "p2", user_id: "u1", title: null });

    expect(await storage.projectChatContextRefs.touch("t2", "p1", "u1", "task", "task1")).toBeUndefined();
    expect(await storage.projectChatContextRefs.listByThread("t2", "p1", "u1")).toEqual([]);
    expect(await storage.projectChatContextRefs.listByThread("t2", "p2", "u1")).toEqual([]);
  });

  it("cascades thread deletion to messages and context references", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatMessages.append({ id: "m1", thread_id: "t1", project_id: "p1", user_id: "u1", sequence: 1, type: "user", content: "status?" });
    await storage.projectChatContextRefs.touch("t1", "p1", "u1", "task", "task1");

    await storage.projectChatThreads.delete("t1", "p1", "u1");

    expect(await storage.projectChatMessages.listByThread("t1", "p1", "u1")).toEqual([]);
    expect(await storage.projectChatContextRefs.listByThread("t1", "p1", "u1")).toEqual([]);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM project_chat_messages").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM project_chat_context_refs").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("reopens the same database idempotently with the full thread ordering index", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    const legacyDb = new Database(dbPath);
    try {
      legacyDb.exec(`
        CREATE INDEX idx_project_chat_threads_project_user_updated
          ON project_chat_threads(project_id, user_id, updated_at DESC)
      `);
    } finally {
      legacyDb.close();
    }
    await storage.close();
    storage = await createSqliteStorage(dbPath);

    expect((await storage.projectChatThreads.getById("t1", "p1", "u1"))?.id).toBe("t1");

    const db = new Database(dbPath, { readonly: true });
    try {
      const index = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_project_chat_threads_project_user_updated_id'",
      ).get() as { sql: string } | undefined;
      expect(index?.sql.replace(/\s+/g, " ")).toContain("project_id, user_id, updated_at DESC, id DESC");
      const orderingIndexes = db.prepare(`
        SELECT name FROM pragma_index_list('project_chat_threads')
        WHERE name LIKE 'idx_project_chat_threads_project_user_updated%'
        ORDER BY name
      `).all() as { name: string }[];
      expect(orderingIndexes.map(({ name }) => name)).toEqual([
        "idx_project_chat_threads_project_user_updated_id",
      ]);
    } finally {
      db.close();
    }
  });

  it("uses a covering recency index for bounded Context reads without a temp sort", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    const db = new Database(dbPath, { readonly: true });
    try {
      const index = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_project_chat_context_refs_thread_recency'",
      ).get() as { sql: string } | undefined;
      expect(index?.sql.replace(/\s+/g, " ")).toContain(
        "thread_id, last_referenced_at DESC, entity_type, entity_id",
      );
      const plan = db.prepare(`EXPLAIN QUERY PLAN
        SELECT ref.* FROM project_chat_context_refs AS ref
        JOIN project_chat_threads AS thread ON thread.id = ref.thread_id
        WHERE ref.thread_id = ? AND thread.project_id = ? AND thread.user_id = ?
        ORDER BY ref.last_referenced_at DESC, ref.entity_type ASC, ref.entity_id ASC LIMIT 100`
      ).all("t1", "p1", "u1") as Array<{ detail: string }>;
      expect(plan.some(({ detail }) => /USE TEMP B-TREE FOR ORDER BY/i.test(detail))).toBe(false);
      expect(plan.some(({ detail }) => detail.includes("idx_project_chat_context_refs_thread_recency"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("migrates operation correlations with exact indexes and thread cascade", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });

    const db = new Database(dbPath);
    try {
      db.prepare(`
        INSERT INTO project_chat_operations
          (id, thread_id, project_id, user_id, kind, payload_version, status, entity_type, entity_id, idempotency_key, payload)
        VALUES (?, ?, 'p1', 'u1', ?, 1, ?, ?, ?, ?, ?)
      `).run(
        "op1", "t1", "agent_session_create", "running", "agent_session", "s1", "idem-1",
        JSON.stringify({ version: 1, kind: "agent_session_create", operationId: "op1", status: "running", sessionId: "s1" }),
      );
      const indexes = db.prepare(`
        SELECT name FROM pragma_index_list('project_chat_operations')
        WHERE name LIKE 'idx_project_chat_operations_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(indexes.map(({ name }) => name)).toContain(
        "idx_project_chat_operations_entity_correlation",
      );
      expect(() => db.prepare(`
        INSERT INTO project_chat_operations
          (id, thread_id, project_id, user_id, kind, payload_version, status, entity_type, entity_id, idempotency_key, payload)
        VALUES (?, ?, 'p1', 'u1', 'task_create', 1, 'pending', 'task', ?, ?, ?)
      `).run("oversized", "t1", "task", "oversized", JSON.stringify({
        version: 1, kind: "task_create", operationId: "oversized", status: "pending", taskId: "task", padding: "x".repeat(32_769),
      })))
        .toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }

    await storage.projectChatThreads.delete("t1", "p1", "u1");
    const verify = new Database(dbPath, { readonly: true });
    try {
      expect(verify.prepare("SELECT count(*) AS count FROM project_chat_operations").get())
        .toEqual({ count: 0 });
    } finally {
      verify.close();
    }

    await storage.close();
    storage = await createSqliteStorage(dbPath);
  });

  it("stores immutable operation scope and independently constrained payload versions", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    const db = new Database(dbPath);
    try {
      const columns = db.prepare("PRAGMA table_info(project_chat_operations)").all() as Array<{ name: string; notnull: number }>;
      expect(columns.find(({ name }) => name === "project_id")?.notnull).toBe(1);
      expect(columns.find(({ name }) => name === "user_id")?.notnull).toBe(1);
      expect(columns.find(({ name }) => name === "payload_version")?.notnull).toBe(1);
      const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
        .get("idx_project_chat_operations_entity_correlation") as { sql: string };
      expect(index.sql.replace(/\s+/g, " ")).toContain(
        "project_id, entity_type, entity_id, status, id",
      );
      expect(() => db.prepare(`
        INSERT INTO project_chat_operations
          (id, thread_id, project_id, user_id, kind, payload_version, status,
           entity_type, entity_id, idempotency_key, payload)
        VALUES ('bad-json', 't1', 'p1', 'u1', 'task_create', 1, 'pending',
                'task', 'task-1', 'bad-json', '{}')
      `).run()).toThrow(/constraint|payload/i);
      expect(() => db.prepare(`
        INSERT INTO project_chat_operations
          (id, thread_id, project_id, user_id, kind, payload_version, status,
           entity_type, entity_id, idempotency_key, payload)
        VALUES ('bad-version', 't1', 'p1', 'u1', 'task_create', 2, 'pending',
                'task', 'task-1', 'bad-version', json_object('version',2,'kind','task_create'))
      `).run()).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("backfills immutable scope when reopening a Task 5 intermediate operation journal", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.close();
    const legacy = new Database(dbPath);
    try {
      legacy.pragma("foreign_keys = OFF");
      legacy.exec(`
        DROP TABLE project_chat_operations;
        CREATE TABLE project_chat_operations (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, kind TEXT NOT NULL,
          status TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
          idempotency_key TEXT NOT NULL, payload TEXT NOT NULL, error TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(thread_id, idempotency_key)
        );
      `);
      legacy.prepare(`INSERT INTO project_chat_operations
        (id, thread_id, kind, status, entity_type, entity_id, idempotency_key, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("legacy-op", "t1", "agent_session_create", "running", "agent_session", "s1", "legacy",
          JSON.stringify({ version: 1, kind: "agent_session_create", operationId: "legacy-op", status: "running", sessionId: "s1" }));
    } finally {
      legacy.close();
    }
    storage = await createSqliteStorage(dbPath);
    expect(await storage.projectChatOperations.getById("legacy-op", "t1", "p1", "u1"))
      .toMatchObject({ project_id: "p1", user_id: "u1", payload_version: 1 });
  });

  it("rejects cross-scope and immutable operation updates in sqlite", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    const db = new Database(dbPath);
    try {
      expect(() => db.prepare(`
        INSERT INTO project_chat_operations
          (id, thread_id, project_id, user_id, kind, payload_version, status,
           entity_type, entity_id, idempotency_key, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("cross", "t1", "p2", "u1", "task_create", 1, "pending", "task", "task-1", "cross",
        JSON.stringify({ version: 1, kind: "task_create", operationId: "cross", status: "pending", taskId: "task-1", title: "x" })))
        .toThrow(/scope/i);
      db.prepare(`
        INSERT INTO project_chat_operations
          (id, thread_id, project_id, user_id, kind, payload_version, status,
           entity_type, entity_id, idempotency_key, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("op", "t1", "p1", "u1", "task_create", 1, "pending", "task", "task-1", "op",
        JSON.stringify({ version: 1, kind: "task_create", operationId: "op", status: "pending", taskId: "task-1", title: "x" }));
      expect(() => db.prepare("UPDATE project_chat_operations SET project_id='p2' WHERE id='op'").run())
        .toThrow(/immutable/i);
      expect(() => db.prepare("UPDATE project_chat_operations SET payload_version=2 WHERE id='op'").run())
        .toThrow(/immutable|CHECK/i);
    } finally {
      db.close();
    }
  });

  it("atomically claims a workspace selection without overwriting a concurrent claim", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatOperations.create({
      id: "selection", thread_id: "t1", project_id: "p1", user_id: "u1",
      kind: "agent_session_create", status: "pending", entity_type: null, entity_id: null,
      idempotency_key: "session:seed", error: null,
      payload: { version: 1, kind: "agent_session_create", operationId: "selection", status: "pending", sessionId: "seed", instruction: "do it", candidates: [] },
    });
    const [first, second] = await Promise.all([
      storage.projectChatOperations.claimWorkspaceSelection({
        id: "selection", thread_id: "t1", project_id: "p1", user_id: "u1",
        workspace_id: '["local","one"]', session_id: "session-one", claim_token: "claim-one",
        payload: { version: 1, kind: "agent_session_create", operationId: "selection", status: "resolving", sessionId: "session-one", workspaceId: '["local","one"]', selectedWorkspaceId: '["local","one"]', claimToken: "claim-one" },
        message: { id: "operation:selection:resolving", content: JSON.stringify({
          version: 1, kind: "agent_session_create", operationId: "selection", status: "resolving",
          sessionId: "session-one", workspaceId: '["local","one"]',
        }) },
      }),
      storage.projectChatOperations.claimWorkspaceSelection({
        id: "selection", thread_id: "t1", project_id: "p1", user_id: "u1",
        workspace_id: '["remote","two"]', session_id: "session-two", claim_token: "claim-two",
        payload: { version: 1, kind: "agent_session_create", operationId: "selection", status: "resolving", sessionId: "session-two", workspaceId: '["remote","two"]', selectedWorkspaceId: '["remote","two"]', claimToken: "claim-two" },
        message: { id: "operation:selection:resolving", content: JSON.stringify({
          version: 1, kind: "agent_session_create", operationId: "selection", status: "resolving",
          sessionId: "session-two", workspaceId: '["remote","two"]',
        }) },
      }),
    ]);
    expect([first?.claimed, second?.claimed].filter(Boolean)).toHaveLength(1);
    expect(first?.operation.payload.selectedWorkspaceId ?? second?.operation.payload.selectedWorkspaceId)
      .toBe(first?.claimed ? '["local","one"]' : '["remote","two"]');
    const persisted = await storage.projectChatOperations.getById("selection", "t1", "p1", "u1");
    expect(persisted?.status).toBe("resolving");
    expect(persisted?.entity_type).toBe("agent_session");
    const messages = await storage.projectChatMessages.listByThread("t1", "p1", "u1");
    expect(messages.filter(({ id }) => id === "operation:selection:resolving")).toHaveLength(1);
  });

  it("authorizes, bounds, and monotonically updates operation correlations", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatThreads.create({ id: "t2", project_id: "p1", user_id: "u2", title: null });

    const created = await storage.projectChatOperations.create({
      id: "op1", thread_id: "t1", project_id: "p1", user_id: "u1",
      kind: "agent_session_create", status: "running", entity_type: "agent_session",
      entity_id: "s1", idempotency_key: "idem-1",
      payload: { version: 1, kind: "agent_session_create", operationId: "op1", status: "running", sessionId: "s1" },
      error: null,
    });
    expect(created).toMatchObject({ id: "op1", thread_id: "t1", status: "running" });
    expect(await storage.projectChatOperations.create({
      id: "foreign", thread_id: "t1", project_id: "p2", user_id: "u1",
      kind: "agent_session_create", status: "running", entity_type: "agent_session",
      entity_id: "s1", idempotency_key: "foreign",
      payload: { version: 1, kind: "agent_session_create", operationId: "foreign", status: "running", sessionId: "s1" }, error: null,
    })).toBeUndefined();
    expect(await storage.projectChatOperations.getById("op1", "t1", "p1", "u2"))
      .toBeUndefined();

    expect((await storage.projectChatOperations.listByCorrelation(
      "p1", "agent_session", "s1", 1,
    )).map(({ id }) => id)).toEqual(["op1"]);

    const terminal = await storage.projectChatOperations.transition({
      id: "op1", thread_id: "t1", project_id: "p1", user_id: "u1",
      status: "completed", payload: {
        version: 1, kind: "agent_session_create", operationId: "op1", sessionId: "s1", status: "completed",
      }, error: null,
      message: { id: "operation:op1:completed", content: JSON.stringify({
        version: 1, kind: "agent_session_create", operationId: "op1", status: "completed",
      }) },
    });
    expect(terminal?.changed).toBe(true);
    const duplicate = await storage.projectChatOperations.transition({
      id: "op1", thread_id: "t1", project_id: "p1", user_id: "u1",
      status: "completed", payload: terminal!.operation.payload, error: null,
      message: { id: "operation:op1:completed", content: terminal!.message.content },
    });
    expect(duplicate?.changed).toBe(false);
    expect(await storage.projectChatOperations.transition({
      id: "op1", thread_id: "t1", project_id: "p1", user_id: "u1",
      status: "running", payload: terminal!.operation.payload, error: null,
      message: { id: "operation:op1:running-late", content: "{}" },
    })).toBeUndefined();
    expect((await storage.projectChatMessages.listByThread("t1", "p1", "u1"))
      .filter(({ type }) => type === "operation")).toHaveLength(1);
  });

  it("persists monotonic same-status confirmation without duplicating its public message", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatOperations.create({
      id: "run-confirm", thread_id: "t1", project_id: "p1", user_id: "u1",
      kind: "schedule_run", status: "pending", entity_type: "schedule_run", entity_id: "run1",
      idempotency_key: "run1", error: null,
      payload: { version: 1, kind: "schedule_run", operationId: "run-confirm", status: "pending",
        scheduleId: "schedule1", runId: "run1", contextConfirmed: false },
    });
    const running = await storage.projectChatOperations.transition({
      id: "run-confirm", thread_id: "t1", project_id: "p1", user_id: "u1", status: "running",
      payload: { version: 1, kind: "schedule_run", operationId: "run-confirm", status: "running",
        scheduleId: "schedule1", runId: "run1", contextConfirmed: false }, error: null,
      message: { id: "operation:run-confirm:running", content: JSON.stringify({ status: "running" }) },
    });
    expect(running?.changed).toBe(true);

    const [first, stale] = await Promise.all([
      storage.projectChatOperations.transition({
        id: "run-confirm", thread_id: "t1", project_id: "p1", user_id: "u1", status: "running",
        payload: { ...running!.operation.payload, contextConfirmed: true, skipped: false }, error: null,
        message: { id: "operation:run-confirm:running", content: running!.message.content },
      }),
      storage.projectChatOperations.transition({
        id: "run-confirm", thread_id: "t1", project_id: "p1", user_id: "u1", status: "running",
        payload: { ...running!.operation.payload, contextConfirmed: true, skipped: true }, error: null,
        message: { id: "operation:run-confirm:running", content: running!.message.content },
      }),
    ]);

    expect([first, stale].filter(Boolean)).toHaveLength(1);
    expect([first, stale].filter(Boolean)[0]?.changed).toBe(false);
    const persisted = await storage.projectChatOperations.getById("run-confirm", "t1", "p1", "u1");
    expect(persisted?.payload).toMatchObject({ contextConfirmed: true, skipped: expect.any(Boolean) });
    const duplicate = await storage.projectChatOperations.transition({
      id: "run-confirm", thread_id: "t1", project_id: "p1", user_id: "u1", status: "running",
      payload: persisted!.payload, error: null,
      message: { id: "operation:run-confirm:running", content: running!.message.content },
    });
    expect(duplicate?.changed).toBe(false);
    const publicUpdate = await storage.projectChatOperations.transition({
      id: "run-confirm", thread_id: "t1", project_id: "p1", user_id: "u1", status: "running",
      payload: persisted!.payload, error: null,
      message: { id: "operation:run-confirm:running", content: JSON.stringify({ status: "running", skipped: true }) },
    });
    expect(publicUpdate).toMatchObject({ changed: true, message: { content: JSON.stringify({ status: "running", skipped: true }) } });
    expect((await storage.projectChatMessages.listByThread("t1", "p1", "u1"))
      .filter(({ type }) => type === "operation")).toHaveLength(1);
  });

  it("accepts public operation messages while rejecting invalid SQL-boundary types", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await expect(storage.projectChatMessages.append({
      id: "public-operation", thread_id: "t1", project_id: "p1", user_id: "u1",
      sequence: 1, type: "operation", content: JSON.stringify({ status: "running" }),
    })).resolves.toMatchObject({ type: "operation" });
    const db = new Database(dbPath);
    try {
      expect(() => db.prepare(
        "INSERT INTO project_chat_messages (id, thread_id, sequence, type, content) VALUES (?, ?, ?, ?, ?)",
      ).run("bad-message", "t1", 1, "invalid", "bad")).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(
        "INSERT INTO project_chat_context_refs (thread_id, entity_type, entity_id) VALUES (?, ?, ?)",
      ).run("t1", "invalid", "bad")).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("rejects orphan child writes and cascades project deletion through all project-chat rows", async () => {
    expect(await storage.projectChatMessages.append({
      id: "orphan-message", thread_id: "missing", project_id: "p1", user_id: "u1",
      sequence: 1, type: "user", content: "orphan",
    })).toBeUndefined();
    expect(await storage.projectChatContextRefs.touch("missing", "p1", "u1", "task", "orphan-task")).toBeUndefined();

    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatMessages.append({
      id: "m1", thread_id: "t1", project_id: "p1", user_id: "u1",
      sequence: 1, type: "user", content: "status?",
    });
    await storage.projectChatContextRefs.touch("t1", "p1", "u1", "task", "task1");

    await storage.projects.delete("p1");

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM project_chat_threads").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM project_chat_messages").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM project_chat_context_refs").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("stores internal work items with constrained status, recovery index, and thread cascade", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatWorkItems.accept({
      id: "w1", user_message_id: "m1", thread_id: "t1",
      project_id: "p1", user_id: "u1", content: "status?",
    });

    const db = new Database(dbPath);
    try {
      expect(() => db.prepare(
        "UPDATE project_chat_work_items SET status = 'invalid' WHERE id = 'w1'",
      ).run()).toThrow(/CHECK constraint failed/);
      const index = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_project_chat_work_items_thread_status_created_id'",
      ).get() as { sql: string } | undefined;
      expect(index?.sql.replace(/\s+/g, " "))
        .toContain("thread_id, status, created_at, id");
      expect(db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_project_chat_work_items_recovery'",
      ).get()).toBeDefined();
    } finally {
      db.close();
    }

    await storage.projectChatThreads.delete("t1", "p1", "u1");
    const verify = new Database(dbPath, { readonly: true });
    try {
      expect(verify.prepare("SELECT count(*) AS count FROM project_chat_work_items").get())
        .toEqual({ count: 0 });
    } finally {
      verify.close();
    }
  });

  it("atomically accepts work with an in-transaction message sequence", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });

    const [first, second] = await Promise.all([
      storage.projectChatWorkItems.accept({
        id: "z-work", user_message_id: "m1", thread_id: "t1",
        project_id: "p1", user_id: "u1", content: "first",
      }),
      storage.projectChatWorkItems.accept({
        id: "a-work", user_message_id: "m2", thread_id: "t1",
        project_id: "p1", user_id: "u1", content: "second",
      }),
    ]);

    expect([first.userMessage.sequence, second.userMessage.sequence].sort()).toEqual([1, 2]);
    expect((await storage.projectChatMessages.listByThread("t1", "p1", "u1"))
      .map(({ type, content }) => ({ type, content })))
      .toEqual([
        { type: "user", content: "first" },
        { type: "user", content: "second" },
      ]);
    expect((await storage.projectChatWorkItems.listNonterminal("t1", "p1", "u1"))
      .map((work) => work.id)).toEqual(["z-work", "a-work"]);
  });

  it("rolls back both journal and user message when acceptance touch fails", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TRIGGER fail_project_chat_touch BEFORE UPDATE OF updated_at ON project_chat_threads
        BEGIN SELECT RAISE(ABORT, 'touch failed'); END
      `);
    } finally {
      db.close();
    }

    await expect(storage.projectChatWorkItems.accept({
      id: "w1", user_message_id: "m1", thread_id: "t1",
      project_id: "p1", user_id: "u1", content: "must roll back",
    })).rejects.toThrow(/touch failed/);

    expect(await storage.projectChatMessages.listByThread("t1", "p1", "u1")).toEqual([]);
    expect(await storage.projectChatWorkItems.listNonterminal("t1", "p1", "u1")).toEqual([]);
  });

  it("atomically appends terminal turn_end and completes its work item", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatWorkItems.accept({
      id: "w1", user_message_id: "m1", thread_id: "t1",
      project_id: "p1", user_id: "u1", content: "status?",
    });
    const running = await storage.projectChatWorkItems.markRunning("w1", "t1", "p1", "u1");

    const terminal = await storage.projectChatWorkItems.finish({
      id: "w1", thread_id: "t1", project_id: "p1", user_id: "u1",
      attempt: running!.attempt,
      status: "completed", error: null, turn_end_id: "end1",
      turn_end_content: JSON.stringify({ status: "completed", workId: "w1" }),
    });

    expect(terminal.workItem.status).toBe("completed");
    expect(terminal.turnEnd).toMatchObject({ id: "end1", sequence: 2, type: "turn_end" });
    expect(await storage.projectChatWorkItems.listNonterminal("t1", "p1", "u1")).toEqual([]);
  });

  it("fences work-scoped event and terminal writes after work returns to accepted", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatWorkItems.accept({
      id: "w1", user_message_id: "m1", thread_id: "t1",
      project_id: "p1", user_id: "u1", content: "status?",
    });
    const running = await storage.projectChatWorkItems.markRunning("w1", "t1", "p1", "u1");
    await expect(storage.projectChatWorkItems.appendEvent({
      id: "w1", thread_id: "t1", project_id: "p1", user_id: "u1",
      attempt: running!.attempt,
      message_id: "assistant-1", type: "assistant", content: "partial",
    })).resolves.toMatchObject({ id: "assistant-1", sequence: 2 });

    await storage.projectChatWorkItems.markAccepted("w1", "t1", "p1", "u1", running!.attempt);

    await expect(storage.projectChatWorkItems.appendEvent({
      id: "w1", thread_id: "t1", project_id: "p1", user_id: "u1",
      attempt: running!.attempt,
      message_id: "assistant-late", type: "assistant", content: "late",
    })).resolves.toBeUndefined();
    await expect(storage.projectChatWorkItems.finish({
      id: "w1", thread_id: "t1", project_id: "p1", user_id: "u1",
      attempt: running!.attempt,
      status: "completed", error: null, turn_end_id: "end-late", turn_end_content: "{}",
    })).rejects.toThrow(/not found or already terminal/);
    expect((await storage.projectChatMessages.listByThread("t1", "p1", "u1"))
      .map((message) => message.id)).toEqual(["m1", "assistant-1"]);
  });

  it("fences stale writes after detached work is claimed by a new attempt", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatWorkItems.accept({
      id: "w1", user_message_id: "m1", thread_id: "t1",
      project_id: "p1", user_id: "u1", content: "status?",
    });
    const first = await storage.projectChatWorkItems.markRunning("w1", "t1", "p1", "u1");
    expect(first?.attempt).toBe(1);
    await storage.projectChatWorkItems.markAccepted("w1", "t1", "p1", "u1", first!.attempt);
    const second = await storage.projectChatWorkItems.markRunning("w1", "t1", "p1", "u1");
    expect(second?.attempt).toBe(2);

    await expect(storage.projectChatWorkItems.appendEvent({
      id: "w1", thread_id: "t1", project_id: "p1", user_id: "u1",
      attempt: first!.attempt, message_id: "assistant-stale", type: "assistant", content: "stale",
    })).resolves.toBeUndefined();
    await expect(storage.projectChatWorkItems.finish({
      id: "w1", thread_id: "t1", project_id: "p1", user_id: "u1",
      attempt: first!.attempt, status: "completed", error: null,
      turn_end_id: "end-stale", turn_end_content: "{}",
    })).rejects.toThrow(/not found or already terminal/);
    await expect(storage.projectChatWorkItems.appendEvent({
      id: "w1", thread_id: "t1", project_id: "p1", user_id: "u1",
      attempt: second!.attempt, message_id: "assistant-current", type: "assistant", content: "current",
    })).resolves.toMatchObject({ id: "assistant-current" });
  });

  it("pages older messages by stable sequence with a UTF-8 byte budget and tenant scope", async () => {
    await storage.projectChatThreads.create({ id: "paged", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatThreads.create({ id: "foreign", project_id: "p1", user_id: "u2", title: null });
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      await storage.projectChatMessages.append({
        id: `m${sequence}`, thread_id: "paged", project_id: "p1", user_id: "u1",
        sequence, type: "user", content: sequence === 3 ? "你🙂" : `message-${sequence}`,
      });
    }

    const newest = await storage.projectChatMessages.listPageBefore(
      "paged", "p1", "u1", { beforeSequence: null, limit: 3, maxUtf8Bytes: 100 },
    );
    expect(newest.messages.map(({ sequence }) => sequence)).toEqual([4, 5, 6]);
    expect(newest).toMatchObject({ hasMore: true, nextCursor: 4, newestSequence: 6 });

    const older = await storage.projectChatMessages.listPageBefore(
      "paged", "p1", "u1", { beforeSequence: newest.nextCursor, limit: 3, maxUtf8Bytes: 8 },
    );
    expect(older.messages.map(({ sequence }) => sequence)).toEqual([3]);
    expect(Buffer.byteLength(older.messages[0].content, "utf8")).toBe(7);
    expect(older).toMatchObject({ hasMore: true, nextCursor: 3, newestSequence: 6 });

    await expect(storage.projectChatMessages.listPageBefore(
      "paged", "p1", "u2", { beforeSequence: null, limit: 3, maxUtf8Bytes: 100 },
    )).resolves.toBeUndefined();
  });

  it("rejects oversized structured messages and advances past a legacy oversized row", async () => {
    await storage.projectChatThreads.create({
      id: "structured-limit", project_id: "p1", user_id: "u1", title: null,
    });
    const oversized = JSON.stringify({ input: "界🙂".repeat(80_000) });
    for (const type of ["tool_use", "tool_approval_request"] as const) {
      await expect(storage.projectChatMessages.append({
        id: `oversized-${type}`, thread_id: "structured-limit", project_id: "p1", user_id: "u1",
        sequence: 1, type, content: oversized,
      })).rejects.toThrow(/UTF-8 byte limit/i);
    }
    await storage.projectChatMessages.append({
      id: "older", thread_id: "structured-limit", project_id: "p1", user_id: "u1",
      sequence: 1, type: "assistant", content: "older safe message",
    });
    const raw = new Database(dbPath);
    raw.prepare(`INSERT INTO project_chat_messages (id, thread_id, sequence, type, content)
      VALUES (?, ?, ?, ?, ?)`).run("legacy-oversized", "structured-limit", 2, "tool_use", oversized);
    raw.close();

    const first = await storage.projectChatMessages.listPageBefore(
      "structured-limit", "p1", "u1", { beforeSequence: null, limit: 10, maxUtf8Bytes: 1024 },
    );
    expect(first).toMatchObject({ messages: [], hasMore: true, nextCursor: 2 });
    const second = await storage.projectChatMessages.listPageBefore(
      "structured-limit", "p1", "u1", { beforeSequence: first!.nextCursor, limit: 10, maxUtf8Bytes: 1024 },
    );
    expect(second).toMatchObject({
      messages: [expect.objectContaining({ id: "older" })], hasMore: false, nextCursor: null,
    });
  });
});
