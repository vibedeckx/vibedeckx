import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalEvent } from "../event-bus.js";
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
  let emitted: GlobalEvent[];

  beforeEach(async () => {
    proxyToRemoteAuto.mockReset();
    emitted = [];
    dir = mkdtempSync(path.join(tmpdir(), "vdx-merge-status-routes-"));
    repo = path.join(dir, "repo");
    run(dir, ["init", "-b", "main", repo]);
    run(repo, ["config", "user.email", "test@test.local"]);
    run(repo, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repo, "base.txt"), "base");
    run(repo, ["add", "."]);
    run(repo, ["commit", "-m", "base"]);
    run(repo, ["branch", "feature"]);
    run(repo, ["branch", "release"]);

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
    app.decorate("eventBus", { emit: (event: GlobalEvent) => emitted.push(event) } as never);
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

  describe("stored merge-target resolution", () => {
    const postComparisons = (projectId: string, comparisons: Array<{
      branch: string;
      target?: string;
    }>) => app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/branches/merge-status`,
      payload: { comparisons },
    });

    it("annotates a bare comparison with its resolved default target", async () => {
      const response = await postComparisons("local", [{ branch: "feature" }]);

      expect(response.statusCode).toBe(200);
      expect(response.json().entries[0]).toMatchObject({
        branch: "feature",
        target: "main",
        targetSource: "default",
        requestedTarget: "main",
      });
    });

    it("resolves and annotates a stored target", async () => {
      await storage.mergeTargets.upsert("local", "feature", "release");

      const response = await postComparisons("local", [{ branch: "feature" }]);

      expect(response.statusCode).toBe(200);
      expect(response.json().entries[0]).toMatchObject({
        branch: "feature",
        target: "release",
        targetSource: "stored",
        requestedTarget: "release",
      });
    });

    it("gives an explicit request target precedence over a stored target", async () => {
      await storage.mergeTargets.upsert("local", "feature", "ghost");

      const response = await postComparisons("local", [
        { branch: "feature", target: "main" },
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.json().entries[0]).toMatchObject({
        branch: "feature",
        target: "main",
        targetSource: "request",
        requestedTarget: "main",
      });
    });

    it("preserves a missing stored target in metadata without deleting it", async () => {
      await storage.mergeTargets.upsert("local", "feature", "ghost");

      const response = await postComparisons("local", [{ branch: "feature" }]);

      expect(response.statusCode).toBe(200);
      expect(response.json().entries[0]).toEqual({
        branch: "feature",
        target: null,
        error: "target-not-found",
        targetSource: "stored",
        requestedTarget: "ghost",
      });
      expect(await storage.mergeTargets.getForBranches("local", ["feature"]))
        .toEqual(new Map([["feature", "ghost"]]));
    });

    it("annotates duplicate branches positionally", async () => {
      await storage.mergeTargets.upsert("local", "feature", "release");

      const response = await postComparisons("local", [
        { branch: "feature" },
        { branch: "feature", target: "main" },
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.json().entries).toEqual([
        expect.objectContaining({
          branch: "feature",
          target: "release",
          targetSource: "stored",
          requestedTarget: "release",
        }),
        expect.objectContaining({
          branch: "feature",
          target: "main",
          targetSource: "request",
          requestedTarget: "main",
        }),
      ]);
    });

    it("sends effective stored targets to a remote and annotates its response", async () => {
      await storage.mergeTargets.upsert("remote", "feature", "release");
      proxyToRemoteAuto.mockResolvedValue({
        ok: true,
        status: 200,
        data: {
          entries: [{
            branch: "feature",
            target: "release",
            status: "merged",
            unmergedCount: 0,
            dirty: false,
          }],
        },
      });

      const response = await postComparisons("remote", [{ branch: "feature" }]);

      expect(response.statusCode).toBe(200);
      expect(proxyToRemoteAuto.mock.calls[0]?.[5]).toEqual({
        path: "/repo-a",
        comparisons: [{ branch: "feature", target: "release" }],
      });
      expect(response.json()).toMatchObject({
        repository: {
          kind: "remote",
          remoteServerId: remoteA.remote_server_id,
          label: "Remote A",
        },
        entries: [{
          branch: "feature",
          target: "release",
          targetSource: "stored",
          requestedTarget: "release",
        }],
      });
    });

    it.each([
      ["null data", null],
      ["a null entry", { entries: [null] }],
      ["a primitive entry", { entries: [42] }],
      ["an entry without a branch", {
        entries: [{ target: "main", status: "merged", unmergedCount: 0, dirty: false }],
      }],
      ["an entry with a mismatched branch", {
        entries: [{
          branch: "other",
          target: "main",
          status: "merged",
          unmergedCount: 0,
          dirty: false,
        }],
      }],
      ["an entry with an invalid target", {
        entries: [{
          branch: "feature",
          target: 42,
          status: "merged",
          unmergedCount: 0,
          dirty: false,
        }],
      }],
      ["an entry with an invalid error", {
        entries: [{ branch: "feature", target: null, error: "remote-broke" }],
      }],
      ["an entry with an invalid status", {
        entries: [{
          branch: "feature",
          target: "main",
          status: "unknown",
          unmergedCount: 0,
          dirty: false,
        }],
      }],
      ["an entry with a negative unmerged count", {
        entries: [{
          branch: "feature",
          target: "main",
          status: "merged",
          unmergedCount: -1,
          dirty: false,
        }],
      }],
      ["an entry with a fractional unmerged count", {
        entries: [{
          branch: "feature",
          target: "main",
          status: "merged",
          unmergedCount: 1.5,
          dirty: false,
        }],
      }],
      ["an entry with invalid dirty state", {
        entries: [{
          branch: "feature",
          target: "main",
          status: "merged",
          unmergedCount: 0,
          dirty: "no",
        }],
      }],
      ["an incomplete success entry", {
        entries: [{ branch: "feature", target: "main" }],
      }],
      ["an error entry mixed with success fields", {
        entries: [{
          branch: "feature",
          target: null,
          error: "target-not-found",
          status: "merged",
          unmergedCount: 0,
          dirty: false,
        }],
      }],
    ])("rejects remote response with %s", async (_case, data) => {
      proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data });

      const response = await postComparisons("remote", [{ branch: "feature" }]);

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "Remote merge-status response invalid" });
    });

    it("accepts and annotates a valid remote pair error", async () => {
      await storage.mergeTargets.upsert("remote", "feature", "ghost");
      proxyToRemoteAuto.mockResolvedValue({
        ok: true,
        status: 200,
        data: {
          entries: [{ branch: "feature", target: null, error: "target-not-found" }],
        },
      });

      const response = await postComparisons("remote", [{ branch: "feature" }]);

      expect(response.statusCode).toBe(200);
      expect(response.json().entries).toEqual([{
        branch: "feature",
        target: null,
        error: "target-not-found",
        targetSource: "stored",
        requestedTarget: "ghost",
      }]);
    });

    it("rejects a remote response whose entry count does not match the request", async () => {
      proxyToRemoteAuto.mockResolvedValue({ ok: true, status: 200, data: { entries: [] } });

      const response = await postComparisons("remote", [{ branch: "feature" }]);

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "Remote merge-status response invalid" });
    });
  });

  const putTarget = (projectId: string, payload: unknown) => app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/branches/merge-target`,
    payload,
  });

  it("stores an explicit target verbatim and emits an update event", async () => {
    const response = await putTarget("local", { branch: " dev ", target: " release " });
    const repeated = await putTarget("local", { branch: " dev ", target: " release " });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branch: " dev ", target: " release " });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({ branch: " dev ", target: " release " });
    expect(await storage.mergeTargets.getForBranches("local", [" dev "])).toEqual(
      new Map([[" dev ", " release "]]),
    );
    expect(emitted).toEqual([
      { type: "merge-target:updated", projectId: "local", branch: " dev " },
    ]);
  });

  it("deletes a target and emits only when state changed", async () => {
    await storage.mergeTargets.upsert("local", "dev", "release");

    const deleted = await putTarget("local", { branch: "dev", target: null });
    const noOp = await putTarget("local", { branch: "dev", target: null });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ branch: "dev", target: null });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.json()).toEqual({ branch: "dev", target: null });
    expect(await storage.mergeTargets.getForBranches("local", ["dev"])).toEqual(new Map());
    expect(emitted).toEqual([
      { type: "merge-target:updated", projectId: "local", branch: "dev" },
    ]);
  });

  it("returns the existing winner and emits nothing when insert-if-absent conflicts", async () => {
    await storage.mergeTargets.upsert("local", "dev", "release");

    const response = await putTarget("local", {
      branch: "dev",
      target: "main",
      ifAbsent: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branch: "dev", target: "release" });
    expect(emitted).toEqual([]);
  });

  it("inserts an absent target and emits an update event", async () => {
    const response = await putTarget("local", {
      branch: "dev",
      target: "main",
      ifAbsent: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ branch: "dev", target: "main" });
    expect(emitted).toEqual([
      { type: "merge-target:updated", projectId: "local", branch: "dev" },
    ]);
  });

  it.each([
    [{ target: "main" }],
    [{ branch: "", target: "main" }],
    [{ branch: "x".repeat(257), target: "main" }],
    [{ branch: "dev" }],
    [{ branch: "dev", target: "" }],
    [{ branch: "dev", target: "x".repeat(257) }],
    [{ branch: "dev", target: "main", ifAbsent: "yes" }],
    [{ branch: "dev", target: null, ifAbsent: true }],
  ])("rejects malformed target payload %#", async (payload) => {
    const response = await putTarget("local", payload);

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for an unknown project", async () => {
    const response = await putTarget("missing", { branch: "dev", target: "main" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Project not found" });
    expect(emitted).toEqual([]);
  });
});
