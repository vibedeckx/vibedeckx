import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

/** docs/cross-remote-session-grants-design.md §4. */
describe("sessionRemoteGrants", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-grants-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const server = async (name: string, userId = "user-1") => {
    const row = await storage.remoteServers.create({ name }, userId);
    await storage.remoteServers.update(row.id, { cross_remote_access: "exec" }, userId);
    return row.id;
  };

  it("starts empty and round-trips a replacement", async () => {
    const a = await server("a");
    const b = await server("b");
    expect(await storage.sessionRemoteGrants.list("s1")).toEqual([]);

    await storage.sessionRemoteGrants.replace("s1", "user-1", [a, b]);
    expect((await storage.sessionRemoteGrants.list("s1")).sort()).toEqual([a, b].sort());
  });

  it("replaces rather than merges, and clears on an empty list", async () => {
    const a = await server("a");
    const b = await server("b");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a]);
    await storage.sessionRemoteGrants.replace("s1", "user-1", [b]);
    expect(await storage.sessionRemoteGrants.list("s1")).toEqual([b]);

    await storage.sessionRemoteGrants.replace("s1", "user-1", []);
    expect(await storage.sessionRemoteGrants.list("s1")).toEqual([]);
  });

  it("tolerates a repeated id in one call", async () => {
    const a = await server("a");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a, a]);
    expect(await storage.sessionRemoteGrants.list("s1")).toEqual([a]);
  });

  it("keeps sessions independent", async () => {
    const a = await server("a");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a]);
    expect(await storage.sessionRemoteGrants.list("s2")).toEqual([]);
  });

  it("keys a remote- session the same as a local one", async () => {
    // The whole reason this is a table rather than a column on agent_sessions:
    // a remote session has no agent_sessions row to hang a column off.
    const a = await server("a");
    await storage.sessionRemoteGrants.replace("remote-srv-p1-r1", "user-1", [a]);
    expect(await storage.sessionRemoteGrants.list("remote-srv-p1-r1")).toEqual([a]);
  });

  it("drops grants when the machine they point at is deleted", async () => {
    const a = await server("a");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a]);
    await storage.remoteServers.delete(a, "user-1");
    expect(await storage.sessionRemoteGrants.list("s1")).toEqual([]);
  });

  it("drops grants when the session is deleted", async () => {
    const a = await server("a");
    await storage.projects.create({ id: "p1", name: "p", path: "/w" }, "user-1");
    await storage.agentSessions.create({ id: "s1", project_id: "p1", branch: "" });
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a]);

    await storage.agentSessions.delete("s1");
    expect(await storage.sessionRemoteGrants.list("s1")).toEqual([]);
  });

  it("drops grants when a remote session's mapping is deleted", async () => {
    const a = await server("a");
    await storage.projects.create({ id: "p1", name: "p", path: "/w" }, "user-1");
    await storage.remoteSessionMappings.upsert("remote-srv-p1-r1", "p1", "srv", "r1", null);
    await storage.sessionRemoteGrants.replace("remote-srv-p1-r1", "user-1", [a]);

    await storage.remoteSessionMappings.delete("remote-srv-p1-r1");
    expect(await storage.sessionRemoteGrants.list("remote-srv-p1-r1")).toEqual([]);
  });

  it("deleteBySession removes exactly one session's grants", async () => {
    const a = await server("a");
    await storage.sessionRemoteGrants.replace("s1", "user-1", [a]);
    await storage.sessionRemoteGrants.replace("s2", "user-1", [a]);

    await storage.sessionRemoteGrants.deleteBySession("s1");
    expect(await storage.sessionRemoteGrants.list("s1")).toEqual([]);
    expect(await storage.sessionRemoteGrants.list("s2")).toEqual([a]);
  });
});
