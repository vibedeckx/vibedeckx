import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("stores multiple project-scoped threads without a branch property", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatThreads.create({ id: "t2", project_id: "p1", user_id: "u1", title: "Second" });
    await storage.projectChatThreads.create({ id: "t3", project_id: "p2", user_id: "u1", title: null });
    await storage.projectChatThreads.create({ id: "t4", project_id: "p1", user_id: "u2", title: null });

    const threads = await storage.projectChatThreads.listByProject("p1", "u1", 10);
    expect(threads.map((thread) => thread.id)).toEqual(["t2", "t1"]);
    expect(threads.every((thread) => !("branch" in thread))).toBe(true);
  });

  it("rolls back thread creation when the initial message insert violates a constraint", async () => {
    await storage.projectChatThreads.create({ id: "existing", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatMessages.append({
      id: "duplicate-message", thread_id: "existing", project_id: "p1", user_id: "u1",
      sequence: 1, type: "user", content: "existing",
    });

    await expect(storage.projectChatThreads.createWithInitialMessage({
      id: "rolled-back",
      project_id: "p1",
      user_id: "u1",
      title: null,
      initialMessage: { id: "duplicate-message", content: "must fail" },
    })).rejects.toThrow();

    expect(await storage.projectChatThreads.getById("rolled-back", "p1", "u1")).toBeUndefined();
    expect(await storage.projectChatMessages.listByThread("rolled-back", "p1", "u1")).toEqual([]);
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
});
