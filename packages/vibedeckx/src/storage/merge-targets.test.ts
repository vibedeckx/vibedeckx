import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("branch merge targets storage", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-merge-targets-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "p1", name: "one", path: "/tmp/one" });
    await storage.projects.create({ id: "p2", name: "two", path: "/tmp/two" });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns only requested branches for the requested project", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");
    await storage.mergeTargets.upsert("p1", "dev2", "release");
    await storage.mergeTargets.upsert("p2", "dev1", "other-main");

    expect(await storage.mergeTargets.getForBranches("p1", ["dev1", "missing"])).toEqual(
      new Map([["dev1", "main"]]),
    );
    expect(await storage.mergeTargets.getForBranches("p1", [])).toEqual(new Map());
  });

  it("upsert reports inserts and changed targets but not identical targets", async () => {
    expect(await storage.mergeTargets.upsert("p1", "dev1", "main")).toBe(true);
    expect(await storage.mergeTargets.upsert("p1", "dev1", "main")).toBe(false);
    expect(await storage.mergeTargets.upsert("p1", "dev1", "release")).toBe(true);

    expect(await storage.mergeTargets.getForBranches("p1", ["dev1"])).toEqual(
      new Map([["dev1", "release"]]),
    );
  });

  it("upsert explicitly refreshes updated_at on conflict", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");
    const db = new Database(dbPath, { readonly: true });
    const readUpdatedAt = () =>
      (db.prepare(
        "SELECT updated_at FROM branch_merge_targets WHERE project_id = 'p1' AND branch = 'dev1'",
      ).get() as { updated_at: string }).updated_at;

    try {
      const initial = readUpdatedAt();
      await storage.mergeTargets.upsert("p1", "dev1", "release");

      expect(initial).not.toContain("T");
      expect(readUpdatedAt()).not.toBe(initial);
      expect(readUpdatedAt()).toContain("T");
    } finally {
      db.close();
    }
  });

  it("upsert leaves updated_at unchanged when the target is identical", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");
    const db = new Database(dbPath, { readonly: true });
    const readUpdatedAt = () =>
      (db.prepare(
        "SELECT updated_at FROM branch_merge_targets WHERE project_id = 'p1' AND branch = 'dev1'",
      ).get() as { updated_at: string }).updated_at;

    try {
      const initial = readUpdatedAt();
      await storage.mergeTargets.upsert("p1", "dev1", "main");

      expect(readUpdatedAt()).toBe(initial);
    } finally {
      db.close();
    }
  });

  it("insertIfAbsent inserts once and preserves the original target on conflict", async () => {
    expect(await storage.mergeTargets.insertIfAbsent("p1", "dev1", "main")).toBe(true);
    expect(await storage.mergeTargets.insertIfAbsent("p1", "dev1", "release")).toBe(false);
    expect(await storage.mergeTargets.getForBranches("p1", ["dev1"])).toEqual(
      new Map([["dev1", "main"]]),
    );
  });

  it("delete reports whether a row existed and removes it", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");

    expect(await storage.mergeTargets.delete("p1", "dev1")).toBe(true);
    expect(await storage.mergeTargets.delete("p1", "dev1")).toBe(false);
    expect(await storage.mergeTargets.getForBranches("p1", ["dev1"])).toEqual(new Map());
  });

  it("deleting a project cascades to its merge targets", async () => {
    await storage.mergeTargets.upsert("p1", "dev1", "main");

    await storage.projects.delete("p1");

    expect(await storage.mergeTargets.getForBranches("p1", ["dev1"])).toEqual(new Map());
  });
});
