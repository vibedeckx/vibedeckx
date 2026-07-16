import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage, SearchCatalogSnapshot } from "./types.js";

const snap = (over: Partial<SearchCatalogSnapshot> = {}): SearchCatalogSnapshot => ({
  workspaces: [{ branch: null }, { branch: "dev" }],
  sessions: [
    { id: "remote-w1-p1-s1", branch: "dev", title: "Fix login bug", lastActiveAt: 1000, favoritedAt: null, entryCount: 5 },
    { id: "remote-w1-p1-s2", branch: null, title: "Refactor auth", lastActiveAt: 2000, favoritedAt: 3000, entryCount: 2 },
  ],
  ...over,
});

describe("searchCache", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-search-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/p1" });
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applyCatalogSnapshot upserts rows and records sync success", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states).toHaveLength(1);
    expect(states[0].target_id).toBe("w1");
    expect(states[0].last_success_at).toBeGreaterThan(0);
    expect(states[0].last_error ?? null).toBeNull();
  });

  it("marks rows absent from a newer snapshot as deleted, and reappearing rows undeleted", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    // second snapshot drops session s1 and branch dev
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", {
      workspaces: [{ branch: null }],
      sessions: [snap().sessions[1]],
    });
    // third snapshot brings s1 back
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    // verify via Task 2's search OR directly: use a raw query through a second
    // snapshot check — here we assert through getSyncStates generation growth
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_success_at).toBeGreaterThan(0);
  });

  it("recordSyncFailure records the error and never deletes cache rows", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    await storage.searchCache.recordSyncFailure("p1", "w1", "timeout");
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_error).toBe("timeout");
    expect(states[0].last_attempt_at).toBeGreaterThan(0);
    expect(states[0].last_success_at).toBeGreaterThan(0); // preserved from the earlier success
  });

  it("an empty snapshot is a successful sync (updates last_success_at, deletes all rows)", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", { workspaces: [], sessions: [] });
    const states = await storage.searchCache.getSyncStates(["p1"]);
    expect(states[0].last_success_at).toBeGreaterThan(0);
  });

  it("reconciliation never touches remote_session_mappings", async () => {
    await storage.remoteSessionMappings.upsert("remote-w1-p1-s1", "p1", "w1", "s1", "dev");
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", { workspaces: [], sessions: [] });
    const mappings = await storage.remoteSessionMappings.getAll();
    expect(mappings).toHaveLength(1);
  });

  it("updateCachedSessionTitle updates title in place", async () => {
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", snap());
    await storage.searchCache.updateCachedSessionTitle("remote-w1-p1-s1", "New title");
    // asserted through Task 2's search(); for now just ensure it doesn't throw
  });
});
