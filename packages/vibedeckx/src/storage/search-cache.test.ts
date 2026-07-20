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

describe("session_search_cache written_at migration", () => {
  it("adds the column to a pre-existing database created before write-through", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vdx-search-mig-"));
    try {
      const dbPath = path.join(dir, "old.sqlite");
      // Old-schema table (no written_at) with a row, as an upgraded install has.
      const raw = new Database(dbPath);
      raw.exec(`CREATE TABLE session_search_cache (
        local_session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_id TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '', title TEXT, last_active_at INTEGER, favorited_at INTEGER,
        entry_count INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL, deleted_at INTEGER)`);
      raw.prepare("INSERT INTO session_search_cache (local_session_id, project_id, target_id, generation) VALUES ('s1','p1','w1',1)").run();
      raw.close();

      const migrated = await createSqliteStorage(dbPath);
      try {
        // Column exists (write-through works) and the old row is intact.
        await migrated.searchCache.noteSessionCreated({
          localSessionId: "s2", projectId: "p1", targetId: "w1", branch: null,
        });
        const check = new Database(dbPath, { readonly: true });
        try {
          const rows = check.prepare("SELECT local_session_id, written_at FROM session_search_cache ORDER BY local_session_id").all() as Array<{ local_session_id: string; written_at: number | null }>;
          expect(rows.map((r) => r.local_session_id)).toEqual(["s1", "s2"]);
          expect(rows[0].written_at).toBeNull();
          expect(rows[1].written_at).toBeGreaterThan(0);
        } finally {
          check.close();
        }
      } finally {
        await migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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

    it("empty query at the DEFAULT limit keeps sessions purely recency-ordered and surfaces an old favorite in the favorites group", async () => {
      // Regression (both directions): sorting favorited-first before the cap
      // let many favorites crowd every recent session out of the top-10; pure
      // recency let old favorites never make the cut. The split contract:
      // `sessions` = pure recency, `favorites` = favorited rows that didn't
      // make the recency cut.
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, { workspaces: [], sessions: [] }); // drop seeded s1/s2 (s2 is favorited)
      await storage.agentSessions.create({ id: "old-fav", project_id: "p1", branch: "dev" });
      await storage.agentSessions.updateTitle("old-fav", "ancient favorite");
      await storage.agentSessions.setFavorited("old-fav", true);
      await new Promise((r) => setTimeout(r, 10)); // strictly older updated_at than the padding below
      for (let i = 0; i < 12; i++) {
        const id = `recent-${i}`;
        await storage.agentSessions.create({ id, project_id: "p1", branch: "dev" });
        await storage.agentSessions.updateTitle(id, `recent session ${i}`);
      }
      const res = await storage.searchCache.search({ query: "", limitPerGroup: 10 });
      expect(res.sessions).toHaveLength(10);
      expect(res.sessions.map(s => s.sessionId)).not.toContain("old-fav");
      expect(res.favorites.map(s => s.sessionId)).toEqual(["old-fav"]);
    });

    it("recents mode: many favorites do not crowd recent sessions out of the sessions group", async () => {
      // 12 old favorites + 3 newer unfavorited sessions, limit 10: under the
      // old favorited-first sort the favorites filled all 10 slots and the
      // actually-recent sessions vanished.
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, { workspaces: [], sessions: [] }); // drop seeded s1/s2 (s2 is favorited)
      for (let i = 0; i < 12; i++) {
        const id = `fav-${i}`;
        await storage.agentSessions.create({ id, project_id: "p1", branch: "dev" });
        await storage.agentSessions.updateTitle(id, `favorite ${i}`);
        await storage.agentSessions.setFavorited(id, true);
      }
      await new Promise((r) => setTimeout(r, 10)); // recents strictly newer than the favorites
      for (let i = 0; i < 3; i++) {
        const id = `recent-${i}`;
        await storage.agentSessions.create({ id, project_id: "p1", branch: "dev" });
        await storage.agentSessions.updateTitle(id, `recent session ${i}`);
      }
      const res = await storage.searchCache.search({ query: "", limitPerGroup: 10 });
      const ids = res.sessions.map(s => s.sessionId);
      expect(ids.slice(0, 3).sort()).toEqual(["recent-0", "recent-1", "recent-2"]);
      // Favorites group holds the overflow, recency-ordered, deduped against
      // the sessions group, capped at limitPerGroup.
      expect(res.favorites).toHaveLength(5); // 12 favs - 7 already in sessions
      const sessionIds = new Set(ids);
      for (const f of res.favorites) expect(sessionIds.has(f.sessionId)).toBe(false);
    });

    it("recents mode: a favorite inside the recency cut appears only in sessions, not duplicated into favorites", async () => {
      // Seeded snapshot: s2 is favorited AND most recent → sessions only.
      const res = await storage.searchCache.search({ query: "", limitPerGroup: 10 });
      expect(res.sessions.map(s => s.sessionId)).toEqual(["remote-w1-p1-s2", "remote-w1-p1-s1"]);
      expect(res.favorites).toHaveLength(0);
    });

    it("query mode returns an empty favorites group", async () => {
      const res = await storage.searchCache.search({ query: "auth", limitPerGroup: 10 });
      expect(res.favorites).toEqual([]);
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

  // Write-through: session create/delete events that transit the server update
  // the cache immediately. A snapshot only overrides a write-through row when
  // its data was collected AFTER the write-through happened (`collectedAt`) —
  // an in-flight snapshot (collected before the event) must neither sweep a
  // just-created row nor resurrect a just-deleted one.
  describe("write-through + in-flight snapshot exemption", () => {
    const X = "remote-w1-p1-created";
    let serverId: string;
    const past = () => Date.now() - 60_000;
    const future = () => Date.now() + 60_000;
    const recents = async () => {
      const res = await storage.searchCache.search({ query: "", limitPerGroup: 50 });
      return res.sessions.map((s) => s.sessionId);
    };

    beforeEach(async () => {
      const server = await storage.remoteServers.create({ name: "W1", url: "http://w1" });
      serverId = server.id;
      await storage.projectRemotes.add({ project_id: "p1", remote_server_id: serverId, remote_path: "/repo" });
    });

    const noteCreated = () => storage.searchCache.noteSessionCreated({
      localSessionId: X, projectId: "p1", targetId: serverId, branch: "dev",
    });

    it("noteSessionCreated surfaces the session in recents before any snapshot ran", async () => {
      await noteCreated();
      expect(await recents()).toContain(X);
    });

    it("a snapshot collected BEFORE the creation does not sweep the write-through row", async () => {
      await noteCreated();
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap(), past());
      expect(await recents()).toContain(X);
    });

    it("a snapshot collected AFTER the creation sweeps a row the worker doesn't have", async () => {
      await noteCreated();
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap(), future());
      expect(await recents()).not.toContain(X);
    });

    it("a snapshot containing the session confirms it; a later one sweeps it normally", async () => {
      await noteCreated();
      const withX: SearchCatalogSnapshot = {
        ...snap(),
        sessions: [...snap().sessions, { id: X, branch: "dev", title: "From worker", lastActiveAt: 5000, favoritedAt: null, entryCount: 3 }],
      };
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, withX, future());
      const confirmed = await storage.searchCache.search({ query: "From worker", limitPerGroup: 10 });
      expect(confirmed.sessions.map((s) => s.sessionId)).toEqual([X]);
      // Once snapshot-owned, the exemption is gone: the next snapshot without
      // X (collected later still) deletes it.
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap(), future() + 1);
      expect(await recents()).not.toContain(X);
    });

    it("noteSessionDeleted hides the session immediately", async () => {
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap());
      await storage.searchCache.noteSessionDeleted("remote-w1-p1-s1");
      expect(await recents()).not.toContain("remote-w1-p1-s1");
    });

    it("a snapshot collected BEFORE the deletion does not resurrect the row", async () => {
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap());
      await storage.searchCache.noteSessionDeleted("remote-w1-p1-s1");
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap(), past());
      expect(await recents()).not.toContain("remote-w1-p1-s1");
    });

    it("a snapshot collected AFTER the deletion resurrects a row the worker still has", async () => {
      // e.g. the proxied DELETE failed on the worker — the worker's catalog is
      // the source of truth, so a genuinely-newer snapshot wins.
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap());
      await storage.searchCache.noteSessionDeleted("remote-w1-p1-s1");
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap(), future());
      expect(await recents()).toContain("remote-w1-p1-s1");
    });

    it("noteSessionCreated after a deletion resurrects the row (recreate flow)", async () => {
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap());
      await storage.searchCache.noteSessionDeleted("remote-w1-p1-s1");
      await storage.searchCache.noteSessionCreated({
        localSessionId: "remote-w1-p1-s1", projectId: "p1", targetId: serverId, branch: "dev",
      });
      expect(await recents()).toContain("remote-w1-p1-s1");
    });

    it("updateCachedSessionTitle(null) clears the title and the clear survives an in-flight snapshot", async () => {
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap());
      await storage.searchCache.updateCachedSessionTitle("remote-w1-p1-s1", null);
      let res = await storage.searchCache.search({ query: "Fix login", limitPerGroup: 10 });
      expect(res.sessions).toHaveLength(0);
      // A stale snapshot (collected before the clear) must not resurrect it.
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap(), past());
      res = await storage.searchCache.search({ query: "Fix login", limitPerGroup: 10 });
      expect(res.sessions).toHaveLength(0);
    });

    it("updateCachedSessionTitle protects the fresh title from an in-flight snapshot", async () => {
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap());
      await storage.searchCache.updateCachedSessionTitle("remote-w1-p1-s1", "Fresh rename");
      // Stale snapshot (collected before the rename) still carries the old title.
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap(), past());
      let res = await storage.searchCache.search({ query: "Fresh rename", limitPerGroup: 10 });
      expect(res.sessions.map((s) => s.sessionId)).toEqual(["remote-w1-p1-s1"]);
      // A genuinely-newer snapshot wins again.
      await storage.searchCache.applyCatalogSnapshot("p1", serverId, snap(), future());
      res = await storage.searchCache.search({ query: "Fresh rename", limitPerGroup: 10 });
      expect(res.sessions).toHaveLength(0);
    });
  });
});
