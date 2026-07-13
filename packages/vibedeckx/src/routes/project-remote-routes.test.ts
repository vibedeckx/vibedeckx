import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { ProjectRemote, Storage } from "../storage/types.js";
import projectRemoteRoutes from "./project-remote-routes.js";

describe("POST /api/projects/:id/remotes/:rid/primary", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let p1Remote1: ProjectRemote;
  let p1Remote2: ProjectRemote;
  let p2Remote: ProjectRemote;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-remote-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "project 1", path: null });
    await storage.projects.create({ id: "p2", name: "project 2", path: null });

    const server1 = await storage.remoteServers.create({ name: "Remote A", url: "http://a" });
    const server2 = await storage.remoteServers.create({ name: "Remote B", url: "http://b" });
    const server3 = await storage.remoteServers.create({ name: "Remote C", url: "http://c" });
    p1Remote1 = await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: server1.id,
      remote_path: "/repo-a",
    });
    p1Remote2 = await storage.projectRemotes.add({
      project_id: "p1",
      remote_server_id: server2.id,
      remote_path: "/repo-b",
    });
    p2Remote = await storage.projectRemotes.add({
      project_id: "p2",
      remote_server_id: server3.id,
      remote_path: "/repo-c",
    });

    app = Fastify();
    app.decorate("storage", storage);
    await app.register(projectRemoteRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets an associated remote as primary", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/p1/remotes/${p1Remote2.id}/primary`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect((await storage.projectRemotes.getByProject("p1"))[0].id).toBe(p1Remote2.id);
    expect((await storage.projectRemotes.getByProject("p1"))[1].id).toBe(p1Remote1.id);
  });

  it("returns 404 when the association belongs to another project", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/p1/remotes/${p2Remote.id}/primary`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Project remote not found" });
    expect((await storage.projectRemotes.getByProject("p1"))[0].id).toBe(p1Remote1.id);
  });
});
