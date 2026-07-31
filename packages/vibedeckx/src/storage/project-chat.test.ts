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
    await storage.projectChatMessages.append({ id: "m2", thread_id: "t1", sequence: 2, type: "assistant", content: "Working on it" });
    await storage.projectChatMessages.append({ id: "m1", thread_id: "t1", sequence: 1, type: "user", content: "status?" });

    expect((await storage.projectChatMessages.listByThread("t1")).map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("atomically upserts context reference touches and keeps one row for duplicate touches", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });

    await Promise.all([
      storage.projectChatContextRefs.touch("t1", "agent_session", "s1"),
      storage.projectChatContextRefs.touch("t1", "agent_session", "s1"),
    ]);

    const refs = await storage.projectChatContextRefs.listByThread("t1");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ thread_id: "t1", entity_type: "agent_session", entity_id: "s1" });
  });

  it("cascades thread deletion to messages and context references", async () => {
    await storage.projectChatThreads.create({ id: "t1", project_id: "p1", user_id: "u1", title: null });
    await storage.projectChatMessages.append({ id: "m1", thread_id: "t1", sequence: 1, type: "user", content: "status?" });
    await storage.projectChatContextRefs.touch("t1", "task", "task1");

    await storage.projectChatThreads.delete("t1", "p1", "u1");

    expect(await storage.projectChatMessages.listByThread("t1")).toEqual([]);
    expect(await storage.projectChatContextRefs.listByThread("t1")).toEqual([]);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM project_chat_messages").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM project_chat_context_refs").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
