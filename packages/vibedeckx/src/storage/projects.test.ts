import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

describe("projects + settings storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-proj-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("create/getById round-trips including JSON sync configs and is_remote coercion", async () => {
    const p = await storage.projects.create({
      id: "p1", name: "proj", path: "/tmp/x",
      remote_url: "http://r:3000",
      sync_up_config: { actionType: "command", executionMode: "local", content: "make up" },
    });
    expect(p.is_remote).toBe(true);                      // boolean, not 0/1
    expect(p.sync_up_config?.content).toBe("make up");   // parsed object, not JSON string
    const got = await storage.projects.getById("p1");
    expect(got?.is_remote).toBe(true);
    expect(got?.sync_up_config?.actionType).toBe("command");
  });

  it("create defaults agent_mode/executor_mode to 'local' and is_remote to false without remote_url", async () => {
    const p = await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" });
    expect(p.agent_mode).toBe("local");
    expect(p.executor_mode).toBe("local");
    expect(p.is_remote).toBe(false);
    expect(p.sync_up_config).toBeUndefined();
    expect(p.sync_down_config).toBeUndefined();
    expect(p.remote_path).toBeUndefined();
    expect(p.remote_url).toBeUndefined();
    expect(p.remote_api_key).toBeUndefined();
  });

  it("user scoping: getById with wrong userId returns undefined", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" }, "user-a");
    expect(await storage.projects.getById("p1", "user-a")).toBeDefined();
    expect(await storage.projects.getById("p1", "user-b")).toBeUndefined();
    // No userId passed at all → unscoped read still finds it.
    expect(await storage.projects.getById("p1")).toBeDefined();
  });

  it("user scoping: getAll filters by userId and excludes path:* pseudo-projects", async () => {
    await storage.projects.create({ id: "p1", name: "proj-a", path: "/tmp/a" }, "user-a");
    await storage.projects.create({ id: "p2", name: "proj-b", path: "/tmp/b" }, "user-b");
    await storage.projects.create({ id: "path:pseudo", name: "pseudo", path: "/tmp/pseudo" }, "user-a");

    const allForA = await storage.projects.getAll("user-a");
    expect(allForA.map((x) => x.id)).toEqual(["p1"]);

    const allUnscoped = await storage.projects.getAll();
    expect(allUnscoped.map((x) => x.id).sort()).toEqual(["p1", "p2"]);
  });

  it("getByPath finds by path regardless of user", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" }, "user-a");
    const got = await storage.projects.getByPath("/tmp/x");
    expect(got?.id).toBe("p1");
    expect(await storage.projects.getByPath("/tmp/does-not-exist")).toBeUndefined();
  });

  it("update: null clears a field, undefined leaves it untouched", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x", remote_url: "http://r" });
    const u1 = await storage.projects.update("p1", { name: "renamed" });
    expect(u1?.remote_url).toBe("http://r");
    expect(u1?.name).toBe("renamed");
    const u2 = await storage.projects.update("p1", { remote_url: null });
    expect(u2?.remote_url).toBeUndefined();
    // is_remote auto-derives from remote_url on update.
    expect(u2?.is_remote).toBe(false);
  });

  it("update: setting remote_url flips is_remote back to true", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" });
    const updated = await storage.projects.update("p1", { remote_url: "http://r2" });
    expect(updated?.is_remote).toBe(true);
    expect(updated?.remote_url).toBe("http://r2");
  });

  it("update: no-op opts still returns current row (respecting userId scoping)", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" }, "user-a");
    const same = await storage.projects.update("p1", {}, "user-a");
    expect(same?.id).toBe("p1");
    const wrongUser = await storage.projects.update("p1", {}, "user-b");
    expect(wrongUser).toBeUndefined();
  });

  it("update: sync_up_config/sync_down_config JSON round-trip and clearing", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" });
    const withCfg = await storage.projects.update("p1", {
      sync_up_config: { actionType: "prompt", executionMode: "local", content: "up" },
      sync_down_config: { actionType: "command", executionMode: "local", content: "down" },
    });
    expect(withCfg?.sync_up_config?.content).toBe("up");
    expect(withCfg?.sync_down_config?.content).toBe("down");
    const cleared = await storage.projects.update("p1", { sync_up_config: null, sync_down_config: null });
    expect(cleared?.sync_up_config).toBeUndefined();
    expect(cleared?.sync_down_config).toBeUndefined();
  });

  it("delete removes only the caller's own project when userId given", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" }, "user-a");
    await storage.projects.delete("p1", "user-b");
    expect(await storage.projects.getById("p1")).toBeDefined(); // wrong-user delete is a no-op
    await storage.projects.delete("p1", "user-a");
    expect(await storage.projects.getById("p1")).toBeUndefined();
  });

  it("settings get/set/delete round-trip", async () => {
    expect(await storage.settings.get("k")).toBeUndefined();
    await storage.settings.set("k", "v1");
    await storage.settings.set("k", "v2"); // upsert
    expect(await storage.settings.get("k")).toBe("v2");
    await storage.settings.delete("k");
    expect(await storage.settings.get("k")).toBeUndefined();
  });

  it("settings.getOrCreate only invokes factory once, persists the value", async () => {
    let calls = 0;
    const factory = () => { calls++; return "generated"; };
    const first = await storage.settings.getOrCreate("gen-key", factory);
    expect(first).toBe("generated");
    expect(calls).toBe(1);
    const second = await storage.settings.getOrCreate("gen-key", factory);
    expect(second).toBe("generated");
    expect(calls).toBe(1); // factory not called again
  });

  it("settings.update merges via mergeFn against current value (undefined when unset)", async () => {
    const first = await storage.settings.update("merge-key", (current) => {
      expect(current).toBeUndefined();
      return "v1";
    });
    expect(first).toBe("v1");
    expect(await storage.settings.get("merge-key")).toBe("v1");

    const second = await storage.settings.update("merge-key", (current) => `${current}-v2`);
    expect(second).toBe("v1-v2");
    expect(await storage.settings.get("merge-key")).toBe("v1-v2");
  });
});

describe("remoteServers + projectRemotes + machineIdentity storage", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-remote-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
  });
  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("remoteServers create/getById defaults connection_mode to outbound and status to unknown", async () => {
    const server = await storage.remoteServers.create({ name: "srv", url: "http://remote:5173" }, "user-a");
    expect(server.connection_mode).toBe("outbound");
    expect(server.status).toBe("unknown");
    expect(server.api_key).toBeUndefined();
    const got = await storage.remoteServers.getById(server.id, "user-a");
    expect(got?.name).toBe("srv");
    expect(await storage.remoteServers.getById(server.id, "user-b")).toBeUndefined();
  });

  it("remoteServers getAll scopes by userId", async () => {
    await storage.remoteServers.create({ name: "a", url: "http://a" }, "user-a");
    await storage.remoteServers.create({ name: "b", url: "http://b" }, "user-b");
    const forA = await storage.remoteServers.getAll("user-a");
    expect(forA.map((s) => s.name)).toEqual(["a"]);
    const allUnscoped = await storage.remoteServers.getAll();
    expect(allUnscoped.length).toBe(2);
  });

  it("remoteServers getByUrl and getOwnerId are unscoped lookups", async () => {
    const server = await storage.remoteServers.create({ name: "srv", url: "http://remote" }, "user-a");
    const byUrl = await storage.remoteServers.getByUrl("http://remote");
    expect(byUrl?.id).toBe(server.id);
    expect(await storage.remoteServers.getOwnerId(server.id)).toBe("user-a");
    expect(await storage.remoteServers.getOwnerId("nonexistent")).toBeUndefined();
  });

  it("remoteServers update: partial updates and ownership scoping", async () => {
    const server = await storage.remoteServers.create({ name: "srv", url: "http://remote" }, "user-a");
    const renamed = await storage.remoteServers.update(server.id, { name: "renamed" }, "user-a");
    expect(renamed?.name).toBe("renamed");
    expect(renamed?.url).toBe("http://remote"); // untouched
    const wrongUser = await storage.remoteServers.update(server.id, { name: "hacked" }, "user-b");
    expect(wrongUser).toBeUndefined();
    // No-op update (no fields) still returns current row.
    const noop = await storage.remoteServers.update(server.id, {}, "user-a");
    expect(noop?.name).toBe("renamed");
  });

  it("remoteServers updateStatus sets last_connected_at only when going online", async () => {
    const server = await storage.remoteServers.create({ name: "srv", url: "http://remote" });
    await storage.remoteServers.updateStatus(server.id, "online");
    const online = await storage.remoteServers.getById(server.id);
    expect(online?.status).toBe("online");
    expect(online?.last_connected_at).toBeDefined();

    await storage.remoteServers.updateStatus(server.id, "offline");
    const offline = await storage.remoteServers.getById(server.id);
    expect(offline?.status).toBe("offline");
  });

  it("remoteServers generateToken/getByToken/revokeToken lifecycle", async () => {
    const server = await storage.remoteServers.create({ name: "srv", url: "http://remote" }, "user-a");
    const token = await storage.remoteServers.generateToken(server.id, "user-a");
    expect(token).toBeDefined();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const byToken = await storage.remoteServers.getByToken(token!);
    expect(byToken?.id).toBe(server.id);
    expect(byToken?.connect_token_created_at).toBeDefined();

    // Wrong owner can't generate a token for someone else's server.
    const denied = await storage.remoteServers.generateToken(server.id, "user-b");
    expect(denied).toBeUndefined();

    const revoked = await storage.remoteServers.revokeToken(server.id, "user-a");
    expect(revoked).toBe(true);
    expect(await storage.remoteServers.getByToken(token!)).toBeUndefined();

    // Revoking again (already revoked): the UPDATE still matches the row by
    // id/user_id (regardless of whether connect_token was already NULL), so
    // sqlite reports it as changed — `changes` counts matched rows, not
    // whether any column value actually differed.
    const revokedAgain = await storage.remoteServers.revokeToken(server.id, "user-a");
    expect(revokedAgain).toBe(true);
    // Only a truly nonexistent/foreign row reports no change.
    const revokedWrongUser = await storage.remoteServers.revokeToken(server.id, "user-b");
    expect(revokedWrongUser).toBe(false);
  });

  it("remoteServers delete respects ownership and reports whether a row was removed", async () => {
    const server = await storage.remoteServers.create({ name: "srv", url: "http://remote" }, "user-a");
    const deniedDelete = await storage.remoteServers.delete(server.id, "user-b");
    expect(deniedDelete).toBe(false);
    expect(await storage.remoteServers.getById(server.id)).toBeDefined();
    const ok = await storage.remoteServers.delete(server.id, "user-a");
    expect(ok).toBe(true);
    expect(await storage.remoteServers.getById(server.id)).toBeUndefined();
  });

  it("projectRemotes add/getByProject/getByProjectAndServer join in server fields and parse JSON configs", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" });
    const server = await storage.remoteServers.create({ name: "srv", url: "http://remote", api_key: "secret" });

    const pr = await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: server.id,
      remote_path: "/remote/path",
      sync_up_config: { actionType: "command", executionMode: "local", content: "up" },
    });
    expect(pr.sort_order).toBe(0);
    expect(pr.sync_up_config?.content).toBe("up");
    expect(pr.sync_down_config).toBeUndefined();

    const list = await storage.projectRemotes.getByProject("p1");
    expect(list).toHaveLength(1);
    expect(list[0].server_name).toBe("srv");
    expect(list[0].server_url).toBe("http://remote");
    expect(list[0].server_api_key).toBe("secret");
    expect(list[0].sync_up_config?.content).toBe("up");

    const single = await storage.projectRemotes.getByProjectAndServer("p1", server.id);
    expect(single?.id).toBe(pr.id);
    expect(single?.server_name).toBe("srv");
    expect(await storage.projectRemotes.getByProjectAndServer("p1", "nonexistent")).toBeUndefined();
  });

  it("projectRemotes getByProject orders by sort_order ascending", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" });
    const s1 = await storage.remoteServers.create({ name: "s1", url: "http://s1" });
    const s2 = await storage.remoteServers.create({ name: "s2", url: "http://s2" });
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: s1.id, remote_path: "/a", sort_order: 1 });
    await storage.projectRemotes.add({ project_id: "p1", remote_server_id: s2.id, remote_path: "/b", sort_order: 0 });
    const list = await storage.projectRemotes.getByProject("p1");
    expect(list.map((r) => r.server_name)).toEqual(["s2", "s1"]);
  });

  it("projectRemotes update: partial update and null clears sync configs", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" });
    const server = await storage.remoteServers.create({ name: "srv", url: "http://remote" });
    const pr = await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: server.id,
      remote_path: "/remote/path",
      sync_up_config: { actionType: "command", executionMode: "local", content: "up" },
    });
    const updated = await storage.projectRemotes.update(pr.id, { remote_path: "/new/path" });
    expect(updated?.remote_path).toBe("/new/path");
    expect(updated?.sync_up_config?.content).toBe("up"); // untouched by undefined

    const cleared = await storage.projectRemotes.update(pr.id, { sync_up_config: null });
    expect(cleared?.sync_up_config).toBeUndefined();

    // No-op update returns current row.
    const noop = await storage.projectRemotes.update(pr.id, {});
    expect(noop?.remote_path).toBe("/new/path");

    expect(await storage.projectRemotes.update("nonexistent", { remote_path: "/x" })).toBeUndefined();
  });

  it("projectRemotes remove reports whether a row was deleted", async () => {
    await storage.projects.create({ id: "p1", name: "proj", path: "/tmp/x" });
    const server = await storage.remoteServers.create({ name: "srv", url: "http://remote" });
    const pr = await storage.projectRemotes.add({ project_id: "p1", remote_server_id: server.id, remote_path: "/x" });
    expect(await storage.projectRemotes.remove(pr.id)).toBe(true);
    expect(await storage.projectRemotes.remove(pr.id)).toBe(false);
  });

  it("machineIdentity pin is a no-op if already present; get/touch behave accordingly", async () => {
    expect(await storage.machineIdentity.get("m1")).toBeUndefined();
    await storage.machineIdentity.pin("m1", "pubkey-1", "user-a");
    const row = await storage.machineIdentity.get("m1");
    expect(row?.public_key).toBe("pubkey-1");
    expect(row?.user_id).toBe("user-a");
    expect(row?.last_seen_at).toBeNull();

    // Re-pinning with a different key/user is ignored (INSERT OR IGNORE).
    await storage.machineIdentity.pin("m1", "pubkey-2", "user-b");
    const stillOriginal = await storage.machineIdentity.get("m1");
    expect(stillOriginal?.public_key).toBe("pubkey-1");
    expect(stillOriginal?.user_id).toBe("user-a");

    await storage.machineIdentity.touch("m1");
    const touched = await storage.machineIdentity.get("m1");
    expect(touched?.last_seen_at).toBeDefined();
  });

  it("machineIdentity claimOrVerify: first call claims+creates, matching owner verifies+touches, mismatched owner is rejected without touching", async () => {
    const first = await storage.machineIdentity.claimOrVerify("m1", "pubkey-1", "user-a");
    expect(first).toEqual({ owned: true, ownerId: "user-a", created: true });
    const afterFirst = await storage.machineIdentity.get("m1");
    expect(afterFirst?.last_seen_at).toBeDefined();

    const second = await storage.machineIdentity.claimOrVerify("m1", "pubkey-1", "user-a");
    expect(second).toEqual({ owned: true, ownerId: "user-a", created: false });

    const mismatched = await storage.machineIdentity.claimOrVerify("m1", "pubkey-1", "user-b");
    expect(mismatched).toEqual({ owned: false, ownerId: "user-a", created: false });
  });
});
