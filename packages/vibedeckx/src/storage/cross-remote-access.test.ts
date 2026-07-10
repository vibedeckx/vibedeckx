import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("remote_servers.cross_remote_access", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-xra-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to 'off' on create", async () => {
    const server = await storage.remoteServers.create({ name: "b", url: "http://b:5173" });
    expect(server.cross_remote_access).toBe("off");
  });

  it("round-trips 'read' and 'exec' through update", async () => {
    const server = await storage.remoteServers.create({ name: "b", url: "http://b:5173" });

    const readTier = await storage.remoteServers.update(server.id, { cross_remote_access: "read" });
    expect(readTier?.cross_remote_access).toBe("read");

    const execTier = await storage.remoteServers.update(server.id, { cross_remote_access: "exec" });
    expect(execTier?.cross_remote_access).toBe("exec");

    const reread = await storage.remoteServers.getById(server.id);
    expect(reread?.cross_remote_access).toBe("exec");
  });

  it("leaves the tier untouched when update omits it", async () => {
    const server = await storage.remoteServers.create({ name: "b", url: "http://b:5173" });
    await storage.remoteServers.update(server.id, { cross_remote_access: "exec" });
    await storage.remoteServers.update(server.id, { name: "renamed" });

    const reread = await storage.remoteServers.getById(server.id);
    expect(reread?.name).toBe("renamed");
    expect(reread?.cross_remote_access).toBe("exec");
  });

  it("scopes updates by userId", async () => {
    const server = await storage.remoteServers.create({ name: "b", url: "http://b:5173" }, "user-1");
    const denied = await storage.remoteServers.update(server.id, { cross_remote_access: "exec" }, "user-2");
    expect(denied).toBeUndefined();

    const reread = await storage.remoteServers.getById(server.id, "user-1");
    expect(reread?.cross_remote_access).toBe("off");
  });
});
