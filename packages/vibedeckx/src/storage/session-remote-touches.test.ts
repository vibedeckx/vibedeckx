import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

// Where a session's gateway calls ran — what artifact-read-targets.ts consults
// to find which machine's /tmp a path in the conversation means.
describe("sessionRemoteTouches", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-touches-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const server = async (name: string, userId = "user-1") =>
    (await storage.remoteServers.create({ name }, userId)).id;
  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  it("keeps one row per machine and lists the most recently used first", async () => {
    const a = await server("a");
    const b = await server("b");
    await storage.sessionRemoteTouches.record("s1", "user-1", a);
    at("2026-09-02T00:00:00Z");
    await storage.sessionRemoteTouches.record("s1", "user-1", b);
    at("2026-09-03T00:00:00Z");
    // A repeat call refreshes the machine instead of adding a row.
    await storage.sessionRemoteTouches.record("s1", "user-1", a);

    expect(await storage.sessionRemoteTouches.list("s1")).toEqual([a, b]);
    expect(await storage.sessionRemoteTouches.list("s1", undefined, 1)).toEqual([a]);
    expect(await storage.sessionRemoteTouches.list("s2")).toEqual([]);
  });

  it("scopes the list to the user when one is given", async () => {
    const mine = await server("mine");
    const theirs = await server("theirs", "user-2");
    await storage.sessionRemoteTouches.record("s1", "user-1", mine);
    await storage.sessionRemoteTouches.record("s1", "user-2", theirs);

    expect(await storage.sessionRemoteTouches.list("s1", "user-1")).toEqual([mine]);
    expect((await storage.sessionRemoteTouches.list("s1")).sort()).toEqual([mine, theirs].sort());
  });

  // Session-side cleanup is covered path by path in session-side-rows.test.ts;
  // a deleted machine goes through the FK on remote_server_id instead.
  it("goes with a deleted machine", async () => {
    const a = await server("a");
    const b = await server("b");
    await storage.sessionRemoteTouches.record("s1", "user-1", a);
    await storage.sessionRemoteTouches.record("s1", "user-1", b);

    await storage.remoteServers.delete(b, "user-1");
    expect(await storage.sessionRemoteTouches.list("s1")).toEqual([a]);
  });
});
