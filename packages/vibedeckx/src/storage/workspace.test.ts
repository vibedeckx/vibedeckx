import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("tasks/rules/commands storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-ws-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "p", path: "/tmp/p" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("tasks", () => {
    it("create: defaults status='todo', priority='medium', description/assigned_branch null, position starts at 0", async () => {
      const t = await storage.tasks.create({ id: "t1", project_id: "p1", title: "T" });
      expect(t.status).toBe("todo");
      expect(t.priority).toBe("medium");
      expect(t.description).toBeNull();
      expect(t.assigned_branch).toBeNull();
      expect(t.position).toBe(0);
      expect(t.archived_at).toBeNull();
    });

    it("create: explicit status/priority/description/assigned_branch overrides", async () => {
      const t = await storage.tasks.create({
        id: "t1", project_id: "p1", title: "T", description: "d",
        status: "in_progress", priority: "urgent", assigned_branch: "dev",
      });
      expect(t.status).toBe("in_progress");
      expect(t.priority).toBe("urgent");
      expect(t.description).toBe("d");
      expect(t.assigned_branch).toBe("dev");
    });

    it("create: position increments per project, independent across projects", async () => {
      const t1 = await storage.tasks.create({ id: "t1", project_id: "p1", title: "A" });
      const t2 = await storage.tasks.create({ id: "t2", project_id: "p1", title: "B" });
      expect(t1.position).toBe(0);
      expect(t2.position).toBe(1);

      await storage.projects.create({ id: "p2", name: "p2", path: "/tmp/p2" });
      const t3 = await storage.tasks.create({ id: "t3", project_id: "p2", title: "C" });
      expect(t3.position).toBe(0);
    });

    it("getByProjectId: excludes archived by default, orders by position asc", async () => {
      await storage.tasks.create({ id: "t1", project_id: "p1", title: "A" });
      await storage.tasks.create({ id: "t2", project_id: "p1", title: "B" });
      const list = await storage.tasks.getByProjectId("p1");
      expect(list.map((t) => t.id)).toEqual(["t1", "t2"]);
    });

    it("getById returns undefined for a missing task", async () => {
      expect(await storage.tasks.getById("nonexistent")).toBeUndefined();
    });

    it("update: field-by-field partial updates, including nulling description/assigned_branch", async () => {
      await storage.tasks.create({
        id: "t1", project_id: "p1", title: "T", description: "d",
        status: "todo", priority: "medium", assigned_branch: "dev",
      });
      const u1 = await storage.tasks.update("t1", { title: "T2" });
      expect(u1?.title).toBe("T2");
      expect(u1?.description).toBe("d"); // untouched

      const u2 = await storage.tasks.update("t1", { description: null });
      expect(u2?.description).toBeNull();

      const u3 = await storage.tasks.update("t1", { status: "in_progress" });
      expect(u3?.status).toBe("in_progress");

      const u4 = await storage.tasks.update("t1", { priority: "urgent" });
      expect(u4?.priority).toBe("urgent");

      const u5 = await storage.tasks.update("t1", { assigned_branch: null });
      expect(u5?.assigned_branch).toBeNull();

      const u6 = await storage.tasks.update("t1", { position: 5 });
      expect(u6?.position).toBe(5);
    });

    it("update: no-op opts ({}) returns the current row unchanged (no UPDATE issued)", async () => {
      const t = await storage.tasks.create({ id: "t1", project_id: "p1", title: "T" });
      const u = await storage.tasks.update("t1", {});
      expect(u).toEqual(t);
    });

    it("update returns undefined for a missing task", async () => {
      expect(await storage.tasks.update("nonexistent", { title: "x" })).toBeUndefined();
    });

    it("archive/unarchive lifecycle and includeArchived filter", async () => {
      await storage.tasks.create({ id: "t1", project_id: "p1", title: "T" });
      const archived = await storage.tasks.archive("t1");
      expect(archived?.archived_at).not.toBeNull();
      expect(await storage.tasks.getByProjectId("p1")).toHaveLength(0);
      expect(await storage.tasks.getByProjectId("p1", { includeArchived: true })).toHaveLength(1);
      const unarchived = await storage.tasks.unarchive("t1");
      expect(unarchived?.archived_at).toBeNull();
      expect(await storage.tasks.getByProjectId("p1")).toHaveLength(1);
    });

    it("delete removes the task", async () => {
      await storage.tasks.create({ id: "t1", project_id: "p1", title: "T" });
      await storage.tasks.delete("t1");
      expect(await storage.tasks.getById("t1")).toBeUndefined();
    });

    it("reorder persists positions in the given order", async () => {
      await storage.tasks.create({ id: "t1", project_id: "p1", title: "A" });
      await storage.tasks.create({ id: "t2", project_id: "p1", title: "B" });
      await storage.tasks.reorder("p1", ["t2", "t1"]);
      const list = await storage.tasks.getByProjectId("p1");
      expect(list.map((t) => t.id)).toEqual(["t2", "t1"]);
      expect(list.map((t) => t.position)).toEqual([0, 1]);
    });

    it("completeIfAssigned: no assigned task for the branch -> undefined", async () => {
      expect(await storage.tasks.completeIfAssigned("p1", "dev")).toBeUndefined();
    });

    it("completeIfAssigned: first-by-position match already done -> undefined no-op, even when a later match isn't done", async () => {
      const t1 = await storage.tasks.create({ id: "t1", project_id: "p1", title: "A", assigned_branch: "dev" });
      await storage.tasks.update(t1.id, { status: "done" });
      await storage.tasks.create({ id: "t2", project_id: "p1", title: "B", assigned_branch: "dev" });

      const result = await storage.tasks.completeIfAssigned("p1", "dev");
      expect(result).toBeUndefined();

      // t2 (later position, not done) must NOT have been skipped-ahead and completed.
      const t2After = await storage.tasks.getById("t2");
      expect(t2After?.status).toBe("todo");
    });

    it("completeIfAssigned: normal completion marks the first assigned, non-done task 'done' and returns the fresh row", async () => {
      const t1 = await storage.tasks.create({ id: "t1", project_id: "p1", title: "A", assigned_branch: "dev" });
      const result = await storage.tasks.completeIfAssigned("p1", "dev");
      expect(result?.id).toBe(t1.id);
      expect(result?.status).toBe("done");
      const fromDb = await storage.tasks.getById(t1.id);
      expect(fromDb?.status).toBe("done");
    });

    it("completeIfAssigned: concurrent with a status update on the same task — the read-guard-write is atomic, not torn by the concurrent write", async () => {
      // Regression test mirroring "settings.update: two concurrent
      // read-modify-writes both land" (projects.test.ts) and
      // "setTargetDisabled: two concurrent toggles... both land"
      // (executors.test.ts). completeIfAssigned's atomicity (types.ts
      // docstring) comes from a JS-side read-then-guard-then-write, not
      // DB-level arbitration — the old inline code ran fully synchronously
      // (raw better-sqlite3 calls, zero internal awaits) so it always
      // completed in one JS turn before any other queued storage call could
      // run. Every Kysely call is a real Promise, so each `await` is a real
      // yield point even on the synchronous better-sqlite3 driver: without
      // wrapping the SELECT+UPDATE in a transaction, a concurrent edit to
      // the same task (e.g. cancellation) landing in that window would be
      // silently overwritten back to "done" (exactly the scenario the
      // docstring warns about). The transaction serializes the two
      // operations under better-sqlite3 (one connection, transactions
      // execute one-at-a-time), so the concurrent update is never visible
      // mid-flight: it lands either fully before or fully after.
      await storage.tasks.create({ id: "t1", project_id: "p1", title: "A", assigned_branch: "dev" });
      await Promise.all([
        storage.tasks.completeIfAssigned("p1", "dev"),
        storage.tasks.update("t1", { status: "cancelled" }),
      ]);
      const final = await storage.tasks.getById("t1");
      // Whichever operation's transaction/statement wins the race for the
      // single better-sqlite3 connection runs to completion first — both
      // orderings are valid, self-consistent outcomes. What must never
      // happen is completeIfAssigned's guard reading a stale "not done"
      // snapshot and then unconditionally re-asserting "done" AFTER the
      // concurrent cancellation has landed.
      expect(final?.status).toBe("cancelled");
    });
  });

  describe("rules", () => {
    it("create: defaults enabled=1 (number, not boolean), position starts at 0", async () => {
      const r = await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "n", content: "c" });
      expect(r.enabled).toBe(1);
      expect(typeof r.enabled).toBe("number");
      expect(r.position).toBe(0);
    });

    it("create: enabled=false stores as 0", async () => {
      const r = await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "n", content: "c", enabled: false });
      expect(r.enabled).toBe(0);
    });

    it("create: position increments per (project_id, branch), independent across branches", async () => {
      const r1 = await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "a", content: "c" });
      const r2 = await storage.rules.create({ id: "r2", project_id: "p1", branch: null, name: "b", content: "c" });
      expect(r1.position).toBe(0);
      expect(r2.position).toBe(1);

      const r3 = await storage.rules.create({ id: "r3", project_id: "p1", branch: "dev", name: "c", content: "c" });
      expect(r3.position).toBe(0);
    });

    it("getByWorkspace: null branch means project-level, distinct from a named branch", async () => {
      await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "global", content: "x" });
      await storage.rules.create({ id: "r2", project_id: "p1", branch: "dev", name: "dev-only", content: "y" });
      const projectLevel = await storage.rules.getByWorkspace("p1", null);
      const devLevel = await storage.rules.getByWorkspace("p1", "dev");
      expect(projectLevel.map((r) => r.id)).toEqual(["r1"]);
      expect(devLevel.map((r) => r.id)).toEqual(["r2"]);
    });

    it("getByWorkspace orders by position asc and scopes to the project", async () => {
      await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "a", content: "c" });
      await storage.rules.create({ id: "r2", project_id: "p1", branch: null, name: "b", content: "c" });
      await storage.projects.create({ id: "p2", name: "p2", path: "/tmp/p2" });
      await storage.rules.create({ id: "r3", project_id: "p2", branch: null, name: "other-project", content: "c" });

      const list = await storage.rules.getByWorkspace("p1", null);
      expect(list.map((r) => r.id)).toEqual(["r1", "r2"]);
    });

    it("getById returns undefined for a missing rule", async () => {
      expect(await storage.rules.getById("nonexistent")).toBeUndefined();
    });

    it("update: name/content/enabled/position field-by-field; enabled round-trips as a number", async () => {
      const r = await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "n", content: "c", enabled: false });
      expect(r.enabled).toBe(0);

      const u1 = await storage.rules.update("r1", { enabled: true });
      expect(u1?.enabled).toBe(1);

      const u2 = await storage.rules.update("r1", { name: "n2" });
      expect(u2?.name).toBe("n2");

      const u3 = await storage.rules.update("r1", { content: "c2" });
      expect(u3?.content).toBe("c2");

      const u4 = await storage.rules.update("r1", { position: 3 });
      expect(u4?.position).toBe(3);
    });

    it("update: no-op opts ({}) returns the current row unchanged", async () => {
      const r = await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "n", content: "c" });
      const u = await storage.rules.update("r1", {});
      expect(u).toEqual(r);
    });

    it("delete removes the rule", async () => {
      await storage.rules.create({ id: "r1", project_id: "p1", branch: null, name: "n", content: "c" });
      await storage.rules.delete("r1");
      expect(await storage.rules.getById("r1")).toBeUndefined();
    });

    it("reorder persists positions in the given order (scoped by project_id, independent of the branch argument)", async () => {
      await storage.rules.create({ id: "r1", project_id: "p1", branch: "dev", name: "a", content: "c" });
      await storage.rules.create({ id: "r2", project_id: "p1", branch: "dev", name: "b", content: "c" });
      await storage.rules.reorder("p1", "dev", ["r2", "r1"]);
      const list = await storage.rules.getByWorkspace("p1", "dev");
      expect(list.map((r) => r.id)).toEqual(["r2", "r1"]);
      expect(list.map((r) => r.position)).toEqual([0, 1]);
    });
  });

  describe("commands", () => {
    it("create: position starts at 0, increments per (project_id, branch)", async () => {
      const c1 = await storage.commands.create({ id: "c1", project_id: "p1", branch: null, name: "a", content: "x" });
      const c2 = await storage.commands.create({ id: "c2", project_id: "p1", branch: null, name: "b", content: "y" });
      expect(c1.position).toBe(0);
      expect(c2.position).toBe(1);

      const c3 = await storage.commands.create({ id: "c3", project_id: "p1", branch: "dev", name: "c", content: "z" });
      expect(c3.position).toBe(0);
    });

    it("getByWorkspace: null branch means project-level, distinct from a named branch", async () => {
      await storage.commands.create({ id: "c1", project_id: "p1", branch: null, name: "global", content: "x" });
      await storage.commands.create({ id: "c2", project_id: "p1", branch: "dev", name: "dev-only", content: "y" });
      const projectLevel = await storage.commands.getByWorkspace("p1", null);
      const devLevel = await storage.commands.getByWorkspace("p1", "dev");
      expect(projectLevel.map((c) => c.id)).toEqual(["c1"]);
      expect(devLevel.map((c) => c.id)).toEqual(["c2"]);
    });

    it("getByWorkspace orders by position asc", async () => {
      await storage.commands.create({ id: "c1", project_id: "p1", branch: null, name: "a", content: "x" });
      await storage.commands.create({ id: "c2", project_id: "p1", branch: null, name: "b", content: "y" });
      const list = await storage.commands.getByWorkspace("p1", null);
      expect(list.map((c) => c.id)).toEqual(["c1", "c2"]);
    });

    it("getById returns undefined for a missing command", async () => {
      expect(await storage.commands.getById("nonexistent")).toBeUndefined();
    });

    it("create/getByWorkspace/update/delete round-trip", async () => {
      await storage.commands.create({ id: "c1", project_id: "p1", branch: null, name: "deploy", content: "make deploy" });
      expect((await storage.commands.getByWorkspace("p1", null)).map((c) => c.name)).toEqual(["deploy"]);
      await storage.commands.update("c1", { content: "make deploy2" });
      expect((await storage.commands.getById("c1"))?.content).toBe("make deploy2");
      await storage.commands.delete("c1");
      expect(await storage.commands.getById("c1")).toBeUndefined();
    });

    it("update: name/position field-by-field; no-op opts returns current row unchanged", async () => {
      const c = await storage.commands.create({ id: "c1", project_id: "p1", branch: null, name: "n", content: "x" });
      const u1 = await storage.commands.update("c1", { name: "n2" });
      expect(u1?.name).toBe("n2");
      const u2 = await storage.commands.update("c1", { position: 4 });
      expect(u2?.position).toBe(4);
      const noop = await storage.commands.update("c1", {});
      expect(noop).toEqual(await storage.commands.getById("c1"));
      expect(noop?.id).toBe(c.id);
    });
  });
});
