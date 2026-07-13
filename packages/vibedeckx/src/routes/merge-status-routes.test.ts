import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { ProjectRemote, Storage } from "../storage/types.js";

const proxyToRemoteAuto = vi.hoisted(() => vi.fn());
vi.mock("../utils/remote-proxy.js", () => ({
  proxyToRemoteAuto,
  proxyStatus: (result: { status: number }, fallback = 502) => result.status > 0 ? result.status : fallback,
}));

import mergeStatusRoutes from "./merge-status-routes.js";

function run(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("merge-status repository descriptor", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let repo: string;
  let remoteA: ProjectRemote;
  let remoteB: ProjectRemote;

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    dir = mkdtempSync(path.join(tmpdir(), "vdx-merge-status-routes-"));
    repo = path.join(dir, "repo");
    run(dir, ["init", "-b", "main", repo]);
    run(repo, ["config", "user.email", "test@test.local"]);
    run(repo, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repo, "base.txt"), "base");
    run(repo, ["add", "."]);
    run(repo, ["commit", "-m", "base"]);

    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "local", name: "Local project", path: repo });
    await storage.projects.create({ id: "remote", name: "Remote project", path: null });
    const serverA = await storage.remoteServers.create({ name: "Remote A", url: "http://a" });
    const serverB = await storage.remoteServers.create({ name: "Remote B", url: "http://b" });
    remoteA = await storage.projectRemotes.add({
      project_id: "remote",
      remote_server_id: serverA.id,
      remote_path: "/repo-a",
    });
    remoteB = await storage.projectRemotes.add({
      project_id: "remote",
      remote_server_id: serverB.id,
      remote_path: "/repo-b",
    });

    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    await app.register(mergeStatusRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const postBatch = (projectId: string) => app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/branches/merge-status`,
    payload: { comparisons: [] },
  });

  it("labels a local merge-status response as Local", async () => {
    const response = await postBatch("local");

    expect(response.statusCode).toBe(200);
    expect(response.json().repository).toEqual({ kind: "local", label: "Local" });
  });

  it("labels a remote-only response with the current primary remote identity", async () => {
    proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { entries: [] } });

    const first = await postBatch("remote");
    expect(first.statusCode).toBe(200);
    expect(first.json().repository).toEqual({
      kind: "remote",
      remoteServerId: remoteA.remote_server_id,
      label: "Remote A",
    });

    await storage.projectRemotes.setPrimary("remote", remoteB.id);
    const second = await postBatch("remote");
    expect(second.statusCode).toBe(200);
    expect(second.json().repository).toEqual({
      kind: "remote",
      remoteServerId: remoteB.remote_server_id,
      label: "Remote B",
    });
  });

  it("preserves remote error responses without a repository descriptor", async () => {
    proxyToRemoteAuto.mockResolvedValue({
      ok: false,
      status: 503,
      data: { error: "remote unavailable" },
    });

    const response = await postBatch("remote");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "remote unavailable" });
  });
});
