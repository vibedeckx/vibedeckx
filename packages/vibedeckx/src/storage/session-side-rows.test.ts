import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

/**
 * Grants and touches key both local and `remote-` sessions, so no foreign key
 * can cascade them; every session delete path calls deleteSessionSideRows
 * instead (repositories/session-side-rows.ts). This drives each path once.
 * A new way of deleting sessions belongs here too.
 */

const DAY = 86_400_000;

describe("session side rows go with their session", () => {
  let dir: string;
  let dbPath: string;
  let storage: Storage;
  let machine: string;

  const raw = (statement: string, ...params: unknown[]) => {
    const db = new Database(dbPath);
    try {
      db.prepare(statement).run(...params);
    } finally {
      db.close();
    }
  };

  /** Give a session both kinds of side row. */
  const attach = async (sessionId: string) => {
    await storage.sessionRemoteGrants.replace(sessionId, "user-1", [machine]);
    await storage.sessionRemoteTouches.record(sessionId, "user-1", machine);
  };

  const sideRows = async (sessionId: string) => ({
    grants: await storage.sessionRemoteGrants.list(sessionId),
    touches: await storage.sessionRemoteTouches.list(sessionId),
  });
  const none = { grants: [], touches: [] };
  const kept = () => ({ grants: [machine], touches: [machine] });

  const localSession = async (id: string) => {
    await storage.agentSessions.create({ id, project_id: "p1", branch: "" });
    await attach(id);
  };

  const remoteSession = async (remoteId: string) => {
    const localId = `remote-${machine}-p1-${remoteId}`;
    await storage.remoteSessionMappings.upsert(localId, "p1", machine, remoteId, null);
    await attach(localId);
    return localId;
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-side-rows-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "p1", name: "p", path: null });
    machine = (await storage.remoteServers.create({ name: "m" }, "user-1")).id;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("delete", async () => {
    await localSession("s1");
    await localSession("s2");
    await storage.agentSessions.delete("s1");
    expect(await sideRows("s1")).toEqual(none);
    expect(await sideRows("s2")).toEqual(kept());
  });

  it("deleteIfExpired (session retention) — and a starred session keeps them", async () => {
    await localSession("old");
    await localSession("starred");
    for (const id of ["old", "starred"]) {
      await storage.agentSessions.updateStatus(id, "stopped");
      raw("UPDATE agent_sessions SET activity_at = ? WHERE id = ?", Date.now() - 100 * DAY, id);
    }
    await storage.agentSessions.setFavorited("starred", true);
    const cutoff = Date.now() - 90 * DAY;

    expect(await storage.agentSessions.deleteIfExpired("old", cutoff)).toBe(true);
    expect(await storage.agentSessions.deleteIfExpired("starred", cutoff)).toBe(false);
    expect(await sideRows("old")).toEqual(none);
    expect(await sideRows("starred")).toEqual(kept());
  });

  it("deleteIfEmpty", async () => {
    await localSession("empty");
    expect(await storage.agentSessions.deleteIfEmpty("empty")).toBe(true);
    expect(await sideRows("empty")).toEqual(none);
  });

  it("deleteExpiredTombstones", async () => {
    await localSession("tomb");
    await localSession("live");
    raw("UPDATE agent_sessions SET lifecycle_state = 'expired', expired_at = ? WHERE id = 'tomb'", 1_000);
    expect(await storage.agentSessions.deleteExpiredTombstones({ cutoff: 2_000, limit: 10 })).toBe(1);
    expect(await sideRows("tomb")).toEqual(none);
    expect(await sideRows("live")).toEqual(kept());
  });

  it("remoteSessionMappings.delete", async () => {
    const localId = await remoteSession("r1");
    await storage.remoteSessionMappings.delete(localId);
    expect(await sideRows(localId)).toEqual(none);
  });

  // Local sessions leave through the FK cascade on `projects` here, which
  // cannot reach side rows on its own.
  it("projects.delete — local and remote sessions alike, other projects untouched", async () => {
    await storage.projects.create({ id: "p2", name: "other", path: null });
    await storage.agentSessions.create({ id: "elsewhere", project_id: "p2", branch: "" });
    await attach("elsewhere");
    await localSession("s1");
    const remoteId = await remoteSession("r1");

    await storage.projects.delete("p1");
    expect(await sideRows("s1")).toEqual(none);
    expect(await sideRows(remoteId)).toEqual(none);
    expect(await sideRows("elsewhere")).toEqual(kept());
  });
});
