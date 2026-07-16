import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
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

  // Raw read of the cache tables via a second better-sqlite3 connection —
  // Task 2's search() doesn't exist yet, so direct SQL is the only way to
  // assert what actually landed in the tables.
  const rawQuery = <T>(sql: string): T[] => {
    const raw = new Database(path.join(dir, "test.sqlite"), { readonly: true });
    try {
      return raw.prepare(sql).all() as T[];
    } finally {
      raw.close();
    }
  };

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

    // Workspace rows landed with the "" sentinel for branch: null, undeleted.
    const workspaces = rawQuery<{ project_id: string; target_id: string; branch: string; deleted_at: number | null }>(
      "SELECT project_id, target_id, branch, deleted_at FROM workspace_search_cache ORDER BY branch",
    );
    expect(workspaces).toEqual([
      { project_id: "p1", target_id: "w1", branch: "", deleted_at: null },
      { project_id: "p1", target_id: "w1", branch: "dev", deleted_at: null },
    ]);

    // Session rows landed with correct field mapping + branch sentinel.
    const sessions = rawQuery<{
      local_session_id: string; project_id: string; target_id: string; branch: string;
      title: string | null; last_active_at: number | null; favorited_at: number | null;
      entry_count: number; deleted_at: number | null;
    }>(
      "SELECT local_session_id, project_id, target_id, branch, title, last_active_at, favorited_at, entry_count, deleted_at FROM session_search_cache ORDER BY local_session_id",
    );
    expect(sessions).toEqual([
      { local_session_id: "remote-w1-p1-s1", project_id: "p1", target_id: "w1", branch: "dev", title: "Fix login bug", last_active_at: 1000, favorited_at: null, entry_count: 5, deleted_at: null },
      { local_session_id: "remote-w1-p1-s2", project_id: "p1", target_id: "w1", branch: "", title: "Refactor auth", last_active_at: 2000, favorited_at: 3000, entry_count: 2, deleted_at: null },
    ]);
  });

  it("marks rows absent from a newer snapshot as deleted, and reappearing rows undeleted", async () => {
    // search() only surfaces non-local rows with a live project_remotes link,
    // so the snapshot target must be a real linked server id.
    const server = await storage.remoteServers.create({ name: "W1", url: "http://w1" });
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: server.id, remote_path: "/repo" });
    await storage.searchCache.applyCatalogSnapshot("p1", server.id, snap());
    await storage.searchCache.applyCatalogSnapshot("p1", server.id, {
      workspaces: [{ branch: null }],
      sessions: [snap().sessions[1]],
    });
    let res = await storage.searchCache.search({ query: "Fix login", limitPerGroup: 10 });
    expect(res.sessions).toHaveLength(0); // s1 deleted
    await storage.searchCache.applyCatalogSnapshot("p1", server.id, snap());
    res = await storage.searchCache.search({ query: "Fix login", limitPerGroup: 10 });
    expect(res.sessions.map(s => s.sessionId)).toEqual(["remote-w1-p1-s1"]); // reappeared
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

    // Rows are soft-deleted (deleted_at set), not hard-deleted — counts unchanged.
    const workspaces = rawQuery<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM workspace_search_cache",
    );
    expect(workspaces).toHaveLength(2);
    for (const row of workspaces) expect(row.deleted_at).toBeGreaterThan(0);

    const sessions = rawQuery<{ deleted_at: number | null }>(
      "SELECT deleted_at FROM session_search_cache",
    );
    expect(sessions).toHaveLength(2);
    for (const row of sessions) expect(row.deleted_at).toBeGreaterThan(0);
  });

  it("reconciliation never touches remote_session_mappings", async () => {
    await storage.remoteSessionMappings.upsert("remote-w1-p1-s1", "p1", "w1", "s1", "dev");
    await storage.searchCache.applyCatalogSnapshot("p1", "w1", { workspaces: [], sessions: [] });
    const mappings = await storage.remoteSessionMappings.getAll();
    expect(mappings).toHaveLength(1);
  });

  it("updateCachedSessionTitle updates title in place", async () => {
    // Seed a linked server so the updated row is visible to search().
    const server = await storage.remoteServers.create({ name: "W1", url: "http://w1" });
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: server.id, remote_path: "/repo" });
    await storage.searchCache.applyCatalogSnapshot("p1", server.id, snap());
    await storage.searchCache.updateCachedSessionTitle("remote-w1-p1-s1", "Renamed thing");
    const res = await storage.searchCache.search({ query: "Renamed", limitPerGroup: 10 });
    expect(res.sessions.map(s => s.sessionId)).toEqual(["remote-w1-p1-s1"]);
  });

  describe("search", () => {
    let serverId: string;
    beforeEach(async () => {
      const server = await storage.remoteServers.create({ name: "Worker 1", url: "http://w1" });
      serverId = server.id;
      await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverId, remote_path: "/repo" });
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap());
    });

    it("matches projects by name and path", async () => {
      const res = await storage.searchCache.search({ query: "proj", limitPerGroup: 10 });
      expect(res.projects.map(p => p.id)).toEqual(["p1"]);
    });

    it("ranks exact > prefix > substring and boosts favorites within a tier", async () => {
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, { workspaces: [], sessions: [
        { id: "a", branch: "dev", title: "auth",         lastActiveAt: 1, favoritedAt: null, entryCount: 1 }, // exact
        { id: "b", branch: "dev", title: "auth refactor", lastActiveAt: 9, favoritedAt: null, entryCount: 1 }, // prefix
        { id: "c", branch: "dev", title: "fix auth bug",  lastActiveAt: 5, favoritedAt: null, entryCount: 1 }, // substring
        { id: "d", branch: "dev", title: "fix auth crash", lastActiveAt: 1, favoritedAt: 99, entryCount: 1 },  // substring + favorited
      ]});
      const res = await storage.searchCache.search({ query: "auth", limitPerGroup: 10 });
      expect(res.sessions.map(s => s.sessionId)).toEqual(["a", "b", "d", "c"]);
    });

    it("escapes LIKE wildcards — '%' finds nothing rather than everything", async () => {
      const res = await storage.searchCache.search({ query: "%", limitPerGroup: 10 });
      expect(res.sessions).toHaveLength(0);
      expect(res.projects).toHaveLength(0);
    });

    it("empty query returns recents+favorites sessions only", async () => {
      const res = await storage.searchCache.search({ query: "  ", limitPerGroup: 10 });
      expect(res.projects).toHaveLength(0);
      expect(res.workspaces).toHaveLength(0);
      // s2 (lastActiveAt 2000, favorited) before s1 (1000)
      expect(res.sessions.map(s => s.sessionId)).toEqual(["remote-w1-p1-s2", "remote-w1-p1-s1"]);
    });

    it("main workspace round-trips: stored as '' but returned as null and matches 'main'", async () => {
      const res = await storage.searchCache.search({ query: "main", limitPerGroup: 10 });
      expect(res.workspaces.some(w => w.branch === null && w.targetId === serverId)).toBe(true);
    });

    it("excludes rows from a remote no longer linked to the project", async () => {
      // remove the association, cache rows remain but must not surface
      const remotes = await storage.projectRemotes.getByProject("p1");
      await storage.projectRemotes.remove(remotes[0].id);
      const res = await storage.searchCache.search({ query: "Fix login", limitPerGroup: 10 });
      expect(res.sessions).toHaveLength(0);
    });

    it("scopes by userId — user B cannot see user A's data", async () => {
      await storage.projects.create({ id: "pB", name: "b-proj", path: "/tmp/pB" }, "userB");
      const resB = await storage.searchCache.search({ userId: "userB", query: "proj", limitPerGroup: 10 });
      expect(resB.projects.map(p => p.id)).toEqual(["pB"]); // not p1 (user_id "")
      const resB2 = await storage.searchCache.search({ userId: "userB", query: "Fix login", limitPerGroup: 10 });
      expect(resB2.sessions).toHaveLength(0);
    });

    it("includes local sessions from agent_sessions (union), skipping empty ones", async () => {
      await storage.agentSessions.create({ id: "loc1", project_id: "p1", branch: "dev" });
      await storage.agentSessions.updateTitle("loc1", "local session about caching");
      await storage.agentSessions.create({ id: "loc2", project_id: "p1", branch: "dev" }); // no title, no entries
      const res = await storage.searchCache.search({ query: "caching", limitPerGroup: 10 });
      expect(res.sessions.map(s => s.sessionId)).toEqual(["loc1"]);
      expect(res.sessions[0].targetId).toBe("local");
    });

    it("recents mode: title-less session WITH entries isn't crowded out of the recency window by 200+ empty sessions", async () => {
      // Qualifying (has entries) but oldest; the entries/title filter must run
      // in SQL BEFORE the 200-row window, or 200+ newer non-qualifying rows
      // fill the window and this session is silently dropped.
      await storage.agentSessions.create({ id: "old-entries", project_id: "p1", branch: "dev" });
      await storage.agentSessions.upsertEntry("old-entries", 0, JSON.stringify({ type: "user" }));
      await new Promise((r) => setTimeout(r, 10)); // strictly older updated_at than the padding
      for (let i = 0; i < 205; i++) {
        await storage.agentSessions.create({ id: `empty-${i}`, project_id: "p1", branch: "dev" }); // no title, no entries
      }
      const res = await storage.searchCache.search({ query: "", limitPerGroup: 300 });
      expect(res.sessions.map(s => s.sessionId)).toContain("old-entries");
    });

    it("recents mode includes ALL favorited sessions, even outside the 200-row recency window", async () => {
      await storage.agentSessions.create({ id: "fav-old", project_id: "p1", branch: "dev" });
      await storage.agentSessions.updateTitle("fav-old", "ancient favorite");
      await storage.agentSessions.setFavorited("fav-old", true);
      await new Promise((r) => setTimeout(r, 10)); // strictly older updated_at than the padding
      for (let i = 0; i < 205; i++) {
        const id = `titled-${i}`;
        await storage.agentSessions.create({ id, project_id: "p1", branch: "dev" });
        await storage.agentSessions.updateTitle(id, `padding session ${i}`);
      }
      const res = await storage.searchCache.search({ query: "", limitPerGroup: 300 });
      expect(res.sessions.map(s => s.sessionId)).toContain("fav-old");
      // No duplicates from the favorites union
      const ids = res.sessions.map(s => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("limitPerGroup truncates each group to the top-ranked rows", async () => {
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, { workspaces: [], sessions: [
        { id: "e1", branch: "dev", title: "deploy",         lastActiveAt: 1, favoritedAt: null, entryCount: 1 }, // exact
        { id: "p2", branch: "dev", title: "deploy watcher", lastActiveAt: 5, favoritedAt: null, entryCount: 1 }, // prefix
        { id: "p3", branch: "dev", title: "deploy scripts", lastActiveAt: 3, favoritedAt: null, entryCount: 1 }, // prefix, older
        { id: "s4", branch: "dev", title: "fix deploy bug", lastActiveAt: 9, favoritedAt: null, entryCount: 1 }, // substring
        { id: "s5", branch: "dev", title: "old deploy fix", lastActiveAt: 8, favoritedAt: null, entryCount: 1 }, // substring
      ]});
      const res = await storage.searchCache.search({ query: "deploy", limitPerGroup: 2 });
      expect(res.sessions.map(s => s.sessionId)).toEqual(["e1", "p2"]);
    });

    it("matches projects by path when the name doesn't match", async () => {
      // p1: name "proj" (no match for "tmp"), path "/tmp/p1" (substring match)
      const res = await storage.searchCache.search({ query: "tmp", limitPerGroup: 10 });
      expect(res.projects.map(p => p.id)).toEqual(["p1"]);
    });
  });
});
