import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("@clerk/fastify", () => ({
  getAuth: () => ({ userId: auth.userId }),
  clerkClient: {},
}));

import executorRoutes from "./executor-routes.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";

/**
 * Executors are scoped by workspace, but the wire contract names a *branch* —
 * the server resolves it. These cover that resolution, since a wrong answer
 * either hides a workspace's executors or leaks another one's.
 */
describe("executor routes (workspace scoping)", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let mainWorkspaceId: string;
  let featWorkspaceId: string;

  const registerWorkspace = async (projectId: string, branch: string) => {
    const registered = await storage.workspaceRegistry.registerReadyCheckout({
      projectId, branch, targetId: "local",
      worktreePath: `/tmp/${projectId}-${branch || "main"}`, expectedBranch: branch,
    });
    return registered.workspace.id;
  };

  beforeEach(async () => {
    auth.userId = "user-1";
    dir = mkdtempSync(path.join(tmpdir(), "vdx-exec-routes-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "Mine", path: "/mine" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Theirs", path: "/theirs" }, "user-2");

    mainWorkspaceId = await registerWorkspace("project-1", "");
    featWorkspaceId = await registerWorkspace("project-1", "feat");

    await storage.executors.create({
      id: "e-main", project_id: "project-1", workspace_id: mainWorkspaceId,
      name: "dev", command: "npm run dev",
    });
    await storage.executors.create({
      id: "e-feat", project_id: "project-1", workspace_id: featWorkspaceId,
      name: "feat-dev", command: "npm run dev",
    });

    app = Fastify({ logger: false });
    app.decorate("authEnabled", true);
    app.decorate("storage", storage);
    await app.register(executorRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("GET", () => {
    it("scopes to the main workspace for the empty-string branch", async () => {
      const response = await app.inject({ method: "GET", url: "/api/projects/project-1/executors?branch=" });

      expect(response.statusCode).toBe(200);
      expect(response.json().executors.map((e: { id: string }) => e.id)).toEqual(["e-main"]);
    });

    it("scopes to a named branch's workspace", async () => {
      const response = await app.inject({ method: "GET", url: "/api/projects/project-1/executors?branch=feat" });

      expect(response.json().executors.map((e: { id: string }) => e.id)).toEqual(["e-feat"]);
    });

    it("returns every executor in the project when no branch is given", async () => {
      const response = await app.inject({ method: "GET", url: "/api/projects/project-1/executors" });

      expect(response.json().executors.map((e: { id: string }) => e.id).sort()).toEqual(["e-feat", "e-main"]);
    });

    it("returns an empty list, not an error, for a branch with no workspace", async () => {
      const response = await app.inject({ method: "GET", url: "/api/projects/project-1/executors?branch=nope" });

      expect(response.statusCode).toBe(200);
      expect(response.json().executors).toEqual([]);
    });

    it("does not serve another tenant's project", async () => {
      const response = await app.inject({ method: "GET", url: "/api/projects/project-2/executors?branch=" });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST", () => {
    it("creates the executor in the named branch's workspace", async () => {
      const response = await app.inject({
        method: "POST", url: "/api/projects/project-1/executors",
        payload: { name: "test", command: "npm test", branch: "feat" },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().executor.workspace_id).toBe(featWorkspaceId);
    });

    it("rejects a branch that has no workspace instead of conjuring one", async () => {
      const response = await app.inject({
        method: "POST", url: "/api/projects/project-1/executors",
        payload: { name: "test", command: "npm test", branch: "nope" },
      });

      expect(response.statusCode).toBe(400);
      expect(await storage.workspaceRegistry.getWorkspaceByProjectBranch("project-1", "nope")).toBeUndefined();
    });

    it("requires a branch", async () => {
      const response = await app.inject({
        method: "POST", url: "/api/projects/project-1/executors",
        payload: { name: "test", command: "npm test" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("positions independently per workspace", async () => {
      const response = await app.inject({
        method: "POST", url: "/api/projects/project-1/executors",
        payload: { name: "second", command: "echo 2", branch: "feat" },
      });

      // e-feat already holds position 0 in this workspace; e-main's position 0
      // in another one must not push this to 1's neighbour or collide.
      expect(response.json().executor.position).toBe(1);
    });
  });

  describe("reorder", () => {
    it("reorders within the resolved workspace", async () => {
      await storage.executors.create({
        id: "e-main-2", project_id: "project-1", workspace_id: mainWorkspaceId,
        name: "build", command: "npm run build",
      });

      const response = await app.inject({
        method: "PUT", url: "/api/projects/project-1/executors/reorder",
        payload: { orderedIds: ["e-main-2", "e-main"], branch: "" },
      });

      expect(response.statusCode).toBe(200);
      const ordered = await storage.executors.getByWorkspaceId(mainWorkspaceId);
      expect(ordered.map((e) => e.id)).toEqual(["e-main-2", "e-main"]);
    });

    it("rejects an executor belonging to another workspace", async () => {
      const response = await app.inject({
        method: "PUT", url: "/api/projects/project-1/executors/reorder",
        payload: { orderedIds: ["e-feat"], branch: "" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("not found in workspace");
    });

    it("rejects a branch with no workspace", async () => {
      const response = await app.inject({
        method: "PUT", url: "/api/projects/project-1/executors/reorder",
        payload: { orderedIds: [], branch: "nope" },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
