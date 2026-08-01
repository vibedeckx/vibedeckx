import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.userId }),
  clerkClient: {},
}));

import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import projectRemoteRoutes from "./project-remote-routes.js";
import remoteServerRoutes from "./remote-server-routes.js";

describe("remote server user-facing ownership", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let dbPath: string;

  async function buildApp(authEnabled = false) {
    const instance = Fastify({ logger: false });
    instance.decorate("authEnabled", authEnabled);
    instance.decorate("storage", storage);
    instance.decorate("reverseConnectManager", {
      isConnected: vi.fn(() => false),
      unregisterConnection: vi.fn(),
    } as never);
    await instance.register(remoteServerRoutes);
    await instance.register(projectRemoteRoutes);
    await instance.ready();
    return instance;
  }

  beforeEach(async () => {
    auth.userId = "user-1";
    dir = mkdtempSync(path.join(tmpdir(), "vdx-remote-owner-"));
    dbPath = path.join(dir, "test.sqlite");
    storage = await createSqliteStorage(dbPath);
    await storage.projects.create({ id: "local-project", name: "Local", path: null });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not expose or mutate an authenticated user's server in solo mode", async () => {
    const foreign = await storage.remoteServers.create({ name: "Private worker" }, "user-2");
    const originalToken = await storage.remoteServers.generateToken(foreign.id, "user-2");

    const list = await app.inject({ method: "GET", url: "/api/remote-servers" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);

    for (const request of [
      { method: "PUT", url: `/api/remote-servers/${foreign.id}`, payload: { name: "stolen" } },
      { method: "POST", url: `/api/remote-servers/${foreign.id}/rotate-token` },
      { method: "POST", url: `/api/remote-servers/${foreign.id}/revoke-token` },
      { method: "DELETE", url: `/api/remote-servers/${foreign.id}` },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(404);
    }

    expect((await storage.remoteServers.getById(foreign.id, "user-2"))?.name).toBe("Private worker");
    expect((await storage.remoteServers.getByToken(originalToken!))?.id).toBe(foreign.id);
  });

  it("creates a local-owned server that can immediately be associated with a local project", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/remote-servers", payload: { name: "Local worker" },
    });
    expect(created.statusCode).toBe(201);

    const associated = await app.inject({
      method: "POST",
      url: "/api/projects/local-project/remotes",
      payload: { remoteServerId: created.json().id, remotePath: "/repo" },
    });
    expect(associated.statusCode, associated.body).toBe(201);
    expect(await storage.remoteServers.getById(created.json().id, "local")).toBeDefined();
  });

  it("backfills a legacy blank owner on open and keeps the migration idempotent", async () => {
    const legacy = await storage.remoteServers.create({ name: "Legacy worker" }, "legacy-placeholder");
    await app.close();
    await storage.close();

    const raw = new Database(dbPath);
    raw.prepare("UPDATE remote_servers SET user_id = '' WHERE id = ?").run(legacy.id);
    raw.close();

    storage = await createSqliteStorage(dbPath);
    await storage.close();
    storage = await createSqliteStorage(dbPath);
    app = await buildApp();

    expect(await storage.remoteServers.getById(legacy.id, "local")).toBeDefined();
    const associated = await app.inject({
      method: "POST",
      url: "/api/projects/local-project/remotes",
      payload: { remoteServerId: legacy.id, remotePath: "/legacy" },
    });
    expect(associated.statusCode, associated.body).toBe(201);

    const schemaDb = new Database(dbPath, { readonly: true });
    const userColumn = schemaDb.prepare("PRAGMA table_info(remote_servers)").all()
      .find((column) => (column as { name: string }).name === "user_id") as { dflt_value: string };
    schemaDb.close();
    expect(userColumn.dflt_value).toBe("'local'");
  });

  it("keeps authenticated users isolated", async () => {
    const own = await storage.remoteServers.create({ name: "Mine" }, "user-1");
    const foreign = await storage.remoteServers.create({ name: "Theirs" }, "user-2");
    await app.close();
    app = await buildApp(true);

    const list = await app.inject({ method: "GET", url: "/api/remote-servers" });
    expect(list.statusCode).toBe(200);
    expect(list.json().map(({ id }: { id: string }) => id)).toEqual([own.id]);
    expect((await app.inject({
      method: "PUT", url: `/api/remote-servers/${foreign.id}`, payload: { name: "stolen" },
    })).statusCode).toBe(404);
    expect((await storage.remoteServers.getById(foreign.id, "user-2"))?.name).toBe("Theirs");
  });
});
